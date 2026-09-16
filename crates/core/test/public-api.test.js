const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createWriteStream } = require("node:fs");
const {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");
const PDFDocument = require("pdfkit");
const { extract, getPageCount, merge } = require("..");

const execFileP = promisify(execFile);

/** @type {string} */
let workDir = "";
/** @type {string[]} */
let chunkPaths = [];
const CHUNK_PAGES = [3, 2, 4];

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "shardpdf-public-api-"));
  chunkPaths = await Promise.all(
    CHUNK_PAGES.map((pages, index) =>
      writePdfkitPdf(path.join(workDir, `chunk-${index}.pdf`), pages, index),
    ),
  );
});
after(() => rm(workDir, { recursive: true, force: true }));

test("exposes merge, extract, and getPageCount to ESM consumers", async () => {
  const core = await import("../index.js");
  assert.equal(core.merge, merge);
  assert.equal(core.extract, extract);
  assert.equal(core.getPageCount, getPageCount);
});

test("merge accepts path, file URL, and byte inputs and writes a nested outline", async () => {
  const outputPath = path.join(workDir, "merged.pdf");
  const inputs = [
    chunkPaths[0],
    pathToFileURL(chunkPaths[1]),
    await readFile(chunkPaths[2]),
  ];
  const result = await merge(inputs, pathToFileURL(outputPath), {
    outline: [
      {
        title: "1장 개요",
        pageIndex: 0,
        children: [
          { title: "Block A", pageIndex: 1 },
          {
            title: "Block B",
            pageIndex: 3,
            children: [{ title: "Unit B-1", pageIndex: 4 }],
          },
        ],
      },
      { title: "Appendix", pageIndex: 5 },
    ],
  });

  assert.equal(result.pageCount, 9);
  assert.equal(result.byteLength, (await stat(outputPath)).size);
  assert.ok(result.byteLength > 0);
  assert.deepEqual(result.inputs, [
    { pageCount: 3, startPageIndex: 0 },
    { pageCount: 2, startPageIndex: 3 },
    { pageCount: 4, startPageIndex: 5 },
  ]);
  assert.deepEqual(await partialsFor(outputPath), []);

  if (await qpdfAvailable()) {
    await execFileP("qpdf", ["--check", outputPath]);
    const { stdout } = await execFileP("qpdf", ["--show-npages", outputPath]);
    assert.equal(Number(stdout.trim()), 9);
    const json = JSON.parse(
      (await execFileP("qpdf", ["--json", "--json-key=outlines", outputPath]))
        .stdout,
    );
    assert.deepEqual(outlineShape(json.outlines), [
      {
        title: "1장 개요",
        children: [
          { title: "Block A", children: [] },
          { title: "Block B", children: [{ title: "Unit B-1", children: [] }] },
        ],
      },
      { title: "Appendix", children: [] },
    ]);
  }
});

test("merge reports progress after each input", async () => {
  const outputPath = path.join(workDir, "merged-progress.pdf");
  /** @type {import("..").PDFProgress[]} */
  const events = [];
  await merge(chunkPaths, outputPath, {
    onProgress: (event) => events.push(event),
  });
  assert.deepEqual(events, [
    { operation: "merge", completed: 1, total: 3, pageCount: 3 },
    { operation: "merge", completed: 2, total: 3, pageCount: 5 },
    { operation: "merge", completed: 3, total: 3, pageCount: 9 },
  ]);
});

test("a throwing onProgress rejects merge and leaves the existing output untouched", async () => {
  const outputPath = path.join(workDir, "merged-existing.pdf");
  await writeFile(outputPath, "existing output");
  await assert.rejects(
    merge(chunkPaths, outputPath, {
      onProgress: ({ completed }) => {
        if (completed === 2) throw new Error("sidecar mismatch");
      },
    }),
    /sidecar mismatch/,
  );
  assert.equal(await readFile(outputPath, "utf8"), "existing output");
  assert.deepEqual(await partialsFor(outputPath), []);
});

