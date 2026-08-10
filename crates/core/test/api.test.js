const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
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
const {
  Assembly,
  ShardPdfError,
  assemble,
  extract,
  extractPages,
  pageCount,
  validate,
} = require("..");

const execFileP = promisify(execFile);
const seedPath = path.join(
  __dirname,
  "..",
  "fuzz",
  "corpus",
  "append_shard",
  "seed-shard.pdf",
);
/** @type {string} */
let workDir = "";
/** @type {string} */
let plainShardPath = "";

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "shardpdf-core-api-"));
  plainShardPath = path.join(workDir, "plain-shard.pdf");
  await writePlainPdf(plainShardPath);
});
after(() => rm(workDir, { recursive: true, force: true }));

test("exposes native and high-level APIs to ESM consumers", async () => {
  const core = await import("../index.js");
  assert.equal(core.Assembly, Assembly);
  assert.equal(core.assemble, assemble);
});

test("assemble promotes a valid multi-shard PDF", async () => {
  const outputPath = path.join(workDir, "assembled.pdf");
  const result = await assemble({
    shards: [seedPath, plainShardPath],
    outputPath,
    outline: [{ title: "Start", pageIndex: 0 }],
  });

  assert.deepEqual(result, { pageCount: 3 });
  assert.ok((await stat(outputPath)).size > 0);
  if (await qpdfAvailable()) {
    const { stdout } = await execFileP("qpdf", ["--show-npages", outputPath]);
    assert.equal(Number(stdout.trim()), 3);
    await execFileP("qpdf", ["--check", outputPath]);
  }
  assert.deepEqual(await partialsFor(outputPath), []);
});

test("assemble cleans partial output after a shard error", async () => {
  const outputPath = path.join(workDir, "invalid.pdf");
  const invalidPath = path.join(workDir, "invalid-shard.pdf");
  await writeFile(invalidPath, "not a PDF");

  await assert.rejects(
    assemble({ shards: [seedPath, invalidPath], outputPath }),
    (error) =>
      error instanceof ShardPdfError &&
      error.code === "PDF_PARSE" &&
      !error.message.startsWith("["),
  );
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
  assert.deepEqual(await partialsFor(outputPath), []);
});

test("errors carry stable codes, not just message prose", async () => {
  const outputPath = path.join(workDir, "codes.pdf");
  await assert.rejects(
    assemble({ shards: [seedPath, seedPath], outputPath }),
    (error) =>
      error instanceof ShardPdfError && error.code === "DUPLICATE_DESTINATION",
  );

  const assembly = new Assembly(path.join(workDir, "codes-low.partial"));
  assembly.abort();
  assert.throws(
    () => assembly.appendShard(seedPath),
    (error) =>
      error instanceof ShardPdfError && error.code === "ALREADY_FINALIZED",
  );
  await rm(path.join(workDir, "codes-low.partial"));
});

