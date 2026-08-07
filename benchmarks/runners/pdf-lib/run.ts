/**
 * pdf-lib runner. Whole document materialized as a PDFDocument object graph,
 * serialized once at the end — the architecture whose memory ceiling this
 * benchmark exists to demonstrate.
 */

import { writeFile } from "node:fs/promises";
import {
  PDFDocument,
  PDFName,
  type PDFPage,
  type PDFRef,
  StandardFonts,
} from "pdf-lib";
import { runnerMain } from "../../harness/protocol.ts";
import { generateWorkload } from "../../workload/data.ts";
import { layoutDocument, PAGE } from "../../workload/layout.ts";

runnerMain(async (scale, outPath) => {
  const layout = layoutDocument(generateWorkload(scale));

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Courier);
  const bold = await doc.embedFont(StandardFonts.CourierBold);

  // Create all pages first so link annotations can reference target page refs.
  const pdfPages: PDFPage[] = layout.pages.map(() =>
    doc.addPage([PAGE.width, PAGE.height]),
  );

  layout.pages.forEach((spec, pageIndex) => {
    const page = pdfPages[pageIndex];
    if (page === undefined) throw new Error("unreachable: missing page");
    const annots: PDFRef[] = [];
    let y = PAGE.height - PAGE.margin;

    for (const line of spec.lines) {
      if (line.text.length > 0) {
        page.drawText(line.text, {
          x: PAGE.margin,
          y: y - PAGE.fontSize,
          size: PAGE.fontSize,
          font: line.bold === true ? bold : font,
        });
      }
      if (line.linkTo !== undefined) {
        const targetIndex = layout.anchorPage[line.linkTo];
        const target =
          targetIndex === undefined ? undefined : pdfPages[targetIndex];
        if (target === undefined) throw new Error(`bad link ${line.linkTo}`);
        annots.push(
          doc.context.register(
            doc.context.obj({
              Type: "Annot",
              Subtype: "Link",
              Rect: [
                PAGE.margin,
                y - PAGE.lineHeight,
                PAGE.width - PAGE.margin,
                y,
              ],
              Border: [0, 0, 0],
              Dest: [target.ref, "XYZ", null, null, null],
            }),
          ),
        );
      }
      y -= PAGE.lineHeight;
    }

    page.drawText(`Page ${pageIndex + 1} of ${layout.totalPages}`, {
      x: PAGE.width / 2 - 40,
      y: 30,
      size: PAGE.fontSize,
      font,
    });

    if (annots.length > 0) {
      page.node.set(PDFName.of("Annots"), doc.context.obj(annots));
    }
  });

  const bytes = await doc.save();
  await writeFile(outPath, bytes);
  return layout.totalPages;
});
