/** Is draw cost layout, content-stream serialization, or zlib compression? */
import { mkdirSync } from "node:fs";
import { Writable } from "node:stream";
import { OUT_DIR, REGULAR_FONT, requireHost } from "./probe-config.mjs";

mkdirSync(OUT_DIR, { recursive: true });
const PDFDocument = requireHost("pdfkit");

const N = 20000;
function sink() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
for (const compress of [true, false]) {
  const doc = new PDFDocument({ size: "A4", bufferPages: false, compress });
  doc.registerFont("R", REGULAR_FONT);
  doc.pipe(sink());
  doc.font("R").fontSize(9);
  doc.text("warm", 40, 40, { lineBreak: false });
  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++)
    doc.text("가동 101호 측정", 40, 40, { lineBreak: false });
  const txt = Number(process.hrtime.bigint() - t) / N / 1000;
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    doc.roundedRect(36, 40, 500, 100, 8).fill();
  }
  const rr = Number(process.hrtime.bigint() - t) / N / 1000;
  console.log(
    `compress=${compress}: text=${txt.toFixed(1)}us roundedRect+fill=${rr.toFixed(1)}us`,
  );
  doc.end();
}
