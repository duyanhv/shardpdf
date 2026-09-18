/**
 * Measures the per-page canvas+PNG cost Floor pays inside its unit render loop
 * (analysis-unit.ts:536 calls renderAverageGauge per unit), and the PNG decode
 * cost pdfkit pays to embed each one.
 *
 * usage: node --expose-gc canvas-probe.mjs <pages>
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { finished } from "node:stream/promises";
import { OUT_DIR, outPath, requireHost } from "./probe-config.mjs";

mkdirSync(OUT_DIR, { recursive: true });

const { createCanvas } = requireHost("canvas");
const PDFDocument = requireHost("pdfkit");

const pages = Number(process.argv[2] ?? 200);
const mode = process.argv[3] ?? "both"; // canvas | embed | both

function rss() {
  global.gc?.();
  global.gc?.();
  return Math.round(process.memoryUsage.rss() / 1048576);
}
const marks = [];
const mark = (l) => marks.push([l, rss()]);

mark("baseline+modules");

// Floor's BLOCK_AVG_BAR_CHART size, the one used per unit page.
const W = 430,
  H = 180;
function gaugePng(seed) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < 10; i++) {
    ctx.beginPath();
    ctx.fillStyle = `rgba(${(seed * 7 + i * 20) % 255}, 120, 90, ${i < 5 ? 1 : 0.28})`;
    ctx.moveTo(10 + i * 40, 170);
    ctx.lineTo(30 + i * 40, 20 + i * 5);
    ctx.lineTo(45 + i * 40, 170);
    ctx.closePath();
    ctx.fill();
  }
  return canvas.toBuffer("image/png");
}

const one = gaugePng(0);
mark(`one-gauge-png-${one.length}B`);

const samples = [];
if (mode === "canvas") {
  for (let p = 0; p < pages; p++) {
    gaugePng(p);
    if (p % 25 === 24) samples.push([p + 1, rss()]);
  }
  mark(`${pages}-gauges-generated-not-embedded`);
} else {
  const out = createWriteStream(outPath(`canvas-${mode}.pdf`));
  const doc = new PDFDocument({ size: "A4", bufferPages: false });
  doc.pipe(out);
  for (let p = 0; p < pages; p++) {
    if (p > 0) doc.addPage();
    const png = gaugePng(p);
    doc.image(png, 40, 100, { fit: [300, 120] });
    if (p % 25 === 24) samples.push([p + 1, rss()]);
  }
  mark(`${pages}-gauges-generated-and-embedded`);
  doc.end();
  await finished(out);
}
mark("final");
console.log(`PER_PAGE ${JSON.stringify(samples)}`);
console.log(`MARKS ${JSON.stringify(marks)}`);
