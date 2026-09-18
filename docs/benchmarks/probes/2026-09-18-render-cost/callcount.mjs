/**
 * Counts the PER-PAGE pdfkit call volume, including the SYNCHRONOUS measurement
 * queries (widthOfString/heightOfString) that Floor's layout code interleaves
 * with drawing. Each such query would become an FFI round trip in a Rust
 * renderer, and cannot be batched because the next draw position depends on it.
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

const counts = {};
const MEASURE = new Set([
  "widthOfString",
  "heightOfString",
  "currentLineHeight",
]);
const proto = PDFDocument.prototype;
for (const k of [
  "font",
  "text",
  "save",
  "restore",
  "heightOfString",
  "widthOfString",
  "roundedRect",
  "rect",
  "image",
  "circle",
  "lineWidth",
  "fillColor",
  "strokeColor",
  "fill",
  "stroke",
  "moveTo",
  "lineTo",
  "path",
  "addPage",
  "translate",
  "clip",
  "dash",
  "undash",
  "fillOpacity",
  "closePath",
  "fontSize",
  "linearGradient",
]) {
  const orig = proto[k];
  if (typeof orig !== "function") continue;
  proto[k] = function (...a) {
    counts[k] = (counts[k] ?? 0) + 1;
    return orig.apply(this, a);
  };
}

const doc = new PDFDocument({ size: "A4", bufferPages: false });
doc.registerFont("R", REGULAR_FONT);
doc.pipe(createWriteStream(outPath("cc.pdf")));

// One Floor-shaped unit page: 6 cards, 8 table rows each, footer.
doc.font("R").fontSize(9);
for (let card = 0; card < 6; card++) {
  const y = 60 + card * 120;
  doc.save();
  doc.roundedRect(36, y, 523, 110, 8).fillColor("#FFF").fill();
  doc
    .font("R")
    .fontSize(10)
    .text("바닥 충격음 측정 결과 요약", 48, y + 10, { width: 500 });
  for (let r = 0; r < 8; r++) {
    const ry = y + 28 + r * 9;
    doc.text(`가동 ${101 + r}호`, 48, ry, { width: 120, lineBreak: false });
    doc.widthOfString("가동");
    doc.heightOfString("가동", { width: 120 });
  }
  doc.restore();
}
doc.save();
doc.rect(0, 800, 595, 34).fillColor("#F0DFD7").fill();
doc.font("R").fontSize(7).text("1", 540, 812, { lineBreak: false });
doc.restore();
doc.end();

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const measures = Object.entries(counts)
  .filter(([k]) => MEASURE.has(k))
  .reduce((a, [, v]) => a + v, 0);
console.log("PER_PAGE_CALLS", JSON.stringify(counts));
console.log(`TOTAL=${total} BLOCKING_MEASURE_QUERIES=${measures}`);
