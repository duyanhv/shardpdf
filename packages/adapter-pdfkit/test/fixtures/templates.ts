/**
 * A realistic template set for the adapter tests, shaped like the workload the
 * audit measured: a TOC whose page literals must be correct, body sections
 * with per-page footers, and a chart image that is a pure function of a
 * small-cardinality key (Floor Inspector's gauge, whose whole output space is
 * 12 images).
 *
 * `rasterizeCount` records how many times the expensive rasterize callback
 * actually ran, which is what proves the dedupe works rather than merely
 * claiming it.
 */

import { createRequire } from "node:module";
import { createPdfkitAdapter } from "../../src/adapter.ts";
import type { PdfDocument, SectionTemplate } from "../../src/types.ts";
import { rasterizeCountPath, rasterizeGauge } from "./gauge.ts";

// These fixtures are ESM, so there is no ambient `require`. A host app would
// simply `import PDFDocument from "pdfkit"`; this keeps the import lazy so it
// happens inside the worker process that actually renders.
const requirePdfkit = createRequire(import.meta.url);

export interface FixtureSection {
  kind: "body" | "toc" | "gauges";
  /** body: page count. gauges: one page per unit. */
  pages?: number;
  /** toc: section ids to list with resolved absolute page numbers. */
  refs?: string[];
  /** gauges: the grade for each unit page; cardinality is deliberately low. */
  grades?: number[];
}

// Typed as the structural PdfDocument plus the drawing calls the fixtures use.
type Doc = PdfDocument & {
  font(name: string): Doc;
  fontSize(size: number): Doc;
  text(text: string, x?: number, y?: number, options?: unknown): Doc;
  image(src: unknown, x?: number, y?: number, options?: unknown): Doc;
};

const body: SectionTemplate<FixtureSection> = {
  pages: (data) => data.pages ?? 1,
  anchors: (_data, sectionId) => [{ name: `sec:${sectionId}` }],
  draw(doc, _data, page, sectionId) {
    const d = doc as Doc;
    d.font("Helvetica").fontSize(12);
    d.text(`Section ${sectionId}`, 40, 40);
    // The literal the two-pass protocol exists to make correct.
    d.text(`Page ${page.absolutePageNumber} of ${page.totalPages}`, 40, 760, {
      lineBreak: false,
    });
  },
};

const toc: SectionTemplate<FixtureSection> = {
  pages: () => 1,
  anchors: () => [{ name: "toc" }],
  draw(doc, data, page) {
    const d = doc as Doc;
    d.font("Helvetica").fontSize(12);
    d.text("Table of contents", 40, 40);
    let y = 70;
    for (const ref of data.refs ?? []) {
      // Resolved from pass 1: impossible in a single pass.
      const target = page.anchorPages[`sec:${ref}`];
      d.text(`${ref} .... ${target ?? "?"}`, 40, y);
      y += 18;
    }
    d.text(`Page ${page.absolutePageNumber} of ${page.totalPages}`, 40, 760, {
      lineBreak: false,
    });
  },
};

/**
 * One page per unit, each embedding a gauge chart. Many pages, few distinct
 * images — exactly the shape that produced 800 XObjects for 400 pages in
 * Floor Inspector.
 */
const gauges: SectionTemplate<FixtureSection> = {
  pages: (data) => data.grades?.length ?? 1,
  anchors: (_data, sectionId) => [{ name: `sec:${sectionId}` }],
  draw(doc, data, page, sectionId) {
    const d = doc as Doc;
    const grade = data.grades?.[page.pageIndexInSection] ?? 0;

    d.font("Helvetica").fontSize(12);
    d.text(`Unit ${page.pageIndexInSection + 1} (${sectionId})`, 40, 40);

    // The key captures every input the image depends on. Because get() hands
    // back an embedded handle, the same grade cannot produce a second XObject.
    const image = page.images.get(`gauge:${grade}`, () =>
      rasterizeGauge(grade),
    );
    d.image(image, 40, 80, { width: 200 });

    d.text(`Page ${page.absolutePageNumber} of ${page.totalPages}`, 40, 760, {
      lineBreak: false,
    });
  },
};

export { rasterizeCountPath };

export const adapter = createPdfkitAdapter<FixtureSection>({
  createDocument: () => {
    const PDFDocument = requirePdfkit("pdfkit") as new (
      options?: unknown,
    ) => PdfDocument;
    return new PDFDocument({ size: "A4", bufferPages: false });
  },
  kindOf: (data) => data.kind,
  templates: { body, toc, gauges },
});