test("merge aborted before publication preserves the prior output", async () => {
  const outputPath = path.join(workDir, "merged-aborted.pdf");
  await writeFile(outputPath, "prior output");
  const controller = new AbortController();
  await assert.rejects(
    merge(chunkPaths, outputPath, {
      signal: controller.signal,
      onProgress: ({ completed, total }) => {
        // Abort after the last input so the only remaining checkpoint is the
        // pre-publication one.
        if (completed === total) controller.abort();
      },
    }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(await readFile(outputPath, "utf8"), "prior output");
  assert.deepEqual(await partialsFor(outputPath), []);

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    merge(chunkPaths, outputPath, { signal: preAborted.signal }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(await readFile(outputPath, "utf8"), "prior output");
});

test("merge rejects non-file URLs and bad argument shapes", async () => {
  const outputPath = path.join(workDir, "never.pdf");
  await assert.rejects(
    merge([new URL("https://example.com/a.pdf")], outputPath),
    { name: "TypeError", message: /file: URL/ },
  );
  await assert.rejects(merge(chunkPaths, new URL("data:,x")), {
    name: "TypeError",
  });
  await assert.rejects(merge([], outputPath), { name: "RangeError" });
  await assert.rejects(merge([asAny(42)], outputPath), { name: "TypeError" });
  await assert.rejects(
    merge(chunkPaths, outputPath, { outline: [{ title: "x", pageIndex: -1 }] }),
    { name: "RangeError" },
  );
  await assert.rejects(
    merge(chunkPaths, outputPath, {
      outline: [asAny({ title: "x", pageIndex: 0, children: "nope" })],
    }),
    { name: "TypeError" },
  );
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
});

test("merge surfaces native codes for corrupt input", async () => {
  const corrupt = path.join(workDir, "corrupt.pdf");
  await writeFile(corrupt, "not a PDF");
  const outputPath = path.join(workDir, "merged-corrupt.pdf");
  await assert.rejects(merge([chunkPaths[0], corrupt], outputPath), {
    code: "SHARDPDF_PDF_PARSE",
  });
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
  assert.deepEqual(await partialsFor(outputPath), []);
});

test("getPageCount works on a path, a file URL, and bytes", async () => {
  assert.equal(await getPageCount(chunkPaths[2]), 4);
  assert.equal(await getPageCount(pathToFileURL(chunkPaths[0])), 3);
  assert.equal(await getPageCount(await readFile(chunkPaths[1])), 2);
  assert.equal(
    await getPageCount(new Uint8Array(await readFile(chunkPaths[1]))),
    2,
  );
  await assert.rejects(getPageCount(new URL("https://example.com/a.pdf")), {
    name: "TypeError",
  });
  await assert.rejects(getPageCount(new Uint8Array(0)), { name: "RangeError" });
  await assert.rejects(getPageCount(path.join(workDir, "missing.pdf")), {
    code: "SHARDPDF_IO",
  });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    getPageCount(chunkPaths[0], { signal: aborted.signal }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
});

test("extract selects first, last, single, range, and reversed non-contiguous pages", async () => {
  const sourcePath = path.join(workDir, "extract-source.pdf");
  await merge(chunkPaths, sourcePath); // 9 pages, page i is labelled "page i"

  /** @type {[string, import("..").PDFPageSelection, number[]][]} */
  const cases = [
    ["first", [0], [0]],
    ["last", [8], [8]],
    ["single range", { start: 4, end: 5 }, [4]],
    ["range", { start: 2, end: 6 }, [2, 3, 4, 5]],
    ["full range", { start: 0, end: 9 }, [0, 1, 2, 3, 4, 5, 6, 7, 8]],
    ["reversed non-contiguous", [7, 2, 5, 0], [7, 2, 5, 0]],
  ];
  for (const [label, pages, expected] of cases) {
    const outputPath = path.join(
      workDir,
      `extract-${label.replace(/\s+/g, "-")}.pdf`,
    );
    /** @type {import("..").PDFProgress[]} */
    const events = [];
    const result = await extract(sourcePath, outputPath, {
      pages,
      annotations: "drop",
      onProgress: (event) => events.push(event),
    });
    assert.equal(result.pageCount, expected.length, label);
    assert.equal(result.byteLength, (await stat(outputPath)).size, label);
    assert.deepEqual(
      events,
      [
        {
          operation: "extract",
          completed: expected.length,
          total: expected.length,
          pageCount: expected.length,
        },
      ],
      label,
    );
    assert.deepEqual(await partialsFor(outputPath), [], label);
    if (await qpdfAvailable()) {
      await execFileP("qpdf", ["--check", outputPath]);
      const { stdout } = await execFileP("qpdf", ["--show-npages", outputPath]);
      assert.equal(Number(stdout.trim()), expected.length, label);
      assert.deepEqual(await pageLabels(outputPath), expected, label);
    }
  }

  // Byte input and file URL output.
  const bytesOut = path.join(workDir, "extract-bytes.pdf");
  const fromBytes = await extract(
    await readFile(sourcePath),
    pathToFileURL(bytesOut),
    { pages: { start: 1, end: 3 }, annotations: "drop" },
  );
  assert.equal(fromBytes.pageCount, 2);
  if (await qpdfAvailable()) {
    assert.deepEqual(await pageLabels(bytesOut), [1, 2]);
  }
});

test("extract rejects duplicates, empty, out-of-range, and non-integer selections", async () => {
  const sourcePath = chunkPaths[0]; // 3 pages
  const outputPath = path.join(workDir, "extract-invalid.pdf");
  await writeFile(outputPath, "prior output");
  /** @type {[string, unknown, string][]} */
  const cases = [
    ["duplicate", [0, 1, 0], "RangeError"],
    ["empty", [], "RangeError"],
    ["negative", [-1], "RangeError"],
    ["past end", [3], "RangeError"],
    ["fractional", [0.5], "TypeError"],
    ["NaN", [Number.NaN], "TypeError"],
    ["Infinity", [Number.POSITIVE_INFINITY], "TypeError"],
    ["string index", ["0"], "TypeError"],
    ["range start == end", { start: 1, end: 1 }, "RangeError"],
    ["range inverted", { start: 2, end: 1 }, "RangeError"],
    ["range past end", { start: 0, end: 4 }, "RangeError"],
    ["range negative", { start: -1, end: 1 }, "RangeError"],
    ["range fractional", { start: 0, end: 1.5 }, "TypeError"],
    ["range missing end", { start: 0 }, "TypeError"],
    ["not a selection", "0-2", "TypeError"],
    ["missing", undefined, "TypeError"],
  ];
  for (const [label, pages, name] of cases) {
    await assert.rejects(
      extract(sourcePath, outputPath, asAny({ pages, annotations: "drop" })),
      { name },
      label,
    );
  }
  assert.equal(await readFile(outputPath, "utf8"), "prior output");
  assert.deepEqual(await partialsFor(outputPath), []);
});

test('extract requires the annotations: "drop" acknowledgement', async () => {
  const outputPath = path.join(workDir, "extract-ack.pdf");
  for (const options of [
    { pages: [0] },
    { pages: [0], annotations: "keep" },
    { pages: [0], annotations: undefined },
    undefined,
    null,
  ]) {
    await assert.rejects(
      extract(chunkPaths[0], outputPath, asAny(options)),
      { name: "TypeError", message: /annotations/ },
      JSON.stringify(options),
    );
  }
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
});

test("extract observes cancellation and preserves prior output", async () => {
  const outputPath = path.join(workDir, "extract-aborted.pdf");
  await writeFile(outputPath, "prior output");
  const controller = new AbortController();
  await assert.rejects(
    extract(chunkPaths[0], outputPath, {
      pages: [0],
      annotations: "drop",
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(await readFile(outputPath, "utf8"), "prior output");
  assert.deepEqual(await partialsFor(outputPath), []);
});

/**
 * Deliberately wrong-typed values for negative tests.
 * @param {unknown} value
 * @returns {any}
 */
function asAny(value) {
  return value;
}

/**
 * Write a PDFKit document whose pages each carry the text `page N`, where N
 * is the global page index across the chunk sequence (so selections can be
 * verified by content after extraction).
 * @param {string} outputPath
 * @param {number} pages
 * @param {number} chunkIndex
 */
async function writePdfkitPdf(outputPath, pages, chunkIndex) {
  const offset = CHUNK_PAGES.slice(0, chunkIndex).reduce((a, b) => a + b, 0);
  const doc = new PDFDocument({ autoFirstPage: false });
  const stream = createWriteStream(outputPath);
  const done = new Promise((resolve, reject) => {
    stream.on("finish", () => resolve(undefined));
    stream.on("error", reject);
  });
  doc.pipe(stream);
  for (let i = 0; i < pages; i++) {
    doc.addPage({ size: "A4" });
    doc.fontSize(24).text(`page ${offset + i}`, 72, 72);
  }
  doc.end();
  await done;
  return outputPath;
}

/**
 * Global page labels ("page N") found in each page's content stream, in
 * output order, via qpdf's page JSON and filtered stream dumps.
 * @param {string} pdfPath
 * @returns {Promise<number[]>}
 */
async function pageLabels(pdfPath) {
  const { stdout } = await execFileP("qpdf", [
    "--json",
    "--json-key=pages",
    pdfPath,
  ]);
  /** @type {{contents: string[]}[]} */
  const pages = JSON.parse(stdout).pages;
  /** @type {number[]} */
  const labels = [];
  for (const page of pages) {
    let text = "";
    for (const ref of page.contents) {
      const { stdout: content } = await execFileP(
        "qpdf",
        [
          `--show-object=${ref.split(" ")[0]}`,
          "--filtered-stream-data",
          pdfPath,
        ],
        { encoding: "latin1", maxBuffer: 1 << 24 },
      );
      // PDFKit emits text as hex glyph strings; the standard Helvetica font
      // keeps single-byte WinAnsi codes, so the hex decodes to the label.
      for (const [, hex] of content.matchAll(/<([0-9a-fA-F]+)>/g)) {
        text += Buffer.from(hex, "hex").toString("latin1");
      }
    }
    const num = /page (\d+)/.exec(text);
    assert.ok(num, `page ${labels.length + 1} of ${pdfPath} text: ${text}`);
    labels.push(Number(num[1]));
  }
  return labels;
}

/**
 * qpdf outline JSON to nested {title, children}.
 * @param {any[]} outlines
 * @returns {{title: string, children: any[]}[]}
 */
function outlineShape(outlines) {
  return outlines.map((entry) => ({
    title: entry.title,
    children: outlineShape(entry.kids ?? []),
  }));
}

/** @param {string} outputPath */
async function partialsFor(outputPath) {
  const prefix = `${path.basename(outputPath)}.partial-`;
  return (await readdir(path.dirname(outputPath))).filter((entry) =>
    entry.startsWith(prefix),
  );
}

async function qpdfAvailable() {
  try {
    await execFileP("qpdf", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
