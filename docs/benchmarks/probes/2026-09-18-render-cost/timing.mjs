/**
 * Splits per-page render time into: text measurement, drawing/serialization,
 * and (when present) canvas chart generation. Prices what a Rust renderer
 * could win, given it would have to reproduce all three.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { finished } from "node:stream/promises";
import {
  BOLD_FONT,
  OUT_DIR,
  outPath,
  REGULAR_FONT,
  requireHost,
} from "./probe-config.mjs";

mkdirSync(OUT_DIR, { recursive: true });
const PDFDocument = requireHost("pdfkit");
const { createCanvas } = requireHost("canvas");

const PAGES = 200;
let tMeasure = 0n,
  tDraw = 0n,
  tCanvas = 0n;
const doc = new PDFDocument({
  size: "A4",
  margins: { top: 0, bottom: 30, left: 36, right: 36 },
  bufferPages: false,
});
doc.registerFont("R", REGULAR_FONT);
doc.registerFont("B", BOLD_FONT);
const out = createWriteStream(outPath("timing.pdf"));
doc.pipe(out);
const HANGUL = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허";
const t0 = process.hrtime.bigint();
for (let p = 0; p < PAGES; p++) {
  if (p > 0) {
    const a = process.hrtime.bigint();
    doc.addPage();
    tDraw += process.hrtime.bigint() - a;
  }
  for (let card = 0; card < 6; card++) {
    const y = 60 + card * 120;
    let a = process.hrtime.bigint();
    doc.save();
    doc.roundedRect(36, y, 523, 110, 8).fillColor("#FFFFFF").fill();
    doc
      .font("B")
      .fontSize(10)
      .fillColor("#292625")
      .text("측정 결과 요약", 48, y + 10, { width: 500 });
    doc.font("R").fontSize(8);
    tDraw += process.hrtime.bigint() - a;
    for (let r = 0; r < 8; r++) {
      const ry = y + 28 + r * 9;
      const g =
        HANGUL[(p * 8 + r) % HANGUL.length] + HANGUL[(p + r) % HANGUL.length];
      a = process.hrtime.bigint();
      doc.text(`${g}동 ${101 + r}호`, 48, ry, { width: 120, lineBreak: false });
      doc.text(`${(40 + ((p + r) % 20)).toFixed(1)}dB`, 180, ry, {
        width: 60,
        lineBreak: false,
      });
      tDraw += process.hrtime.bigint() - a;
      a = process.hrtime.bigint();
      for (let k = 0; k < 8; k++) doc.widthOfString(`${g}동 ${101 + r}호`);
      doc.heightOfString(`${g}동`, { width: 120 });
      tMeasure += process.hrtime.bigint() - a;
    }
    a = process.hrtime.bigint();
    doc.restore();
    tDraw += process.hrtime.bigint() - a;
  }
  // Floor's current per-page canvas gauge
  const a = process.hrtime.bigint();
  const c = createCanvas(430, 180);
  const ctx = c.getContext("2d");
  for (let i = 0; i < 10; i++) {
    ctx.beginPath();
    ctx.fillStyle = `rgba(${i * 20},120,90,1)`;
    ctx.moveTo(10 + i * 40, 170);
    ctx.lineTo(30 + i * 40, 20);
    ctx.lineTo(45 + i * 40, 170);
    ctx.closePath();
    ctx.fill();
  }
  const png = c.toBuffer("image/png");
  tCanvas += process.hrtime.bigint() - a;
  const b = process.hrtime.bigint();
  doc.image(png, 40, 700, { fit: [200, 80] });
  tDraw += process.hrtime.bigint() - b;
}
doc.end();
await finished(out);
const total = Number(process.hrtime.bigint() - t0) / 1e6;
const ms = (x) => (Number(x) / 1e6 / PAGES).toFixed(2);
console.log(
  `pages=${PAGES} total=${total.toFixed(0)}ms  per page: measure=${ms(tMeasure)}ms draw+serialize=${ms(tDraw)}ms canvasPNG=${ms(tCanvas)}ms  wall/page=${(total / PAGES).toFixed(2)}ms`,
);
