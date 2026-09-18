/**
 * Prices pdfkit's text measurement in JS -- the work a Rust text shaper would
 * have to beat, NET of the FFI round trip measured by ffi-bench.
 *
 * Floor's layout interleaves these queries with drawing (the next draw position
 * depends on the result), so each one is a blocking call that cannot be
 * batched across a language boundary.
 *
 * Reports the MEDIAN of several trials: single runs vary by ~2x on this
 * workload because of GC timing and glyph-cache warmth.
 *
 * usage: FLOOR_ROOT=... node measure-cost.mjs [trials]
 */
import { createWriteStream, mkdirSync } from "node:fs";
import {
  OUT_DIR,
  outPath,
  REGULAR_FONT,
  requireHost,
} from "./probe-config.mjs";

mkdirSync(OUT_DIR, { recursive: true });
const PDFDocument = requireHost("pdfkit");

const trials = Number(process.argv[2] ?? 7);
const N = 50_000;

// Floor's real label shapes: short Korean unit IDs, numerics, and a long title.
const STRINGS = [
  "가동 101호",
  "나동 1502호",
  "45.3dB",
  "3등급",
  "측정 위치",
  "바닥 충격음 측정 결과 요약",
];

const doc = new PDFDocument({ size: "A4", bufferPages: false });
doc.registerFont("R", REGULAR_FONT);
doc.pipe(createWriteStream(outPath("mc.pdf")));
doc.font("R").fontSize(9);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function bench(fn) {
  const runs = [];
  for (let t = 0; t < trials; t++) {
    let acc = 0;
    // Warm the glyph cache so we measure steady state, not first-touch.
    for (let i = 0; i < 1000; i++) acc += fn(i);
    const start = process.hrtime.bigint();
    for (let i = 0; i < N; i++) acc += fn(i);
    runs.push(Number(process.hrtime.bigint() - start) / N);
    if (!(acc > 0)) throw new Error("benchmark optimized away");
  }
  return {
    median: median(runs),
    min: Math.min(...runs),
    max: Math.max(...runs),
  };
}

const w = bench((i) => doc.widthOfString(STRINGS[i % STRINGS.length]));
const h = bench((i) =>
  doc.heightOfString(STRINGS[i % STRINGS.length], { width: 120 }),
);

const f = (r) =>
  `${r.median.toFixed(0)} ns (min ${r.min.toFixed(0)}, max ${r.max.toFixed(0)})`;
console.log(`trials=${trials} iterations=${N}`);
console.log(`widthOfString:  ${f(w)}`);
console.log(`heightOfString: ${f(h)}`);
// The per-page census from callcount.mjs: 404 width + 48 height queries.
const perPage = (404 * w.median + 48 * h.median) / 1e6;
console.log(
  `Floor page (404 width + 48 height) => ${perPage.toFixed(2)} ms/page of measurement`,
);
doc.end();
