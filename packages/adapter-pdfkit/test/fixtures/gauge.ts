/**
 * A synthetic chart whose output depends only on a small-cardinality key, and
 * a cross-process counter of how many times it was actually rasterized.
 *
 * The counter has to be file-based: the orchestrator runs `render()` in a
 * forked worker, so an in-memory counter in the test process would always read
 * zero and the dedupe assertion would be vacuous.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

/**
 * Where the rasterize log goes. Overridable so each test gets a fresh file;
 * the worker inherits it through the environment.
 */
export const rasterizeCountPath = (): string =>
  process.env.ADAPTER_TEST_RASTERIZE_LOG ??
  path.join(tmpdir(), "shardpdf-adapter-rasterize.log");

/**
 * Stands in for a `node-canvas` chart render: deterministic for a given grade,
 * and expensive enough in the real world that repeating it per page was worth
 * 31 ms/page. Emits a minimal valid PNG so PDFKit can actually embed it.
 */
export function rasterizeGauge(grade: number): Buffer {
  appendFileSync(rasterizeCountPath(), `${grade}\n`);
  return solidPng(GRADE_COLORS[grade % GRADE_COLORS.length] ?? [0, 0, 0]);
}

/** How many times rasterizeGauge ran, and for which keys. */
export function readRasterizeLog(): { total: number; keys: string[] } {
  let text = "";
  try {
    text = readFileSync(rasterizeCountPath(), "utf8");
  } catch {
    return { total: 0, keys: [] };
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  return { total: lines.length, keys: [...new Set(lines)].sort() };
}

const GRADE_COLORS: Array<[number, number, number]> = [
  [222, 89, 43],
  [76, 175, 80],
  [33, 150, 243],
  [255, 193, 7],
  [156, 39, 176],
  [96, 125, 139],
];

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Builds an 8x8 opaque RGB PNG by hand rather than depending on `canvas`,
 * whose native build would make these tests fragile. RGB (not RGBA) on
 * purpose: the audit found PDFKit byte-passes opaque images and fully decodes
 * alpha PNGs.
 */
function solidPng([r, g, b]: [number, number, number]): Buffer {
  const size = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = truecolor RGB, no alpha
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
