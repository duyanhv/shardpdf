/**
 * Shared resolution for the probe suite. The probes measure pdfkit and
 * node-canvas *as Floor Inspector uses them*, so they need Floor's real
 * NotoSansKR OTFs and cover assets, plus a node_modules that has pdfkit and
 * canvas installed. Neither is vendored here: the assets are Floor's and the
 * point of the measurement is the host application's own dependency versions.
 *
 * Point FLOOR_ROOT at a floor-inspector-backend checkout:
 *
 *   FLOOR_ROOT=~/works/floor-inspector-backend node --expose-gc probe.mjs pages 800
 *
 * Any application with pdfkit + canvas and a CJK OTF pair works; set
 * PROBE_FONT_DIR / PROBE_COVER_DIR to override the asset locations.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

function fail(message) {
  console.error(`probe setup: ${message}`);
  process.exit(2);
}

const FLOOR_ROOT = process.env.FLOOR_ROOT
  ? path.resolve(process.env.FLOOR_ROOT.replace(/^~/, os.homedir()))
  : undefined;

if (!FLOOR_ROOT) {
  fail(
    "set FLOOR_ROOT to a floor-inspector-backend checkout (it supplies pdfkit, " +
      "canvas, and the NotoSansKR assets these probes measure)",
  );
}
if (!existsSync(FLOOR_ROOT)) fail(`FLOOR_ROOT does not exist: ${FLOOR_ROOT}`);

const REPORT_GEN = path.join(
  FLOOR_ROOT,
  "apps/backend/src/domains/reporting/reports/infrastructure/jobs/report-generation",
);

export const FONT_DIR = process.env.PROBE_FONT_DIR
  ? path.resolve(process.env.PROBE_FONT_DIR)
  : path.join(REPORT_GEN, "assets/fonts");
export const COVER_DIR = process.env.PROBE_COVER_DIR
  ? path.resolve(process.env.PROBE_COVER_DIR)
  : path.join(REPORT_GEN, "assets/cover");

export const REGULAR_FONT = path.join(FONT_DIR, "NotoSansKR-Regular.otf");
export const BOLD_FONT = path.join(FONT_DIR, "NotoSansKR-Bold.otf");
export const COVER_JPEG = path.join(COVER_DIR, "analysis-report-cover.jpg");
export const BANNER_PNG = path.join(COVER_DIR, "vectorBanner.png");

for (const [label, p] of [
  ["regular font", REGULAR_FONT],
  ["bold font", BOLD_FONT],
]) {
  if (!existsSync(p)) fail(`${label} not found at ${p}`);
}

/** Loads pdfkit/canvas from the host application, not from shardpdf. */
const hostRequire = createRequire(path.join(FLOOR_ROOT, "package.json"));
export function requireHost(id) {
  try {
    return hostRequire(id);
  } catch (error) {
    fail(`cannot load "${id}" from ${FLOOR_ROOT}: ${error.message}`);
  }
}

export const OUT_DIR = process.env.PROBE_OUT_DIR
  ? path.resolve(process.env.PROBE_OUT_DIR)
  : path.join(os.tmpdir(), "shardpdf-render-probes");

export function outPath(name) {
  return path.join(OUT_DIR, name);
}

/** RSS in MB after settling the GC, so stage deltas are attributable. */
export function rss() {
  global.gc?.();
  global.gc?.();
  return Math.round(process.memoryUsage.rss() / 1048576);
}

export function marker() {
  const marks = [];
  return {
    mark: (label) => marks.push([label, rss()]),
    marks,
    print: () => console.log(`MARKS ${JSON.stringify(marks)}`),
  };
}
