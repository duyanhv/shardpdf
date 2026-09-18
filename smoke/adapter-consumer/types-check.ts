/** Compile-only check of every documented public export. */

import type {
  ImageCacheLike,
  ImageCacheStats,
  PageContext,
  PdfDocument,
  PdfImage,
  PdfkitAdapterOptions,
  SectionAnchor,
  SectionKindOf,
  SectionPageContext,
  SectionTemplate,
} from "@shardpdf/adapter-pdfkit";
import {
  createPdfkitAdapter,
  ImageCache,
  InvalidPageCountError,
  UnknownSectionKindError,
} from "@shardpdf/adapter-pdfkit";

interface S {
  kind: "a";
}

// Every exported type is nameable and structurally usable.
const template: SectionTemplate<S> = {
  pages: () => 1,
  anchors: (): readonly SectionAnchor[] => [{ name: "x" }],
  draw: (_doc: PdfDocument, _data: S, page: SectionPageContext) => {
    const stats: ImageCacheStats = page.images.stats();
    const cache: ImageCacheLike = page.images;
    const img: PdfImage = cache.get("k", () => Buffer.alloc(1));
    void stats.distinct;
    void img.width;
    // Documented page fields.
    const ctx: PageContext = page;
    void ctx.absolutePageNumber;
    void ctx.totalPages;
    void ctx.anchorPages;
  },
};

const kindOf: SectionKindOf<S> = (d) => d.kind;
const options: PdfkitAdapterOptions<S> = {
  createDocument: () => ({}) as PdfDocument,
  kindOf,
  templates: { a: template },
};
void createPdfkitAdapter(options);
void ImageCache;
void InvalidPageCountError;
void UnknownSectionKindError;
