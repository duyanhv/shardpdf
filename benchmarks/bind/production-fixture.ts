import { createWriteStream } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import PDFDocument from "pdfkit";
import { BIND_MANIFEST_FILE } from "./fixture.ts";
import type { BindFixtureManifest, BindOutlineEntry } from "./types.ts";

type ProductionProfile = "smoke" | "full";

interface ProductionFixtureSize {
  shards: number;
  pagesPerShard: number;
  unitAnchorEveryPages: number;
}

interface FontSource {
  filePath: string;
  face?: string;
}

const PROFILES: Record<ProductionProfile, ProductionFixtureSize> = {
  smoke: { shards: 3, pagesPerShard: 12, unitAnchorEveryPages: 4 },
  full: { shards: 32, pagesPerShard: 80, unitAnchorEveryPages: 8 },
};

const PAGE = { width: 595.28, height: 841.89 } as const;
const FONT_NAME = "ProductionKorean";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "smoke" },
    output: { type: "string" },
  },
});

if (values.profile !== "smoke" && values.profile !== "full") {
  console.error("--profile must be smoke or full");
  process.exit(2);
}

const profile = values.profile;
const outputDir = path.resolve(
  values.output ??
    path.join(import.meta.dirname, "..", "out", `production-${profile}`),
);
const manifestPath = await generateProductionFixture(profile, outputDir);
console.log(manifestPath);

/**
 * Generates a deterministic, Floor-shaped corpus without application or
 * customer data. It stresses the binder with the PDF features the text-only
 * invoice fixture omits: embedded Hangul font subsets, opaque JPEG and
 * transparent PNG XObjects, annotations, cross-shard named destinations,
 * repeated resources, and a three-level Korean outline tree.
 */
export async function generateProductionFixture(
  profile: ProductionProfile,
  outputDir: string,
): Promise<string> {
  assertSafeOutputDir(outputDir);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const size = PROFILES[profile];
  const font = await resolveKoreanFont();
  const coverJpeg = createOpaqueJpeg(1400, 900);
  const overlayPng = createTransparentPng(900, 320);
  const totalPages = size.shards * size.pagesPerShard;
  const outline: BindOutlineEntry[] = [
    { title: "표지", pageIndex: 0, level: 0 },
    { title: "세대별 분석", pageIndex: 1, level: 0 },
  ];
  const shards: string[] = [];

  for (let shardIndex = 0; shardIndex < size.shards; shardIndex++) {
    const relativePath = `shard-${String(shardIndex).padStart(4, "0")}.pdf`;
    const firstPageIndex = shardIndex * size.pagesPerShard;
    await renderProductionShard({
      outputPath: path.join(outputDir, relativePath),
      shardIndex,
      firstPageIndex,
      totalPages,
      size,
      font,
      coverJpeg,
      overlayPng,
      outline,
    });
    shards.push(relativePath);
  }

  const manifest: BindFixtureManifest = {
    version: 1,
    name: `production-${profile}`,
    shardPages: size.pagesPerShard,
    totalPages,
    shards,
    outline,
  };
  const manifestPath = path.join(outputDir, BIND_MANIFEST_FILE);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

async function renderProductionShard(args: {
  outputPath: string;
  shardIndex: number;
  firstPageIndex: number;
  totalPages: number;
  size: ProductionFixtureSize;
  font: FontSource;
  coverJpeg: Buffer;
  overlayPng: Buffer;
  outline: BindOutlineEntry[];
}): Promise<void> {
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margin: 0,
    autoFirstPage: false,
    bufferPages: false,
    info: {
      Title: `ShardPDF 대용량 보고서 ${args.shardIndex + 1}`,
      Author: "ShardPDF benchmark",
      Subject: "Deterministic production-shaped fixture",
      Creator: "@shardpdf/benchmarks",
      CreationDate: new Date("2026-08-07T00:00:00.000Z"),
    },
  });
  doc.registerFont(FONT_NAME, args.font.filePath, args.font.face);
  const output = createWriteStream(args.outputPath, { flags: "wx" });
  doc.pipe(output);

  const blockTitle = `${101 + args.shardIndex}동`;
  args.outline.push({
    title: blockTitle,
    pageIndex: args.firstPageIndex,
    level: 1,
  });

  for (let localPage = 0; localPage < args.size.pagesPerShard; localPage++) {
    const globalPage = args.firstPageIndex + localPage;
    const anchor = anchorName(globalPage);
    doc.addPage();
    doc.addNamedDestination(anchor);

    if (localPage % args.size.unitAnchorEveryPages === 0) {
      const roomNumber = (args.shardIndex + 1) * 100 + localPage + 1;
      args.outline.push({
        title: `${roomNumber}호`,
        pageIndex: globalPage,
        level: 2,
      });
    }

    if (localPage === 0) {
      drawImageHeavyIntro(doc, args.coverJpeg, args.overlayPng, blockTitle);
    } else {
      drawAnalysisPage(doc, args.overlayPng, blockTitle, globalPage);
    }
    drawFooter(doc, globalPage, args.totalPages);

    const nextPage = (globalPage + 1) % args.totalPages;
    doc.goTo(PAGE.width - 126, 24, 96, 22, anchorName(nextPage));
    doc
      .font(FONT_NAME)
      .fontSize(8)
      .fillColor("#ffffff")
      .text("다음 분석으로", PAGE.width - 122, 30, {
        width: 88,
        align: "center",
        lineBreak: false,
      });
  }

  doc.end();
  await finished(output);
}

