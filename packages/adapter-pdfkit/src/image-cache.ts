/**
 * Deduplicating image cache — the structural fix for the cost measured in
 * `docs/audits/2026-09-18-render-in-rust-evaluation.md`.
 *
 * The problem it removes, in the words of the measurement: Floor Inspector
 * rasterizes a chart per page inside its render loop, even though the chart is
 * a pure function of a 6-valued grade and a 2-valued profile (12 possible
 * images). It then hands PDFKit a `Buffer`. PDFKit's `_imageRegistry` is keyed
 * by string *path* only, so a `Buffer` always misses the cache and embeds a
 * fresh image XObject on every page. Measured at 400 pages: 800 image objects
 * instead of 12, 345-386 MB peak RSS instead of 109-114 MB, and a 6.83 MB file
 * instead of 0.28 MB.
 *
 * Two mistakes had to combine to produce that, so this fixes both:
 *
 *   1. `get()` memoizes on a caller-supplied key, so the expensive rasterize
 *      callback runs at most once per distinct image.
 *   2. It returns a PDFKit image *handle* from `doc.openImage()`, not a
 *      `Buffer`. Handles are embedded once and reused by reference, so the
 *      output holds one XObject per distinct image regardless of page count.
 *
 * Returning a handle rather than bytes is deliberate: it makes the pdfkit
 * dedupe failure mode unreachable, because there is no `Buffer` for a caller
 * to pass repeatedly.
 */

import type { ImageCacheStats, PdfDocument, PdfImage } from "./types.ts";

/**
 * Per-document image cache. Lives exactly as long as the document it belongs
 * to: PDFKit image handles embed into one specific document and must never be
 * shared across documents (or across shards, which are separate documents).
 */
export class ImageCache {
  private readonly entries = new Map<string, PdfImage>();
  private readonly doc: PdfDocument;
  private hits = 0;
  private misses = 0;

  constructor(doc: PdfDocument) {
    this.doc = doc;
  }

  /**
   * Returns a reusable image handle for `key`, calling `rasterize` only on the
   * first request for that key.
   *
   * `key` must capture everything the image depends on. For Floor's gauge that
   * is `` `gauge:${grade}:${profile}` ``. A key that omits an input silently
   * returns the wrong picture, so this is the one thing a caller must get
   * right; it is validated as a non-empty string.
   *
   * `rasterize` returns the encoded image bytes (PNG or JPEG). Prefer JPEG for
   * opaque images: PDFKit byte-passes JPEG but fully decodes alpha PNGs, worth
   * 320 MB vs 204 MB peak across 300 pages in the same audit.
   */
  get(key: string, rasterize: () => Buffer | Uint8Array): PdfImage {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("image cache key must be a non-empty string");
    }

    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.hits++;
      return cached;
    }

    const bytes = rasterize();
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(
        `rasterize() for image "${key}" must return a Buffer or Uint8Array, got ${typeof bytes}`,
      );
    }

    // openImage() parses the bytes and returns a handle. Embedding happens once,
    // on first use; later pages reference the same XObject.
    const image = this.doc.openImage(
      bytes instanceof Buffer ? bytes : Buffer.from(bytes),
    );
    this.entries.set(key, image);
    this.misses++;
    return image;
  }

  /**
   * Cache accounting, for the assertion that distinguishes a working dedupe
   * from a broken one. `distinct` is the number of image XObjects the output
   * should hold; if it tracks page count, the cache is not being used.
   */
  stats(): ImageCacheStats {
    return {
      distinct: this.entries.size,
      hits: this.hits,
      misses: this.misses,
    };
  }
}
