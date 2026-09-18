/**
 * End-to-end tests for the PDFKit adapter, driven through the orchestrator's
 * real `generate()` rather than a bespoke harness, so the worker boundary,
 * two-pass scheduling, determinism enforcement, and Rust assembly are all
 * genuinely exercised.
 *
 * The load-bearing test is "one image XObject per distinct image": it is the
 * regression guard for the failure measured in
 * `docs/audits/2026-09-18-render-in-rust-evaluation.md`, which `qpdf --check`
 * cannot see because the duplicated output is perfectly valid.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DocumentPlan } from "@shardpdf/orchestrator";
import { generate } from "@shardpdf/orchestrator";
import { readRasterizeLog } from "./fixtures/gauge.ts";
import type { FixtureSection } from "./fixtures/templates.ts";

const execFileP = promisify(execFile);
const ADAPTER_PATH = fileURLToPath(
  new URL("./fixtures/templates.ts", import.meta.url),
);

const workDir = await mkdtemp(path.join(tmpdir(), "shardpdf-adapter-pdfkit-"));
after(() => rm(workDir, { recursive: true, force: true }));

async function qpdfAvailable(): Promise<boolean> {
  try {
    await execFileP("qpdf", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

if (!(await qpdfAvailable())) {
  console.warn(
    "warning: qpdf not found; PDF structure assertions are skipped in this run",
  );
}

/** Isolates the cross-process rasterize log for one test. */
function useRasterizeLog(name: string): string {
  const logPath = path.join(workDir, `${name}.rasterize.log`);
  process.env.ADAPTER_TEST_RASTERIZE_LOG = logPath;
  return logPath;
}

function plan(sections: DocumentPlan<FixtureSection>["sections"]) {
  return {
    adapter: { module: ADAPTER_PATH, export: "adapter", version: "test-1" },
    sections,
  } satisfies DocumentPlan<FixtureSection>;
}

/** Counts image XObjects the way the audit did, via qpdf's QDF form. */
async function imageObjectCount(pdfPath: string): Promise<number> {
  const { stdout } = await execFileP(
    "qpdf",
    ["--qdf", "--object-streams=disable", pdfPath, "-"],
    { maxBuffer: 1 << 28 },
  );
  return (stdout.match(/\/Subtype \/Image/g) ?? []).length;
}

test("generates a multi-shard document with correct global page literals", async () => {
  useRasterizeLog("e2e");
  const outputPath = path.join(workDir, "e2e.pdf");

  const result = await generate(
    plan([
      { id: "toc", data: { kind: "toc", refs: ["a", "b"] }, pageEstimate: 1 },
      { id: "a", data: { kind: "body", pages: 3 }, pageEstimate: 3 },
      { id: "b", data: { kind: "body", pages: 4 }, pageEstimate: 4 },
    ]),
    { outputPath, maxPagesPerShard: 4, concurrency: 2 },
  );

  assert.equal(result.totalPages, 8);
  assert.ok(result.shardCount > 1, "expected the plan to span several shards");
  assert.ok((await stat(outputPath)).size > 0);

  if (await qpdfAvailable()) {
    await execFileP("qpdf", ["--check", outputPath]);
    const { stdout } = await execFileP("qpdf", ["--show-npages", outputPath]);
    assert.equal(Number(stdout.trim()), 8);
  }
});

test("measure() does not draw, so it never rasterizes an image", async () => {
  const logPath = useRasterizeLog("measure-only");
  // 40 gauge pages: a full render would rasterize; measurement must not.
  const grades = Array.from({ length: 40 }, (_, i) => i % 6);

  await generate(
    plan([{ id: "u", data: { kind: "gauges", grades }, pageEstimate: 40 }]),
    {
      outputPath: path.join(workDir, "measure-only.pdf"),
      maxPagesPerShard: 40,
    },
  );

  // One shard renders once, so rasterize runs only for the 6 distinct grades.
  // If measure() had drawn, the log would hold a second batch.
  const log = readRasterizeLog();
  assert.ok(
    log.total <= 6,
    `expected <= 6 rasterizes for 6 distinct grades, got ${log.total}`,
  );
  assert.ok(logPath.length > 0);
});

test("one image XObject per DISTINCT image, not per page", async (t) => {
  useRasterizeLog("dedupe");
  const outputPath = path.join(workDir, "dedupe.pdf");

  // 120 pages drawing from 6 distinct gauges. The pre-fix Floor behaviour
  // would embed 120+ image objects and rasterize 120 times.
  const grades = Array.from({ length: 120 }, (_, i) => i % 6);
  const result = await generate(
    plan([{ id: "u", data: { kind: "gauges", grades }, pageEstimate: 120 }]),
    { outputPath, maxPagesPerShard: 120 },
  );

  assert.equal(result.totalPages, 120);
  assert.equal(
    result.shardCount,
    1,
    "single shard keeps the count unambiguous",
  );

  const log = readRasterizeLog();
  assert.equal(
    log.total,
    6,
    `rasterize must run once per distinct grade, ran ${log.total} times`,
  );
  assert.deepEqual(log.keys, ["0", "1", "2", "3", "4", "5"]);

  if (!(await qpdfAvailable())) return t.skip("qpdf not installed");

  const images = await imageObjectCount(outputPath);
  assert.ok(
    images <= 6,
    `expected <= 6 image XObjects for 6 distinct images across 120 pages, got ${images}`,
  );

  // And the file stays small because the bytes are not repeated.
  const { size } = await stat(outputPath);
  assert.ok(
    size < 120 * 1024,
    `120 pages of 6 shared images should stay well under 120KB, got ${size}`,
  );
});