test("assemble observes cancellation between shard appends", async () => {
  const outputPath = path.join(workDir, "cancelled.pdf");
  const controller = new AbortController();
  setImmediate(() => controller.abort());

  await assert.rejects(
    assemble({
      shards: [plainShardPath, plainShardPath, plainShardPath, plainShardPath],
      outputPath,
      signal: controller.signal,
    }),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
  assert.deepEqual(await partialsFor(outputPath), []);
});

test("a failed assembly never replaces an existing final file", async () => {
  const outputPath = path.join(workDir, "existing.pdf");
  const invalidPath = path.join(workDir, "another-invalid-shard.pdf");
  await writeFile(outputPath, "existing output");
  await writeFile(invalidPath, "not a PDF");

  await assert.rejects(assemble({ shards: [invalidPath], outputPath }));
  assert.equal(await readFile(outputPath, "utf8"), "existing output");
  assert.deepEqual(await partialsFor(outputPath), []);
});

test("extractPages slices a range out of an assembled document", async () => {
  const sourcePath = path.join(workDir, "extract-source.pdf");
  await assemble({
    shards: [seedPath, plainShardPath, plainShardPath, plainShardPath],
    outputPath: sourcePath,
  }); // 5 pages: seed(2) + plain(1) x 3 — plain shards carry no named dests

  const outputPath = path.join(workDir, "extract-slice.pdf");
  const count = extractPages(sourcePath, 2, 4, outputPath);
  assert.equal(count, 3);
  assert.ok((await stat(outputPath)).size > 0);
  if (await qpdfAvailable()) {
    const { stdout } = await execFileP("qpdf", ["--show-npages", outputPath]);
    assert.equal(Number(stdout.trim()), 3);
    await execFileP("qpdf", ["--check", outputPath]);
  }
});

test("extractPages rejects out-of-range and inverted ranges with INVALID_RANGE", async () => {
  const sourcePath = path.join(workDir, "extract-bad-source.pdf");
  await assemble({ shards: [seedPath], outputPath: sourcePath }); // 2 pages

  const outputPath = path.join(workDir, "extract-bad.pdf");
  for (const [start, end] of [
    [0, 1],
    [2, 1],
    [1, 3],
  ]) {
    assert.throws(
      () => extractPages(sourcePath, start, end, outputPath),
      (error) =>
        error instanceof ShardPdfError && error.code === "INVALID_RANGE",
      `range ${start}-${end} must be rejected`,
    );
  }
});

test("extract slices many ranges from one parse and cleans up on failure", async () => {
  const sourcePath = path.join(workDir, "extract-multi-source.pdf");
  await assemble({
    shards: [seedPath, plainShardPath, plainShardPath],
    outputPath: sourcePath,
  }); // 4 pages

  const result = await extract({
    input: sourcePath,
    ranges: [
      { startPage: 1, endPage: 2, output: path.join(workDir, "multi-a.pdf") },
      { startPage: 2, endPage: 4, output: path.join(workDir, "multi-b.pdf") },
    ],
  });
  assert.equal(result.sourcePageCount, 4);
  assert.deepEqual(
    result.ranges.map((r) => r.pageCount),
    [2, 3],
  );
  assert.equal(pageCount(path.join(workDir, "multi-a.pdf")), 2);
  assert.equal(pageCount(path.join(workDir, "multi-b.pdf")), 3);

  // Second range invalid → the already-written first slice must be removed.
  const goodSlice = path.join(workDir, "multi-cleanup.pdf");
  await assert.rejects(
    extract({
      input: sourcePath,
      ranges: [
        { startPage: 1, endPage: 1, output: goodSlice },
        {
          startPage: 3,
          endPage: 99,
          output: path.join(workDir, "multi-x.pdf"),
        },
      ],
    }),
    (error) => error instanceof ShardPdfError && error.code === "INVALID_RANGE",
  );
  await assert.rejects(stat(goodSlice), { code: "ENOENT" });
});

test("pageCount and validate work without qpdf", async () => {
  const sourcePath = path.join(workDir, "inspect-source.pdf");
  await assemble({
    shards: [seedPath, plainShardPath],
    outputPath: sourcePath,
  });

  assert.equal(pageCount(sourcePath), 3);
  const report = validate(sourcePath);
  assert.equal(report.pageCount, 3);
  assert.equal(report.namedDestinations, 2); // seed shard's two dests

  const notPdf = path.join(workDir, "not-a.pdf");
  await writeFile(notPdf, "nope");
  assert.throws(
    () => validate(notPdf),
    (error) => error instanceof ShardPdfError && error.code === "PDF_PARSE",
  );
});

test("low-level abort consumes the assembly and closes its writer", async () => {
  const partialPath = path.join(workDir, "low-level.partial");
  const assembly = new Assembly(partialPath);
  assembly.abort();
  assert.throws(() => assembly.appendShard(seedPath), /already finalized/);
  await rm(partialPath);
});

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

/** @param {string} outputPath */
async function writePlainPdf(outputPath) {
  const stream = "BT /F1 12 Tf 72 720 Td (ShardPDF) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.7\n%\xB5\xB5\xB5\xB5\n";
  /** @type {number[]} */
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  await writeFile(outputPath, Buffer.from(pdf, "latin1"));
}
