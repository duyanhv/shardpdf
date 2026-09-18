/**
 * Tests whether the per-page chart format is Floor's remaining per-page memory
 * slope. Floor fixed the COVER (PNG->JPEG, 461MB -> 193MB floor) but its
 * per-page charts still come from canvas.toBuffer("image/png"), which always
 * emits RGBA -- the exact case its own docs say pdfkit fully decodes.
 *
 * usage: node --expose-gc format-probe.mjs <pages> <png|jpeg|jpeg-opaque|raw>
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { finished } from "node:stream/promises";
import { OUT_DIR, outPath, requireHost } from "./probe-config.mjs";

mkdirSync(OUT_DIR, { recursive: true });

const { createCanvas } = requireHost("canvas");
const PDFDocument = requireHost("pdfkit");

const pages = Number(process.argv[2] ?? 200);
const format = process.argv[3] ?? "png";

function rss() {
  global.gc?.();
  global.gc?.();
  return Math.round(process.memoryUsage.rss() / 1048576);
}
const marks = [];
const mark = (l) => marks.push([l, rss()]);
mark("baseline+modules");

const W = 430,
  H = 180;
function gauge(seed, fmt) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  if (fmt.startsWith("jpeg")) {
    // JPEG has no alpha channel; paint the card background explicitly so the
    // rendered result is identical to the transparent-over-white composite.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.clearRect(0, 0, W, H);
  }
  for (let i = 0; i < 10; i++) {
    ctx.beginPath();
    ctx.fillStyle = `rgba(${(seed * 7 + i * 20) % 255}, 120, 90, ${i < 5 ? 1 : 0.28})`;
    ctx.moveTo(10 + i * 40, 170);
    ctx.lineTo(30 + i * 40, 20 + i * 5);
    ctx.lineTo(45 + i * 40, 170);
    ctx.closePath();
    ctx.fill();
  }
  return fmt.startsWith("jpeg")
    ? canvas.toBuffer("image/jpeg", { quality: 0.92 })
    : canvas.toBuffer("image/png");
}

const one = gauge(0, format);
mark(`one-chart-${format}-${one.length}B`);

const out = createWriteStream(outPath(`fmt-${format}.pdf`));
const doc = new PDFDocument({ size: "A4", bufferPages: false });
doc.pipe(out);
const samples = [];
for (let p = 0; p < pages; p++) {
  if (p > 0) doc.addPage();
  doc.image(gauge(p, format), 40, 100, { fit: [300, 120] });
  if (p % 50 === 49) samples.push([p + 1, rss()]);
}
mark(`${pages}-pages-embedded`);
doc.end();
await finished(out);
mark("finalized");
console.log(`PER_PAGE ${JSON.stringify(samples)}`);
console.log(`MARKS ${JSON.stringify(marks)}`);
