/**
 * Draws a range of reference-layout pages into a pdfkit document, streaming to
 * disk. Global page numbers and link targets come precomputed from the layout —
 * pdfkit itself has no way to know them (single forward pass).
 *
 * Shared by the pdfkit runner (all pages, one doc) and the merge runner (one
 * doc per shard).
 */

import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import PDFDocument from "pdfkit";
import type { LayoutDoc, PageSpec } from "../../workload/layout.ts";
import { PAGE } from "../../workload/layout.ts";

export async function renderPagesWithPdfkit(
  pages: PageSpec[],
  firstPageIndex: number, // 0-based global index of pages[0]
  layout: LayoutDoc,
  outPath: string,
): Promise<void> {
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margin: 0,
    autoFirstPage: false,
    bufferPages: false,
  });
  const stream = createWriteStream(outPath);
  doc.pipe(stream);

  pages.forEach((spec, i) => {
    const globalIndex = firstPageIndex + i;
    doc.addPage();
    let y = PAGE.margin;

    for (const line of spec.lines) {
      if (line.anchor !== undefined) {
        doc.addNamedDestination(line.anchor);
      }
      if (line.text.length > 0) {
        doc
          .font(line.bold === true ? "Courier-Bold" : "Courier")
          .fontSize(PAGE.fontSize)
          .text(line.text, PAGE.margin, y, { lineBreak: false });
      }
      if (line.linkTo !== undefined) {
        doc.goTo(
          PAGE.margin,
          y,
          PAGE.width - 2 * PAGE.margin,
          PAGE.lineHeight,
          line.linkTo,
        );
      }
      y += PAGE.lineHeight;
    }

    doc
      .font("Courier")
      .fontSize(PAGE.fontSize)
      .text(
        `Page ${globalIndex + 1} of ${layout.totalPages}`,
        PAGE.width / 2 - 40,
        PAGE.height - 40,
        { lineBreak: false },
      );
  });

  doc.end();
  await finished(stream);
}
