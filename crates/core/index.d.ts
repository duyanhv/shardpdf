export type { BuildInfo, LoadOptions, OutlineEntry } from "./native.js";
export {
  Assembly,
  buildInfo,
  extractPages,
  extractSelection,
  extractSelectionAsync,
  pageCount,
  pageCountAsync,
} from "./native.js";

/**
 * Stable `error.code` values thrown by the native binding. Branch on these
 * rather than on message text.
 *
 * This union covers native errors only. The JavaScript facade additionally
 * throws plain `TypeError`/`RangeError` for argument validation, `AbortError`
 * (`DOMException`) for cancellation, and ordinary Node filesystem errors
 * (`ENOENT`, `EACCES`, ...) from its own rename/stat/cleanup steps.
 */
export type ShardPdfErrorCode =
  /** The input exists but could not be parsed as a PDF. */
  | "SHARDPDF_PDF_PARSE"
  /** Filesystem failure: input missing/unreadable or output unwritable. */
  | "SHARDPDF_IO"
  /** An input PDF parsed but violates a structural expectation. */
  | "SHARDPDF_MALFORMED"
  /** Method called on an assembly already consumed by finalize()/abort(). */
  | "SHARDPDF_CONSUMED"
  /**
   * An argument had the wrong type, was an empty path, or was out of range.
   * Includes every caller-supplied outline problem (shape, level jump, page
   * index past the document) and every page-selection problem.
   */
  | "SHARDPDF_INVALID_ARG"
  /**
   * An unwinding panic inside the native core was caught at the boundary.
   * Process-aborting failures (stack overflow, allocator OOM abort) are not
   * catchable and still terminate the host.
   */
  | "SHARDPDF_PANIC";

export interface ShardPdfError extends Error {
  code: ShardPdfErrorCode;
}

export interface AssembleOutlineEntry {
  title: string;
  /** 0-based absolute page index in the assembled document. */
  pageIndex: number;
  /** Nesting depth; defaults to 0. */
  level?: number;
}

export interface AssembleShardInfo {
  /** Position in `shards`. */
  index: number;
  path: string;
  /** Pages contributed by this shard. */
  pageCount: number;
  /** Running total after this shard. */
  totalPages: number;
}

export interface AssembleOptions {
  /** Complete, already-rendered PDF shards in append order. */
  shards: string[];
  /** Final path; data is atomically promoted here only after finalization. */
  outputPath: string;
  outline?: AssembleOutlineEntry[];
  /** Observed before every shard and before finalization. */
  signal?: AbortSignal;
  /**
   * Called after each successful append. Throwing aborts the assembly and
   * removes the partial output.
   */
  onShard?: (info: AssembleShardInfo) => void;
  /**
   * Bound on how far any one compressed stream may inflate while a shard is
   * parsed. Unneeded for shards you rendered yourself; set it when untrusted
   * files can reach this call. See `LoadOptions`.
   */
  maxDecompressedBytes?: number;
}

export interface AssembleResult {
  pageCount: number;
}

/**
 * Assemble already-rendered PDF shards with a one-shard native working set.
 * Partial output is closed and removed after any error or cancellation.
 */
export declare function assemble(
  input: AssembleOptions,
): Promise<AssembleResult>;

// ---------------------------------------------------------------------------
// Operation facade: merge / extract / getPageCount
//
// These run their native work off the JavaScript thread (napi async tasks on
// the libuv threadpool), so the event loop stays live while a document is
// parsed or written. The synchronous natives (`pageCount`,
// `extractSelection`, `extractPages`, `Assembly#appendShard` and friends)
// stay exported for hosts that already isolate work in a child process.
// ---------------------------------------------------------------------------

/**
 * A PDF to read: a filesystem path, a `file:` URL, or the document bytes.
 * `Buffer` is accepted through its `Uint8Array` inheritance. Any other URL
 * scheme is rejected with a `TypeError`; download remote content in the host.
 */
export type PDFSource = string | URL | Uint8Array;

