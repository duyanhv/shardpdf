/** What inside draw+serialize is expensive: Korean text vs vector vs ASCII text. */
import { createWriteStream, mkdirSync } from "node:fs";
import {
  OUT_DIR,
  outPath,
  REGULAR_FONT,
  requireHost,
} from "./probe-config.mjs";

mkdirSync(OUT_DIR, { recursive: true });
const PDFDocument = requireHost("pdfkit");

const doc = new PDFDocument({ size: "A4", bufferPages: false });
doc.registerFont("R", REGULAR_FONT);
doc.pipe(createWriteStream(outPath("ds.pdf")));
doc.font("R").fontSize(9);
const N = 20000;
function bench(label, fn) {
  const t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) fn(i);
  console.log(
    `${label}: ${(Number(process.hrtime.bigint() - t) / N / 1000).toFixed(1)} us/call`,
  );
}
bench("text(Korean 12ch)", () =>
  doc.text("가동 101호 측정", 40, 40, { lineBreak: false }),
);
bench("text(ASCII 12ch)", () =>
  doc.text("Block 101 OK", 40, 40, { lineBreak: false }),
);
bench("roundedRect+fill", () => {
  doc.roundedRect(36, 40, 500, 100, 8).fill();
});
bench("save/restore", () => {
  doc.save();
  doc.restore();
});
bench("font switch", () => doc.font("R"));
doc.end();
