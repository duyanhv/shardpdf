/**
 * Decomposes pdfkit render memory the way Floor Inspector actually uses it.
 *
 * Stages are cumulative and each prints RSS after a forced GC settle, so the
 * deltas attribute cost to: node baseline, pdfkit module, Korean OTF
 * registration+embedding, and per-page drawing at Floor-like density.
 *
 * usage: node --expose-gc probe.mjs <stage> [pages]
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { finished } from "node:stream/promises";
import {
  BANNER_PNG,
  BOLD_FONT,
  COVER_JPEG,
  OUT_DIR,
  outPath,
  REGULAR_FONT,
  requireHost,
} from "./probe-config.mjs";

mkdirSync(OUT_DIR, { recursive: true });

const REG = REGULAR_FONT;
const BOLD = BOLD_FONT;
const COVER = COVER_JPEG;
const BANNER = BANNER_PNG;

const stage = process.argv[2] ?? "all";
const pages = Number(process.argv[3] ?? 100);

function rss() {
  global.gc?.();
  global.gc?.();
  return Math.round(process.memoryUsage.rss() / 1048576);
}
const marks = [];
function mark(label) {
  marks.push([label, rss()]);
}

mark("node-baseline");

const PDFDocument = requireHost("pdfkit");
mark("pdfkit-module-loaded");

// Korean glyph pool: pdfkit subsets per document, and the subset grows with the
// number of DISTINCT glyphs drawn. Floor draws Korean labels on every page.
const HANGUL =
  "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후";
const LABELS = [
  "현장 분석",
  "타입 분석",
  "충격 위치 분석",
  "동 분석",
  "세대별 분석",
  "바닥 충격음 측정 결과 요약",
  "주파수 대역별 분석",
  "층간 구조 비교",
  "측정 위치",
  "등급",
  "평균",
  "표준편차",
  "최대",
  "최소",
  "중앙값",
];

async function render(n, { images = false } = {}) {
  const out = createWriteStream(outPath(`out-${stage}.pdf`));
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 0, bottom: 30, left: 36, right: 36 },
    bufferPages: false,
  });
  doc.registerFont("NotoSansKR", REG);
  doc.registerFont("NotoSansKR-Bold", BOLD);
  doc.pipe(out);
  mark("fonts-registered");

  const samples = [];
  for (let p = 0; p < n; p++) {
    if (p > 0) doc.addPage();

    // Floor's density, from the API census: ~2.3 font switches, ~1.9 text,
    // ~1.1 save/restore, ~0.55 roundedRect per *drawing call* across 18k LOC.
    // Per page this is dozens of each. Cards + tables + chips + footer.
    for (let card = 0; card < 6; card++) {
      const y = 60 + card * 120;
      doc.save();
      doc.roundedRect(36, y, 523, 110, 8).fillColor("#FFFFFF").fill();
      doc
        .roundedRect(36, y, 523, 110, 8)
        .lineWidth(0.8)
        .strokeColor("#E4E4E4")
        .stroke();
      doc.font("NotoSansKR-Bold").fontSize(10).fillColor("#292625");
      const label = LABELS[(p * 6 + card) % LABELS.length];
      doc.text(label, 48, y + 10, { width: 500 });
      doc.font("NotoSansKR").fontSize(8).fillColor("#525252");
      // Table rows: the unit/block sections are dense numeric tables.
      for (let row = 0; row < 8; row++) {
        const rowY = y + 28 + row * 9;
        // Distinct Korean glyphs grow the subset, as real unit names do.
        const g =
          HANGUL[(p * 8 + row) % HANGUL.length] +
          HANGUL[(p + row) % HANGUL.length];
        doc.text(`${g}동 ${101 + row}호`, 48, rowY, {
          width: 120,
          lineBreak: false,
        });
        doc.text(`${(40 + ((p + row) % 20)).toFixed(1)}dB`, 180, rowY, {
          width: 60,
          lineBreak: false,
        });
        doc.text(`${1 + ((p + row) % 4)}등급`, 250, rowY, {
          width: 60,
          lineBreak: false,
        });
        doc.widthOfString(`${g}동`);
        doc.heightOfString(`${g}동`, { width: 120 });
      }
      doc.restore();
    }
    // Footer, drawn on every page in Floor.
    doc.save();
    doc.rect(0, 800, 595, 34).fillColor("#F0DFD7").fill();
    doc.font("NotoSansKR").fontSize(7).fillColor("#292625");
    doc.text(`${p + 1}`, 540, 812, { width: 40, lineBreak: false });
    doc.restore();

    if (images) {
      // A chart PNG per page, as the unit/block sections do via canvas gauges.
      doc.image(BANNER, 36, 700, { fit: [200, 80] });
    }

    if (p % 25 === 24) samples.push([p + 1, rss()]);
  }

  doc.end();
  await finished(out);
  return samples;
}

if (stage === "baseline") {
  // stop here: node + pdfkit module only
} else if (stage === "fonts") {
  const doc = new PDFDocument({ bufferPages: false });
  doc.registerFont("NotoSansKR", REG);
  doc.registerFont("NotoSansKR-Bold", BOLD);
  doc.pipe(createWriteStream(outPath("out-fonts.pdf")));
  mark("fonts-registered");
  // Force actual font loading (registerFont is lazy until used).
  doc.font("NotoSansKR").fontSize(10).text("가나다");
  doc.font("NotoSansKR-Bold").text("가나다");
  mark("fonts-used-3-glyphs");
  doc.end();
} else if (stage === "pages") {
  const samples = await render(pages);
  mark(`rendered-${pages}-pages`);
  console.log(`PER_PAGE_SAMPLES ${JSON.stringify(samples)}`);
} else if (stage === "pages-images") {
  const samples = await render(pages, { images: true });
  mark(`rendered-${pages}-pages-with-images`);
  console.log(`PER_PAGE_SAMPLES ${JSON.stringify(samples)}`);
} else if (stage === "cover") {
  const doc = new PDFDocument({ size: "A4", bufferPages: false });
  doc.pipe(createWriteStream(outPath("out-cover.pdf")));
  mark("doc-created");
  doc.image(COVER, 0, 0, { width: 595.28, height: 841.89 });
  mark("jpeg-cover-embedded");
  doc.addPage();
  doc.image(BANNER, 0, 0, { width: 595.28 });
  mark("png-banner-embedded");
  doc.end();
}

mark("final");
console.log(`MARKS ${JSON.stringify(marks)}`);
