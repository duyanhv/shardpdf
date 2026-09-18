/**
 * PDFKit adapter for the two-pass orchestrator.
 *
 * Why this is a PDFKit-*hosting* adapter and not a Rust renderer: see
 * `docs/audits/2026-09-18-render-in-rust-evaluation.md`. Briefly, PDFKit's own
 * marginal cost is already 0.04-0.09 MB/page and falling, while the drawing API
 * is latency-bound (measured: 713 calls/page, 452 of them blocking text
 * measurements whose results feed the next draw position). A napi round trip
 * costs 885 ns against a 3,056 ns `widthOfString`, so moving drawing across the
 * boundary spends ~29% of the cost it would remove before shaping a glyph.
 * Rust earns its place in assembly, where one coarse call amortizes across
 * thousands of pages.
 *
 * What this adapter adds over calling PDFKit directly:
 *
 *  - **Two-pass correctness.** Page counts come from `pages()` in pass 1, so
 *    pass 2 can print real "Page X of Y" literals and TOC page numbers. The
 *    orchestrator enforces that the two passes agree.
 *  - **Structural image dedupe.** Every `draw()` gets an `ImageCache` that
 *    returns embedded handles rather than bytes, which makes the measured
 *    Floor Inspector failure mode (800 image XObjects for 400 pages) not
 *    expressible.
 *  - **Streaming discipline.** Documents are created per shard, `bufferPages`
 *    is never enabled, and the write stream is awaited so a shard file is
 *    complete before the orchestrator appends it.
 */

import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
// Deliberately the deep path, not the "@shardpdf/orchestrator" barrel: the
// barrel re-exports generate(), which imports @shardpdf/core and therefore the
// native binary. `defineAdapter` is a dependency-free shape check, so going
// through the barrel would make merely *authoring* an adapter require a
// platform build of the Rust core. Verified by the consumer smoke test, which
// loads the adapter with @shardpdf/core absent.
import { defineAdapter } from "@shardpdf/orchestrator/adapter";
import type {
  GlobalContext,
  MeasureResult,
  RendererAdapter,
  Shard,
} from "@shardpdf/orchestrator/types";
import { ImageCache } from "./image-cache.ts";
import type { PdfkitAdapterOptions, SectionTemplate } from "./types.ts";

/** Thrown when a section's kind has no registered template. */
export class UnknownSectionKindError extends Error {
  override readonly name = "UnknownSectionKindError";
  readonly code = "ADAPTER_UNKNOWN_SECTION_KIND";
  constructor(kind: string, sectionId: string, known: readonly string[]) {
    super(
      `section "${sectionId}" has kind "${kind}", which has no template ` +
        `(known kinds: ${known.length > 0 ? known.join(", ") : "none"})`,
    );
  }
}

/** Thrown when a template reports a page count that cannot be rendered. */
export class InvalidPageCountError extends Error {
  override readonly name = "InvalidPageCountError";
  readonly code = "ADAPTER_INVALID_PAGE_COUNT";
  constructor(sectionId: string, value: unknown) {
    super(
      `template for section "${sectionId}" returned page count ${String(value)}; ` +
        "expected a positive integer",
    );
  }
}

function resolveTemplate<TData>(
  options: PdfkitAdapterOptions<TData>,
  data: TData,
  sectionId: string,
): SectionTemplate<TData> {
  const kind = options.kindOf(data);
  const template = options.templates[kind];
  if (template === undefined) {
    throw new UnknownSectionKindError(
      kind,
      sectionId,
      Object.keys(options.templates),
    );
  }
  return template;
}

function sectionPageCount<TData>(
  template: SectionTemplate<TData>,
  data: TData,
  sectionId: string,
): number {
  const pages = template.pages(data, sectionId);
  if (!Number.isInteger(pages) || pages < 1) {
    throw new InvalidPageCountError(sectionId, pages);
  }
  return pages;
}

