/**
 * THE LOAD-BEARING PROBE for the 2026-09-18 render-cost audit.
 *
 * Floor Inspector's per-page gauge (analysis-unit.ts:535) is a pure function of
 * (grade, profile): 6 grades x 2 profiles = 12 distinct images MAX. Yet it
 * renders a fresh canvas + PNG Buffer per unit page and hands the Buffer to
 * doc.image(). Two costs follow:
 *
 *   1. N rasterizations instead of <=12.
 *   2. N image XObjects instead of <=12 -- pdfkit's _imageRegistry
 *      (pdfkit.js:4928) is keyed by string PATH only, so a Buffer always
 *      misses the cache and embeds a fresh XObject on every page.
 *
 * Four strategies, same rendered output:
 *   naive      - what Floor does now
 *   memo       - memoize the Buffer (fixes 1, NOT 2)
 *   memo-path  - memoize to a temp file, so pdfkit dedupes too (fixes 1 and 2)
 *   openimage  - memoize doc.openImage() handles (fixes both, no temp files)
 *
 * usage: FLOOR_ROOT=... node --expose-gc dedupe-probe.mjs <pages> <strategy>
 */
import { createWriteStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { finished } from "node:stream/promises";
import { marker, OUT_DIR, outPath, requireHost, rss } from "./probe-config.mjs";

const { createCanvas } = requireHost("canvas");
const PDFDocument = requireHost("pdfkit");

const pages = Number(process.argv[2] ?? 400);
const strategy = process.argv[3] ?? "naive";
const STRATEGIES = new Set(["naive", "memo", "memo-path", "openimage"]);
if (!STRATEGIES.has(strategy)) {
  console.error(
    `usage: node dedupe-probe.mjs <pages> <${[...STRATEGIES].join("|")}>`,
  );
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

const { mark, marks } = marker();
mark("baseline");

// Floor's BLOCK_AVG_BAR_CHART size, the one used per unit page.
const W = 430;
const H = 180;
let canvasCount = 0;

/** Stand-in for renderAverageGauge: same size, same 1-of-N-grades output space. */
function gauge(grade) {
  canvasCount++;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < 10; i++) {
    ctx.beginPath();
    ctx.fillStyle = `rgba(${(grade * 40 + i * 20) % 255}, 120, 90, ${i < grade * 2 ? 1 : 0.28})`;
    ctx.moveTo(10 + i * 40, 170);
    ctx.lineTo(30 + i * 40, 20 + i * 5);
    ctx.lineTo(45 + i * 40, 170);
    ctx.closePath();
    ctx.fill();
  }
  return canvas.toBuffer("image/png");
}

const memo = new Map();
const pdfPath = outPath(`dedupe-${strategy}.pdf`);
const out = createWriteStream(pdfPath);
const doc = new PDFDocument({ size: "A4", bufferPages: false });
doc.pipe(out);

const samples = [];
for (let p = 0; p < pages; p++) {
  if (p > 0) doc.addPage();
  // Real reports spread units across the 5 grades plus null.
  const grade = p % 6;

  let src;
  if (strategy === "naive") {
    src = gauge(grade);
  } else if (strategy === "memo") {
    if (!memo.has(grade)) memo.set(grade, gauge(grade));
    src = memo.get(grade);
  } else if (strategy === "memo-path") {
    if (!memo.has(grade)) {
      const f = outPath(`gauge-${grade}.png`);
      writeFileSync(f, gauge(grade));
      memo.set(grade, f);
    }
    src = memo.get(grade);
  } else {
    if (!memo.has(grade)) memo.set(grade, doc.openImage(gauge(grade)));
    src = memo.get(grade);
  }

  doc.image(src, 40, 100, { fit: [300, 120] });
  if (p % 100 === 99) samples.push([p + 1, rss()]);
}

mark(`${pages}-pages-embedded`);
doc.end();
await finished(out);
mark("finalized");

console.log(
  `RESULT strategy=${strategy} pages=${pages} canvases=${canvasCount} ` +
    `pdfBytes=${statSync(pdfPath).size} marks=${JSON.stringify(marks)}`,
);
console.log(`PER_PAGE ${JSON.stringify(samples)}`);
console.log(`OUTPUT ${pdfPath}`);