/** A file to write: a filesystem path or a `file:` URL. */
export type PDFFile = string | URL;

/**
 * One bookmark in the output outline. `children` express nesting directly;
 * the facade flattens them into the native preorder list.
 */
export interface PDFOutlineEntry {
  title: string;
  /** Zero-based page index in the output document. */
  pageIndex: number;
  children?: readonly PDFOutlineEntry[];
}

export interface PDFProgress {
  operation: "merge" | "extract";
  /** Input files completed for merge; selected pages completed for extract. */
  completed: number;
  total: number;
  /** Cumulative output pages so far. */
  pageCount: number;
}

export interface PDFOptions {
  /**
   * Cancellation input. Checked before each input (merge), before the native
   * call (extract), and again before the output is published. Each native
   * task runs on the libuv threadpool and cannot be interrupted: a task
   * already in flight completes before the signal is observed at the next
   * checkpoint. This is not a hard time or memory limit.
   */
  signal?: AbortSignal;
  /**
   * Extension beyond the base contract: bound on how far any one compressed
   * stream may inflate while a document is parsed. Unneeded for files you
   * rendered yourself; set it when untrusted input can reach these calls.
   * See `LoadOptions`.
   */
  maxDecompressedBytes?: number;
}

export interface PDFWriteOptions extends PDFOptions {
  /**
   * Called synchronously on the caller's thread as work completes. Throwing
   * rejects the operation before publication and removes the partial output.
   */
  onProgress?: (event: PDFProgress) => void;
}

export interface PDFResult {
  pageCount: number;
  /** Size of the published output file, from `fs.stat`. */
  byteLength: number;
}

export interface PDFMergeResult extends PDFResult {
  /** Per-input page counts and where each input starts in the output. */
  inputs: readonly {
    pageCount: number;
    startPageIndex: number;
  }[];
}

export interface PDFMergeOptions extends PDFWriteOptions {
  /**
   * Explicit output outline. Source bookmarks, forms, tags, signatures, and
   * arbitrary document metadata are not merged.
   */
  outline?: readonly PDFOutlineEntry[];
}

export type PDFPageSelection =
  /** Zero-based indices, in requested output order. Duplicates are rejected. */
  | readonly number[]
  /** Zero-based, end-exclusive: `0 <= start < end <= sourcePageCount`. */
  | { start: number; end: number };

export interface PDFExtractOptions extends PDFWriteOptions {
  pages: PDFPageSelection;
  /**
   * Required acknowledgement of the first release's extraction limitation.
   * Extraction drops ALL annotations (links, form widgets, every `/Annots`
   * entry), named destinations, and outlines. Omitting the option or passing
   * any other value throws a `TypeError`.
   */
  annotations: "drop";
}

/**
 * Merge complete PDF documents, in order, into `output`.
 *
 * Writes a unique sibling temporary file and renames it into place after the
 * native writer finalizes, so errors and cancellation leave an existing
 * `output` untouched. `onProgress` fires after each input.
 *
 * Errors: native failures carry a `ShardPdfErrorCode`; argument problems are
 * `TypeError`/`RangeError`; cancellation is an `AbortError`; the facade's own
 * filesystem steps (rename, stat, cleanup) surface plain Node errors.
 */
export declare function merge(
  inputs: readonly PDFSource[],
  output: PDFFile,
  options?: PDFMergeOptions,
): Promise<PDFMergeResult>;

/**
 * Extract a page selection from `input` into `output`.
 *
 * The source is parsed once for the whole selection; an array preserves its
 * order in the output. Selections must be non-empty, finite integers within
 * `0..pageCount-1`, without duplicates. Same atomic publication and error
 * classes as `merge`. `onProgress` fires once, after the selection is written.
 */
export declare function extract(
  input: PDFSource,
  output: PDFFile,
  options: PDFExtractOptions,
): Promise<PDFResult>;

/**
 * Number of pages in `input`. Errors follow the same classes as `merge`.
 */
export declare function getPageCount(
  input: PDFSource,
  options?: PDFOptions,
): Promise<number>;
