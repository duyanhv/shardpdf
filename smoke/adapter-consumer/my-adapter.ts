/** An external consumer's adapter, written the way the README documents. */

import type { PdfDocument } from "@shardpdf/adapter-pdfkit";
import { createPdfkitAdapter } from "@shardpdf/adapter-pdfkit";
import PDFDocument from "pdfkit";

export interface Section {
  kind: "unit";
  grades: number[];
}

function gaugePng(grade: number): Buffer {
  // Stand-in for a node-canvas chart: tiny, deterministic, opaque.
  const px = Buffer.alloc(8 * (1 + 8 * 3));
  for (let y = 0; y < 8; y++) {
    const r = y * 25;
    px[r] = 0;
    for (let x = 0; x < 8; x++) {
      const p = r + 1 + x * 3;
      px[p] = grade * 40;
      px[p + 1] = 120;
      px[p + 2] = 90;
    }
  }
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", require("node:zlib").deflateSync(px)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const adapter = createPdfkitAdapter<Section>({
  createDocument: () =>
    new PDFDocument({
      size: "A4",
      bufferPages: false,
    }) as unknown as PdfDocument,
  kindOf: (data) => data.kind,
  templates: {
    unit: {
      pages: (data) => data.grades.length,
      anchors: (_d, id) => [{ name: `sec:${id}` }],
      draw(doc, data, page) {
        const d = doc as never as {
          font(n: string): unknown;
          fontSize(n: number): unknown;
          text(t: string, x?: number, y?: number, o?: unknown): unknown;
          image(s: unknown, x?: number, y?: number, o?: unknown): unknown;
        };
        const grade = data.grades[page.pageIndexInSection] ?? 1;
        d.font("Helvetica");
        d.fontSize(12);
        d.text(`Unit ${page.pageIndexInSection + 1} grade ${grade}`, 40, 40);
        d.image(
          page.images.get(`gauge:${grade}`, () => gaugePng(grade)),
          40,
          80,
          { width: 120 },
        );
        d.text(
          `Page ${page.absolutePageNumber} of ${page.totalPages}`,
          40,
          760,
          { lineBreak: false },
        );
      },
    },
  },
});
