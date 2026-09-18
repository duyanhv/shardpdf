// Shared helpers for the CJS and ESM smoke tests. Plain CommonJS so both
// module systems can load it without a build step.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createWriteStream } = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const PDFDocument = require("pdfkit");

/**
 * Write a small PDF with `pages` pages, each labelled with `label` and its index.
 * @param {string} file
 * @param {number} pages
 * @param {string} label
 * @returns {Promise<void>}
 */
function writePdf(file, pages, label) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const out = createWriteStream(file);
    out.on("finish", resolve);
    out.on("error", reject);
    doc.pipe(out);
    for (let i = 0; i < pages; i++) {
      if (i > 0) doc.addPage();
      doc.fontSize(20).text(`${label} page ${i + 1} of ${pages}`);
      // A link annotation, so extract's annotation dropping has something to drop.
      doc.link(36, 100, 200, 20, "https://example.invalid/");
      doc.fontSize(12).text("link target", 36, 100);
    }
    doc.end();
  });
}

/** @returns {Promise<{dir: string, cleanup: () => Promise<void>}>} */
async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "shardpdf-consumer-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** True when a `qpdf` binary is resolvable on PATH. */
function hasQpdf() {
  try {
    execFileSync("qpdf", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `qpdf --check` on `file` when qpdf is available. Returns "checked" or
 * "skipped"; throws if qpdf reports a problem.
 * @param {string} file
 */
function qpdfCheck(file) {
  if (!hasQpdf()) {
    console.warn(`WARN qpdf not on PATH; skipping structural check of ${file}`);
    return "skipped";
  }
  execFileSync("qpdf", ["--check", file], { stdio: "pipe" });
  return "checked";
}

/**
 * The scenario every runtime/module-system combination exercises. `core` is
 * whatever the caller imported; this asserts the observable behaviour.
 * @param {string} runtime label for log lines
 * @param {{merge: Function, extract: Function, getPageCount: Function}} core
 */
async function runScenario(runtime, core) {
  const { dir, cleanup } = await tempDir();
  try {
    const a = path.join(dir, "a.pdf");
    const b = path.join(dir, "b.pdf");
    const merged = path.join(dir, "merged.pdf");
    const slice = path.join(dir, "slice.pdf");

    await writePdf(a, 3, "A");
    await writePdf(b, 2, "B");

    assert.equal(await core.getPageCount(a), 3, "getPageCount(a)");
    assert.equal(await core.getPageCount(b), 2, "getPageCount(b)");

    const progress = [];
    const result = await core.merge([a, b], merged, {
      outline: [
        {
          title: "Document A",
          pageIndex: 0,
          children: [
            { title: "A / page 2", pageIndex: 1 },
            {
              title: "A / page 3",
              pageIndex: 2,
              children: [{ title: "A / page 3 / deep", pageIndex: 2 }],
            },
          ],
        },
        { title: "Document B", pageIndex: 3 },
      ],
      onProgress: (event) => progress.push(event),
    });

    assert.equal(result.pageCount, 5, "merged page count");
    assert.ok(result.byteLength > 0, "merged byteLength");
    assert.deepEqual(
      result.inputs.map((i) => [i.pageCount, i.startPageIndex]),
      [
        [3, 0],
        [2, 3],
      ],
      "merge inputs metadata",
    );
    assert.equal(progress.length, 2, "onProgress fired per input");
    assert.equal(progress[1].pageCount, 5);
    assert.equal(await core.getPageCount(merged), 5, "getPageCount(merged)");

    const extracted = await core.extract(merged, slice, {
      pages: { start: 1, end: 4 },
      annotations: "drop",
    });
    assert.equal(extracted.pageCount, 3, "extracted page count");
    assert.ok(extracted.byteLength > 0, "extracted byteLength");
    assert.equal(await core.getPageCount(slice), 3, "getPageCount(slice)");

    // Missing/incorrect acknowledgement must be rejected at runtime too.
    await assert.rejects(
      core.extract(merged, path.join(dir, "never.pdf"), { pages: [0] }),
      TypeError,
      "extract without annotations: 'drop' must throw TypeError",
    );

    const checks = [qpdfCheck(merged), qpdfCheck(slice)];
    console.log(
      `ok ${runtime}: merge=5 pages, extract=3 pages, qpdf ${checks[0]}`,
    );
  } finally {
    await cleanup();
  }
}

module.exports = { runScenario, writePdf, qpdfCheck, hasQpdf };
