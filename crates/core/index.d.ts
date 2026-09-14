export type { OutlineEntry } from "./native.js";
export { Assembly, extractPages } from "./native.js";

/**
 * Stable `error.code` values thrown by the native binding. Branch on these
 * rather than on message text.
 */
export type ShardPdfErrorCode =
  /** The input exists but could not be parsed as a PDF. */
  | "SHARDPDF_PDF_PARSE"
  /** Filesystem failure: input missing/unreadable or output unwritable. */
  | "SHARDPDF_IO"
  /** The shard parsed but violates a structural expectation. */
  | "SHARDPDF_MALFORMED"
  /** Method called on an assembly already consumed by finalize()/abort(). */
  | "SHARDPDF_CONSUMED"
  /** An argument had the wrong type, was an empty path, or was out of range. */
  | "SHARDPDF_INVALID_ARG";

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