/**
 * Builds a `RendererAdapter` that renders through PDFKit.
 *
 * The returned adapter must be exported from a module the orchestrator can
 * resolve, because workers load it by module specifier in a child process:
 *
 * ```ts
 * // my-adapter.ts
 * export const adapter = createPdfkitAdapter<MySection>({
 *   createDocument: () => new PDFDocument({ size: "A4", bufferPages: false }),
 *   kindOf: (data) => data.kind,
 *   templates: { body: bodyTemplate, toc: tocTemplate },
 * });
 * ```
 *
 * Set `adapter.version` on the plan's `AdapterRef` whenever a template's
 * output could change for the same data, or a resumed run will reuse stale
 * shards.
 */
export function createPdfkitAdapter<TData>(
  options: PdfkitAdapterOptions<TData>,
): RendererAdapter<TData> {
  if (typeof options?.createDocument !== "function") {
    throw new TypeError("createDocument must be a function");
  }
  if (typeof options?.kindOf !== "function") {
    throw new TypeError("kindOf must be a function");
  }
  if (options?.templates === null || typeof options?.templates !== "object") {
    throw new TypeError("templates must be an object of section templates");
  }

  return defineAdapter<TData>({
    /**
     * Pass 1: page counts and anchors, without drawing. This is the cheap
     * measurement path the design spec asks adapters to provide — no
     * throwaway render, so measuring a 12,000-page document costs arithmetic.
     */
    measure(shard: Shard<TData>): MeasureResult {
      let pageCount = 0;
      const anchors: MeasureResult["anchors"] = [];

      for (const section of shard.sections) {
        const template = resolveTemplate(options, section.data, section.id);
        const pages = sectionPageCount(template, section.data, section.id);

        for (const anchor of template.anchors?.(section.data, section.id) ??
          []) {
          const offset = anchor.pageIndexInSection ?? 0;
          if (!Number.isInteger(offset) || offset < 0 || offset >= pages) {
            throw new RangeError(
              `anchor "${anchor.name}" in section "${section.id}" targets page ` +
                `${offset} of a ${pages}-page section`,
            );
          }
          anchors.push({
            name: anchor.name,
            pageIndexInShard: pageCount + offset,
          });
        }

        pageCount += pages;
      }

      return { pageCount, anchors };
    },

    /**
     * Pass 2: draw every page of every section into one complete shard PDF,
     * with the global page numbers and anchor map available to each page.
     */
    async render(shard: Shard<TData>, ctx: GlobalContext): Promise<void> {
      const doc = options.createDocument();
      const images = new ImageCache(doc);
      const out = createWriteStream(ctx.outputPath);

      // Surface stream errors (ENOSPC, EACCES) as a rejection rather than an
      // unhandled 'error' event, and make sure a failed render never leaves a
      // half-written shard that looks complete to the assembler.
      const streamClosed = finished(out);
      doc.pipe(out);

      try {
        // PDFKit creates the first page implicitly. The first section must use
        // it; every later page starts a fresh one. Getting this wrong yields a
        // blank leading page, which would also break the determinism check.
        let pageStarted = false;
        let pageIndexInShard = 0;

        for (const section of shard.sections) {
          const template = resolveTemplate(options, section.data, section.id);
          const pagesInSection = sectionPageCount(
            template,
            section.data,
            section.id,
          );

          for (let i = 0; i < pagesInSection; i++) {
            if (pageStarted) {
              doc.addPage();
            } else {
              pageStarted = true;
            }

            template.draw(
              doc,
              section.data,
              {
                pageIndexInSection: i,
                pagesInSection,
                pageIndexInShard,
                absolutePageNumber: ctx.pageOffset + pageIndexInShard + 1,
                totalPages: ctx.totalPages,
                anchorPages: ctx.anchorPages,
                images,
              },
              section.id,
            );

            pageIndexInShard++;
          }
        }

        doc.end();
        await streamClosed;
      } catch (error) {
        // Tear down the stream so the partial file is closed; the orchestrator
        // treats a failed render as a failed task and never appends it.
        out.destroy();
        await streamClosed.catch(() => {});
        throw error;
      }
    },
  });
}
