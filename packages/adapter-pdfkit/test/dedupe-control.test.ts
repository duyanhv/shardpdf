/**
 * Negative control for the dedupe guard.
 *
 * A regression test is only worth its runtime if it fails when the bug is
 * present. This reproduces Floor Inspector's exact pre-fix pattern — rasterize
 * per page and hand PDFKit a `Buffer` — and asserts that the output really
 * does explode to one image XObject per page.
 *
 * If this test ever starts reporting a small XObject count, then PDFKit began
 * deduplicating Buffers and the guard in adapter.test.ts has gone vacuous.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { ImageCache } from "../src/image-cache.ts";
import type { PdfDocument } from "../src/types.ts";
import { rasterizeGauge } from "./fixtures/gauge.ts";

const execFileP = promisify(execFile);
const requirePdfkit = createRequire(import.meta.url);
const PDFDocument = requirePdfkit("pdfkit") as new (
  options?: unknown,
) => PdfDocument & {
  image(src: unknown, x?: number, y?: number, options?: unknown): unknown;
};

const workDir = await mkdtemp(path.join(tmpdir(), "shardpdf-dedupe-control-"));
after(() => rm(workDir, { recursive: true, force: true }));

const PAGES = 60;

async function qpdfAvailable(): Promise<boolean> {
  try {
    await execFileP("qpdf", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function imageObjectCount(pdfPath: string): Promise<number> {
  const { stdout } = await execFileP(
    "qpdf",
    ["--qdf", "--object-streams=disable", pdfPath, "-"],
    { maxBuffer: 1 << 28 },
  );
  return (stdout.match(/\/Subtype \/Image/g) ?? []).length;
}

/** Renders PAGES pages, sourcing each page's image through `supply`. */
async function render(
  name: string,
  supply: (doc: ReturnType<typeof makeDoc>, grade: number) => unknown,
): Promise<string> {
  const outPath = path.join(workDir, `${name}.pdf`);
  const doc = makeDoc();
  const out = createWriteStream(outPath);
  const closed = finished(out);
  doc.pipe(out);
  for (let p = 0; p < PAGES; p++) {
    if (p > 0) doc.addPage();
    doc.image(supply(doc, p % 6), 40, 80, { width: 120 });
  }
  doc.end();
  await closed;
  return outPath;
}

function makeDoc() {
  return new PDFDocument({ size: "A4", bufferPages: false });
}

test("the naive per-page Buffer pattern duplicates one XObject per page", async (t) => {
  if (!(await qpdfAvailable())) return t.skip("qpdf not installed");

  // Exactly Floor's pre-fix shape: a fresh Buffer every page.
  const naivePath = await render("naive", (_doc, grade) =>
    rasterizeGauge(grade),
  );
  const naiveImages = await imageObjectCount(naivePath);

  assert.ok(
    naiveImages >= PAGES,
    `the control must reproduce the bug: expected >= ${PAGES} image objects, ` +
      `got ${naiveImages}. If this dropped, PDFKit changed and the dedupe ` +
      "guard needs re-derivation.",
  );

  // The adapter's cache, same pages, same pictures.
  let cache: ImageCache | undefined;
  const cachedPath = await render("cached", (doc, grade) => {
    cache ??= new ImageCache(doc);
    return cache.get(`gauge:${grade}`, () => rasterizeGauge(grade));
  });
  const cachedImages = await imageObjectCount(cachedPath);

  assert.ok(
    cachedImages <= 6,
    `expected <= 6 image objects with the cache, got ${cachedImages}`,
  );
  assert.equal(cache?.stats().distinct, 6);

  // The difference shows up in file size too, though only mildly here: the
  // fixture PNG is an 8x8 solid colour, so per-page content dominates. With
  // Floor's real ~11 KB gauges the same 400-page comparison was 6.83 MB vs
  // 0.28 MB (24.6x). Direction is what this asserts; the XObject counts above
  // are the precise signal.
  const naiveSize = (await stat(naivePath)).size;
  const cachedSize = (await stat(cachedPath)).size;
  assert.ok(
    cachedSize < naiveSize,
    `cached output should be smaller: ${cachedSize} vs ${naiveSize}`,
  );
});
