export type { OutlineEntry } from "./native.js";
export { Assembly, extractPages } from "./native.js";

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
