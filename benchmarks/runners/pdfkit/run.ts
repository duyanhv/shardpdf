/**
 * pdfkit runner. True streaming output — expected to survive on memory. The
 * cost it pays instead is visible in layout.ts: every page number and link
 * target had to be precomputed by hand before the first byte was drawn.
 */

import { runnerMain } from "../../harness/protocol.ts";
import { generateWorkload } from "../../workload/data.ts";
import { layoutDocument } from "../../workload/layout.ts";
import { renderPagesWithPdfkit } from "./render.ts";

runnerMain(async (scale, outPath) => {
  const layout = layoutDocument(generateWorkload(scale));
  await renderPagesWithPdfkit(layout.pages, 0, layout, outPath);
  return layout.totalPages;
});
