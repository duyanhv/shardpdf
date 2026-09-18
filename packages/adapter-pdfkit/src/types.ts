/**
 * Public contracts for the PDFKit adapter.
 *
 * These deliberately re-express PDFKit's types structurally rather than
 * importing `PDFKit.PDFDocument`. The adapter treats `pdfkit` as a peer
 * dependency and never imports it: the host application owns the version, the
 * fonts, and the document options. That also keeps `@types/pdfkit` from
 * leaking into consumers' type resolution.
 */

/** The subset of a PDFKit document this package relies on. */
export interface PdfDocument {
  openImage(src: Buffer | string): PdfImage;
  addPage(options?: unknown): PdfDocument;
  end(): void;
  pipe<T>(destination: T): T;
  on(event: string, listener: (...args: unknown[]) => void): PdfDocument;
  once(event: string, listener: (...args: unknown[]) => void): PdfDocument;
  /** Present once the first page exists; used to detect the implicit page. */
  page?: unknown;
}

/** An opaque PDFKit image handle from `openImage()`, embedded once per document. */
export interface PdfImage {
  width: number;
  height: number;
}

export interface ImageCacheStats {
  /** Distinct images opened. The output's image-XObject count should match. */
  distinct: number;
  /** Requests served from the cache. */
  hits: number;
  /** Requests that had to rasterize. */
  misses: number;
}

/**
 * The image-cache surface a `draw()` callback sees. Structural rather than the
 * concrete class, so `types.ts` stays dependency-free and drawing code can be
 * unit-tested against a stub.
 */
export interface ImageCacheLike {
  /**
   * Returns a reusable image handle for `key`, rasterizing only on first use.
   * `key` must capture every input the image depends on.
   */
  get(key: string, rasterize: () => Buffer | Uint8Array): PdfImage;
  stats(): ImageCacheStats;
}

/**
 * What a page-producing callback receives. `pageIndexInShard` is 0-based
 * within this shard; `absolutePageNumber` is 1-based across the whole
 * document and is the value to print for "Page X of Y".
 */
export interface PageContext {
  pageIndexInShard: number;
  absolutePageNumber: number;
  totalPages: number;
  /** anchor name -> 1-based absolute page number, for TOC literals. */
  anchorPages: Record<string, number>;
  /** Per-document deduplicating image cache. */
  images: ImageCacheLike;
}

/**
 * A section template: how many pages a section occupies, what it anchors, and
 * how to draw it.
 *
 * `pages` and `anchors` are what pass 1 (measure) calls; `draw` is what pass 2
 * (render) calls. The split is the whole point of the two-pass protocol —
 * measurement must be cheap and must not require drawing, and both passes must
 * agree on the page count or the orchestrator fails the run with
 * `DeterminismError`.
 */
export interface SectionTemplate<TData> {
  /**
   * Page count for this section, computed WITHOUT drawing. Must be
   * deterministic for the same data: pass 2 re-renders against this number.
   */
  pages(data: TData, sectionId: string): number;
  /**
   * Anchor names this section exposes, with page indices relative to the
   * section's own first page. Optional: sections nothing links to need none.
   */
  anchors?(data: TData, sectionId: string): readonly SectionAnchor[];
  /**
   * Draws one page of the section. Called `pages()` times, with
   * `pageIndexInSection` running 0..pages-1. The page already exists; do not
   * call `addPage()`.
   */
  draw(
    doc: PdfDocument,
    data: TData,
    page: SectionPageContext,
    sectionId: string,
  ): void;
}

export interface SectionAnchor {
  name: string;
  /** 0-based page index relative to this section's first page. Default 0. */
  pageIndexInSection?: number;
}

export interface SectionPageContext extends PageContext {
  /** 0-based page index within this section. */
  pageIndexInSection: number;
  /** Total pages in this section. */
  pagesInSection: number;
}

/** Discriminates section data so the adapter can pick a template. */
export type SectionKindOf<TData> = (data: TData) => string;

export interface PdfkitAdapterOptions<TData> {
  /**
   * Creates the document for one shard. Called once per shard, in a worker
   * process. Register fonts here.
   *
   * Two options are forced regardless of what this returns, because the
   * adapter's memory contract depends on them: `bufferPages` must stay false
   * (buffering defeats streaming), and the document must not be reused across
   * shards.
   */
  createDocument(): PdfDocument;
  /** Maps section data to a template key. */
  kindOf: SectionKindOf<TData>;
  /** Templates by kind. A section whose kind has no template fails loudly. */
  templates: Record<string, SectionTemplate<TData>>;
}