function drawImageHeavyIntro(
  doc: PDFKit.PDFDocument,
  coverJpeg: Buffer,
  overlayPng: Buffer,
  blockTitle: string,
): void {
  doc.image(coverJpeg, 0, 0, { width: PAGE.width, height: PAGE.height });
  doc
    .save()
    .rect(0, 0, PAGE.width, PAGE.height)
    .fillOpacity(0.42)
    .fill("#1f2937")
    .restore();
  doc.image(overlayPng, 48, 420, { width: PAGE.width - 96 });
  doc
    .font(FONT_NAME)
    .fontSize(34)
    .fillColor("#ffffff")
    .text("세대별 분석", 52, 90, { lineBreak: false });
  doc
    .font(FONT_NAME)
    .fontSize(18)
    .text(`${blockTitle} · 이미지 및 한글 글꼴 호환성`, 54, 142, {
      lineBreak: false,
    });
}

function drawAnalysisPage(
  doc: PDFKit.PDFDocument,
  overlayPng: Buffer,
  blockTitle: string,
  globalPage: number,
): void {
  doc.rect(0, 0, PAGE.width, PAGE.height).fill("#f7f2ef");
  doc.rect(0, 0, PAGE.width, 72).fill("#de592b");
  doc
    .font(FONT_NAME)
    .fontSize(20)
    .fillColor("#ffffff")
    .text(`${blockTitle} 세대 분석`, 34, 25, { lineBreak: false });

  const room = (globalPage % 900) + 101;
  doc
    .font(FONT_NAME)
    .fontSize(15)
    .fillColor("#292625")
    .text(`${room}호 충격음 분석 결과`, 36, 104, { lineBreak: false });

  doc.image(overlayPng, 36, 142, { width: 250, height: 90 });
  drawMetricCard(
    doc,
    308,
    142,
    250,
    90,
    "평균 단일 수치",
    `${42 + (globalPage % 70) / 10} dB`,
  );
  drawMetricCard(
    doc,
    36,
    252,
    164,
    88,
    "측정 횟수",
    `${5 + (globalPage % 8)}회`,
  );
  drawMetricCard(
    doc,
    216,
    252,
    164,
    88,
    "표준 편차",
    `${(0.8 + (globalPage % 15) / 10).toFixed(1)}`,
  );
  drawMetricCard(
    doc,
    396,
    252,
    162,
    88,
    "평가 등급",
    `${(globalPage % 4) + 1}등급`,
  );

  doc.roundedRect(36, 364, 522, 350, 10).fillAndStroke("#ffffff", "#ded7d3");
  doc
    .font(FONT_NAME)
    .fontSize(12)
    .fillColor("#525252")
    .text("주파수별 측정 분포", 54, 384, { lineBreak: false });
  for (let row = 0; row < 12; row++) {
    const y = 424 + row * 21;
    const width = 60 + ((globalPage * 17 + row * 29) % 380);
    doc
      .roundedRect(118, y, width, 9, 4)
      .fill(row % 2 === 0 ? "#de592b" : "#f1aa90");
    doc
      .font(FONT_NAME)
      .fontSize(7)
      .fillColor("#717171")
      .text(`${50 + row * 25} Hz`, 54, y - 1, { lineBreak: false });
  }
}

