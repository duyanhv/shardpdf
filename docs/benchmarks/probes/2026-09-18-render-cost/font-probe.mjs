/**
 * Isolates the Korean OTF cost: fontkit parse vs glyph-subset growth vs embed.
 * Floor embeds 2 x ~4.7MB NotoSansKR OTFs in EVERY chunk child.
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

const glyphs = Number(process.argv[2] ?? 200);
function rss() {
  global.gc?.();
  global.gc?.();
  return Math.round(process.memoryUsage.rss() / 1048576);
}
const m = [];
const mk = (l) => m.push([l, rss()]);
mk("baseline");
const doc = new PDFDocument({ bufferPages: false });
doc.pipe(createWriteStream(outPath("font.pdf")));
mk("doc");
doc.registerFont("R", REGULAR_FONT);
doc.registerFont("B", BOLD_FONT);
mk("registered-lazy");
doc.font("R").fontSize(9);
mk("regular-loaded");
// Walk the Hangul syllable block to grow the subset.
let s = "";
for (let i = 0; i < glyphs; i++) s += String.fromCharCode(0xac00 + i * 7);
doc.text(s, { width: 500 });
mk(`regular-${glyphs}-glyphs`);
doc.font("B").text(s.slice(0, Math.floor(glyphs / 2)), { width: 500 });
mk(`bold-${Math.floor(glyphs / 2)}-glyphs`);
doc.end();
await finished(doc);
mk("finalized-subset-written");
console.log(`MARKS ${JSON.stringify(m)}`);
