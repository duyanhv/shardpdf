/**
 * Deterministic pdfkit adapter for orchestrator tests.
 *
 * Section data shapes:
 *  - { kind: "body", pages: n }  → n pages, each with a "Page X of Y" line
 *    using the ABSOLUTE page number; an anchor `sec:<id>` on its first page;
 *    a named destination at that anchor.
 *  - { kind: "toc", refs: [ids] } → one page listing each ref with its
 *    resolved absolute page number and a goTo link (cross-shard references).
 *
 * measure() computes counts without rendering — the cheap-measure path.
 */

import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import PDFDocument from "pdfkit";
import type {
  GlobalContext,
  MeasureResult,
  RendererAdapter,
  Shard,
} from "../../src/types.ts";

export interface TestSection {
  kind: "body" | "toc";
  pages?: number;
  refs?: string[];
}

function sectionPages(section: { data: TestSection }): number {
  return section.data.kind === "toc" ? 1 : (section.data.pages ?? 1);
}

export const adapter: RendererAdapter<TestSection> = {
  measure(shard: Shard<TestSection>): MeasureResult {
    let pageCount = 0;
    const anchors = [];
    for (const section of shard.sections) {
      if (section.data.kind === "body") {
        anchors.push({
          name: `sec:${section.id}`,
          pageIndexInShard: pageCount,
        });
      }
      pageCount += sectionPages(section);
    }
    return { pageCount, anchors };
  },

  async render(shard: Shard<TestSection>, ctx: GlobalContext): Promise<void> {
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
    const stream = createWriteStream(ctx.outputPath);
    doc.pipe(stream);

    let local = 0;
    for (const section of shard.sections) {
      for (let p = 0; p < sectionPages(section); p++) {
        doc.addPage();
        const absolute = ctx.pageOffset + local + 1;
        if (section.data.kind === "body" && p === 0) {
          doc.addNamedDestination(`sec:${section.id}`);
          doc.fontSize(14).text(`Section ${section.id}`, 72, 72);
        }
        if (section.data.kind === "toc") {
          doc.fontSize(14).text("Contents", 72, 72);
          let y = 110;
          for (const ref of section.data.refs ?? []) {
            const target = ctx.anchorPages[`sec:${ref}`];
            doc.fontSize(10).text(`${ref} ..... page ${target}`, 72, y);
            doc.goTo(72, y, 300, 14, `sec:${ref}`);
            y += 18;
          }
        }
        doc.fontSize(10).text(`Page ${absolute} of ${ctx.totalPages}`, 72, 720);
        local++;
      }
    }
    doc.end();
    await finished(stream);
  },
};