function drawMetricCard(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  value: string,
): void {
  doc.roundedRect(x, y, width, height, 8).fillAndStroke("#ffffff", "#e4e4e4");
  doc
    .font(FONT_NAME)
    .fontSize(8)
    .fillColor("#717171")
    .text(label, x + 12, y + 14, { lineBreak: false });
  doc
    .font(FONT_NAME)
    .fontSize(18)
    .fillColor("#292625")
    .text(value, x + 12, y + 42, { lineBreak: false });
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  globalPage: number,
  totalPages: number,
): void {
  doc.rect(0, PAGE.height - 42, PAGE.width, 42).fill("#f0dfd7");
  doc
    .font(FONT_NAME)
    .fontSize(8)
    .fillColor("#292625")
    .text(
      `ShardPDF 벤치마크 · ${globalPage + 1} / ${totalPages}`,
      24,
      PAGE.height - 27,
      { lineBreak: false },
    );
}

function anchorName(globalPage: number): string {
  return `analysis-page-${String(globalPage + 1).padStart(6, "0")}`;
}

async function resolveKoreanFont(): Promise<FontSource> {
  const configured = process.env.SHARDPDF_BENCH_KOREAN_FONT;
  if (configured !== undefined) {
    await access(configured);
    const face = process.env.SHARDPDF_BENCH_KOREAN_FONT_FACE;
    return { filePath: configured, ...(face !== undefined && { face }) };
  }

  const candidates: FontSource[] = [
    {
      filePath: "/System/Library/Fonts/AppleSDGothicNeo.ttc",
      face: "AppleSDGothicNeo-Regular",
    },
    {
      filePath: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      face: "NotoSansCJKkr-Regular",
    },
    {
      filePath: "/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf",
    },
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate.filePath);
      return candidate;
    } catch {
      // Try the next standard platform location.
    }
  }
  throw new Error(
    "No Korean benchmark font found. Set SHARDPDF_BENCH_KOREAN_FONT and, for TTC files, SHARDPDF_BENCH_KOREAN_FONT_FACE.",
  );
}

function createOpaqueJpeg(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const noise = ((x * 17 + y * 31) ^ (x * y)) & 0x1f;
      pixels[offset] = 174 + (((x * 63) / width + noise) % 70);
      pixels[offset + 1] = 62 + (((y * 89) / height + noise) % 80);
      pixels[offset + 2] = 38 + ((x + y + noise) % 75);
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data: pixels, width, height }, 82).data);
}

function createTransparentPng(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const stripe = Math.floor(x / 48) % 2 === 0;
      pixels[offset] = stripe ? 222 : 255;
      pixels[offset + 1] = stripe ? 89 : 203;
      pixels[offset + 2] = stripe ? 43 : 178;
      pixels[offset + 3] = 70 + Math.floor((185 * (height - y)) / height);
    }
  }
  return encodeRgbaPng(width, height, pixels);
}

function encodeRgbaPng(width: number, height: number, pixels: Buffer): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const outputOffset = y * (width * 4 + 1);
    scanlines[outputOffset] = 0;
    pixels.copy(
      scanlines,
      outputOffset + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function assertSafeOutputDir(outputDir: string): void {
  const parsed = path.parse(outputDir);
  if (outputDir === parsed.root || outputDir === process.cwd()) {
    throw new Error(`refusing unsafe fixture output directory ${outputDir}`);
  }
}
