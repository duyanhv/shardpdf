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
const { Assembly, assemble, extractPages } = require("..");

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
  if (!(await qpdfAvailable())) {
    console.warn(
      "warning: qpdf not found; PDF validity checks are skipped in this run",
    );
  }
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
    { code: "SHARDPDF_PDF_PARSE" },
  );
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
  assert.deepEqual(await partialsFor(outputPath), []);
});

test("assemble reports each shard through onShard and aborts if it throws", async () => {
  const outputPath = path.join(workDir, "onshard.pdf");
  /** @type {{index: number, pageCount: number, totalPages: number}[]} */
  const seen = [];
  const result = await assemble({
    shards: [seedPath, plainShardPath],
    outputPath,
    onShard: ({ index, pageCount, totalPages }) =>
      seen.push({ index, pageCount, totalPages }),
  });
  assert.deepEqual(result, { pageCount: 3 });
  assert.deepEqual(seen, [
    { index: 0, pageCount: 2, totalPages: 2 },
    { index: 1, pageCount: 1, totalPages: 3 },
  ]);

  const rejectedPath = path.join(workDir, "onshard-rejected.pdf");
  await assert.rejects(
    assemble({
      shards: [seedPath, plainShardPath],
      outputPath: rejectedPath,
      onShard: ({ index }) => {
        if (index === 1) throw new Error("count mismatch");
      },
    }),
    /count mismatch/,
  );
  await assert.rejects(stat(rejectedPath), { code: "ENOENT" });
  assert.deepEqual(await partialsFor(rejectedPath), []);
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

test("extractPages rejects out-of-range and inverted ranges", async () => {
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
      { code: "SHARDPDF_MALFORMED" },
      `range ${start}-${end} must be rejected`,
    );
  }
  for (const [start, end] of [
    [-1, 1],
    [1.5, 2],
    [Number.NaN, 1],
    ["1", 2],
  ]) {
    assert.throws(
      () => extractPages(sourcePath, asAny(start), asAny(end), outputPath),
      { code: "SHARDPDF_INVALID_ARG" },
      `range ${start}-${end} must be rejected before reaching the core`,
    );
  }
});

test("every wrong-typed argument reports SHARDPDF_INVALID_ARG, not a napi status", () => {
  const bad = [42, null, undefined, {}, ""].map(asAny);
  for (const value of bad) {
    assert.throws(
      () => extractPages(value, 1, 1, "/tmp/never.pdf"),
      { code: "SHARDPDF_INVALID_ARG" },
      `inputPath=${String(value)}`,
    );
    assert.throws(() => new Assembly(value), { code: "SHARDPDF_INVALID_ARG" });
  }
  const assembly = new Assembly(path.join(workDir, "typed.partial"));
  try {
    for (const value of bad) {
      assert.throws(
        () => assembly.appendShard(value),
        { code: "SHARDPDF_INVALID_ARG" },
        `shardPath=${String(value)}`,
      );
    }
  } finally {
    assembly.abort();
  }
});

test("a missing input file is SHARDPDF_IO, a corrupt one is SHARDPDF_PDF_PARSE", async () => {
  const corrupt = path.join(workDir, "corrupt.pdf");
  await writeFile(corrupt, "not a PDF");
  assert.throws(
    () =>
      extractPages(
        path.join(workDir, "does-not-exist.pdf"),
        1,
        1,
        "/tmp/never.pdf",
      ),
    { code: "SHARDPDF_IO" },
  );
  assert.throws(() => extractPages(corrupt, 1, 1, "/tmp/never.pdf"), {
    code: "SHARDPDF_PDF_PARSE",
  });
});

test("finalize validates the outline shape and reports SHARDPDF_INVALID_ARG", () => {
  /** @type {[string, unknown][]} */
  const cases = [
    ["not an array", "x"],
    ["plain object", {}],
    ["entry not object", [1]],
    ["entry null", [null]],
    ["title missing", [{ pageIndex: 0 }]],
    ["title number", [{ title: 1, pageIndex: 0 }]],
    ["pageIndex missing", [{ title: "a" }]],
    ["pageIndex fractional", [{ title: "a", pageIndex: 0.5 }]],
    ["pageIndex negative", [{ title: "a", pageIndex: -1 }]],
    ["pageIndex string", [{ title: "a", pageIndex: "0" }]],
    ["pageIndex NaN", [{ title: "a", pageIndex: Number.NaN }]],
    ["level fractional", [{ title: "a", pageIndex: 0, level: 0.5 }]],
    ["level negative", [{ title: "a", pageIndex: 0, level: -1 }]],
    ["level string", [{ title: "a", pageIndex: 0, level: "0" }]],
  ];
  for (const [label, outline] of cases) {
    const assembly = new Assembly(path.join(workDir, "outline-shape.partial"));
    try {
      assembly.appendShard(seedPath);
      assert.throws(
        () => assembly.finalize(asAny(outline)),
        { code: "SHARDPDF_INVALID_ARG" },
        label,
      );
      // A rejected outline must not consume the assembly.
      assert.equal(assembly.consumed, false, `${label}: still usable`);
    } finally {
      assembly.abort();
    }
  }
  // Structural problems remain MALFORMED (the shape was fine).
  /** @type {[string, unknown][]} */
  const structural = [
    ["page out of range", [{ title: "a", pageIndex: 99 }]],
    ["level jump", [{ title: "a", pageIndex: 0, level: 2 }]],
  ];
  for (const [label, outline] of structural) {
    const assembly = new Assembly(path.join(workDir, "outline-struct.partial"));
    assembly.appendShard(seedPath);
    assert.throws(
      () => assembly.finalize(asAny(outline)),
      { code: "SHARDPDF_MALFORMED" },
      label,
    );
  }
  // level is optional at the native layer as well as in assemble().
  const ok = new Assembly(path.join(workDir, "outline-ok.pdf"));
  ok.appendShard(seedPath);
  ok.finalize([
    { title: "a", pageIndex: 0 },
    { title: "b", pageIndex: 1, level: 1 },
  ]);
  assert.equal(ok.consumed, true);
});

test("low-level abort is idempotent and consumes the assembly", async () => {
  const partialPath = path.join(workDir, "low-level.partial");
  const assembly = new Assembly(partialPath);
  assert.equal(assembly.consumed, false);
  assembly.abort();
  assembly.abort(); // second call is a no-op, not an error
  assert.equal(assembly.consumed, true);
  assert.throws(() => assembly.appendShard(seedPath), {
    code: "SHARDPDF_CONSUMED",
  });
  assert.throws(() => assembly.pageCount, { code: "SHARDPDF_CONSUMED" });
  await rm(partialPath);
});

/**
 * Deliberately wrong-typed values for negative tests; the .d.ts says string
 * and number, and that is what we are checking the native layer enforces.
 * @param {unknown} value
 * @returns {any}
 */
function asAny(value) {
  return value;
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
