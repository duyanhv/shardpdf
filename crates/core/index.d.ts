export type { OutlineEntry, ValidationReport } from "./native.js";

/** Stable machine-readable error codes. Branch on these, never on message text. */
export type ShardPdfErrorCode =
  | "PDF_PARSE"
  | "IO"
  | "MALFORMED_SHARD"
  | "DUPLICATE_DESTINATION"
  | "INVALID_RANGE"
  | "DANGLING_DESTINATION"
  | "ALREADY_FINALIZED"
  | (string & {});

export declare class ShardPdfError extends Error {
  readonly name: "ShardPdfError";
  readonly code: ShardPdfErrorCode;
}

export interface AssembleOutlineEntry {
  title: string;
  /** 0-based absolute page index in the assembled document. */
  pageIndex: number;
  /** Nesting depth; defaults to 0. */
  level?: number;
}

export interface AssembleOptions {
  /** Complete, already-rendered PDF shards in append order. */
  shards: string[];
  /** Final path; data is atomically promoted here only after finalization. */
  outputPath: string;
  outline?: AssembleOutlineEntry[];
  /** Observed before every shard and before finalization. */
  signal?: AbortSignal;
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

export interface ExtractRange {
  /** 1-based, inclusive. */
  startPage: number;
  /** 1-based, inclusive. */
  endPage: number;
  output: string;
}

export interface ExtractOptions {
  input: string;
  ranges: ExtractRange[];
  /** Observed before every range. */
  signal?: AbortSignal;
}

export interface ExtractResult {
  sourcePageCount: number;
  ranges: { output: string; pageCount: number }[];
}

/**
 * Slice page ranges out of a PDF, parsing the source exactly once. On error
 * or cancellation every slice written by this call is removed.
 */
export declare function extract(
  options: ExtractOptions,
): Promise<ExtractResult>;

/**
 * Single-range convenience with the qpdf argument shape (sync; blocks the
 * calling thread). Prefer `extract` for multiple ranges.
 */
export declare function extractPages(
  inputPath: string,
  startPage: number,
  endPage: number,
  outputPath: string,
): number;

/** Parses the document and returns its page count (sync). */
export declare function pageCount(inputPath: string): number;

/**
 * Structural validation (sync): parses, resolves every page, and verifies
 * every named destination targets a live page — the corruption qpdf --check
 * misses. Throws ShardPdfError (e.g. DANGLING_DESTINATION) on failure.
 */
export declare function validate(
  inputPath: string,
): import("./native.js").ValidationReport;

/** Streaming multi-shard assembly (low-level; prefer `assemble`). Sync calls. */
export declare class Assembly {
  constructor(outputPath: string);
  /** Appends one complete single-shard PDF; returns its page count. */
  appendShard(shardPath: string): number;
  /** Total pages appended so far. */
  get pageCount(): number;
  /** Closes the partial output without finalizing it. Consumed. */
  abort(): void;
  /** Writes the assembled document, with optional bookmarks. Consumed. */
  finalize(outline?: AssembleOutlineEntry[]): void;
}

/** Parses a source once; serves many page-range extractions (low-level, sync). */
export declare class Extractor {
  constructor(inputPath: string);
  /** Total pages in the source. */
  get pageCount(): number;
  /** Extracts one inclusive, 1-based range; returns the slice's page count. */
  extractRange(startPage: number, endPage: number, outputPath: string): number;
}
