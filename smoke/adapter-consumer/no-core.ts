/**
 * An adapter author should not need the native core just to define templates
 * and measure. Only generate() (assembly) needs it.
 */

import type { PdfDocument } from "@shardpdf/adapter-pdfkit";
import { createPdfkitAdapter, ImageCache } from "@shardpdf/adapter-pdfkit";

const adapter = createPdfkitAdapter<{ kind: "s"; n: number }>({
  createDocument: () => ({}) as PdfDocument,
  kindOf: () => "s",
  templates: {
    s: {
      pages: (d) => d.n,
      anchors: (_d, id) => [{ name: `a:${id}` }],
      draw: () => {},
    },
  },
});
const m = adapter.measure(
  { index: 0, sections: [{ id: "x", data: { kind: "s", n: 4 } }] },
  { shardIndex: 0 },
);
console.log("measured without the native core:", JSON.stringify(m));
console.log("ImageCache present:", typeof ImageCache);