test("dedupe holds across shards, with per-shard caches", async (t) => {
  useRasterizeLog("multi-shard-dedupe");
  const outputPath = path.join(workDir, "multi-shard-dedupe.pdf");

  // The scheduler's unit is the SECTION, so a single 120-page section can
  // never split. Three 40-page sections do, which is also how a host bounds
  // its own memory (Floor windows `unit` into 60-item chunks for this reason).
  const grades = Array.from({ length: 40 }, (_, i) => i % 6);
  const result = await generate(
    plan([
      { id: "u1", data: { kind: "gauges", grades }, pageEstimate: 40 },
      { id: "u2", data: { kind: "gauges", grades }, pageEstimate: 40 },
      { id: "u3", data: { kind: "gauges", grades }, pageEstimate: 40 },
    ]),
    { outputPath, maxPagesPerShard: 40, concurrency: 1 },
  );

  assert.equal(result.totalPages, 120);
  assert.equal(result.shardCount, 3);

  // Image handles belong to one document, so each shard legitimately builds
  // its own cache: 3 shards x 6 grades = 18 rasterizes, not 120.
  const log = readRasterizeLog();
  assert.equal(
    log.total,
    18,
    `expected 3 shards x 6 grades = 18 rasterizes, got ${log.total}`,
  );

  if (!(await qpdfAvailable())) return t.skip("qpdf not installed");
  const images = await imageObjectCount(outputPath);
  assert.ok(
    images <= 18,
    `expected <= 18 image XObjects (6 per shard), got ${images}`,
  );
});

test("TOC pages carry absolute page numbers resolved from pass 1", async (t) => {
  if (!(await qpdfAvailable())) return t.skip("qpdf not installed");
  useRasterizeLog("toc");
  const outputPath = path.join(workDir, "toc.pdf");

  await generate(
    plan([
      { id: "toc", data: { kind: "toc", refs: ["a", "b"] }, pageEstimate: 1 },
      { id: "a", data: { kind: "body", pages: 3 }, pageEstimate: 3 },
      { id: "b", data: { kind: "body", pages: 2 }, pageEstimate: 2 },
    ]),
    { outputPath, maxPagesPerShard: 4 },
  );

  // Layout: toc = page 1, a = pages 2-4, b = pages 5-6. The TOC must print
  // those absolute numbers, which a single pass could not know.
  const text = await pdfText(outputPath, 1);
  assert.match(text, /a\s*\.+\s*2/, `TOC should point "a" at page 2:\n${text}`);
  assert.match(text, /b\s*\.+\s*5/, `TOC should point "b" at page 5:\n${text}`);
  assert.match(text, /Page 1 of 6/, `footer should read 1 of 6:\n${text}`);
});

test("outline entries resolve to adapter anchors", async (t) => {
  if (!(await qpdfAvailable())) return t.skip("qpdf not installed");
  useRasterizeLog("outline");
  const outputPath = path.join(workDir, "outline.pdf");

  await generate(
    plan([
      { id: "a", data: { kind: "body", pages: 3 }, pageEstimate: 3 },
      { id: "b", data: { kind: "body", pages: 2 }, pageEstimate: 2 },
    ]),
    {
      outputPath,
      maxPagesPerShard: 3,
      outline: [
        { title: "Section A", anchor: "sec:a" },
        { title: "Section B", anchor: "sec:b" },
      ],
    },
  );

  const { stdout } = await execFileP("qpdf", [
    "--json",
    "--json-key=outlines",
    outputPath,
  ]);
  assert.match(stdout, /Section A/);
  assert.match(stdout, /Section B/);
});

test("an unknown section kind fails the run with a coded error", async () => {
  useRasterizeLog("unknown-kind");
  await assert.rejects(
    generate(
      plan([
        {
          id: "x",
          // Deliberately not one of the registered template kinds.
          data: { kind: "nope" as FixtureSection["kind"] },
          pageEstimate: 1,
        },
      ]),
      { outputPath: path.join(workDir, "unknown.pdf") },
    ),
    (error: Error) => {
      // generate() wraps worker failures; the adapter's own message and code
      // survive on the cause, which is what a host would branch on.
      const cause = (error as { cause?: Error & { code?: string } }).cause;
      assert.ok(cause, `expected a cause on: ${error.message}`);
      assert.equal(cause.name, "UnknownSectionKindError");
      assert.match(cause.message, /nope/);
      return true;
    },
  );
});

/**
 * Extracts the visible text of one page, for asserting rendered literals.
 *
 * Prefers `pdftotext`. Without poppler it falls back to reading the
 * uncompressed content stream through qpdf and reassembling the string
 * arguments of the text operators, because PDFKit splits a run into kerned
 * fragments (`[(P) 40 (age 1 of 6) 0] TJ`) that no naive regex will match.
 */
async function pdfText(pdfPath: string, page: number): Promise<string> {
  try {
    const { stdout } = await execFileP("pdftotext", [
      "-f",
      String(page),
      "-l",
      String(page),
      pdfPath,
      "-",
    ]);
    return stdout;
  } catch {
    const { stdout } = await execFileP(
      "qpdf",
      ["--qdf", "--object-streams=disable", pdfPath, "-"],
      { maxBuffer: 1 << 28, encoding: "latin1" },
    );
    const marker = `%% Contents for page ${page}\n`;
    const start = stdout.indexOf(marker);
    assert.ok(start >= 0, `no content stream for page ${page}`);
    const next = stdout.indexOf("%% Contents for page", start + marker.length);
    const body = stdout.slice(start, next < 0 ? undefined : next);
    // Concatenate every parenthesized string literal, dropping the kerning
    // numbers between them, which is what a text extractor does.
    return (body.match(/\((?:\\.|[^\\()])*\)/g) ?? [])
      .map((s) => s.slice(1, -1).replace(/\\([()\\])/g, "$1"))
      .join("");
  }
}
