import type { ScaleName } from "../workload/data.ts";

export type BindEngine = "qpdf" | "shardpdf";
export type BindMode = "merge" | "outline" | "extract";

/** A selective-download slice: inclusive, 1-based — the qpdf convention and
 * the shape Floor-style backends request from a cached full report. */
export interface BindExtractRange {
  name: string;
  startPage: number;
  endPage: number;
}

export interface BindOutlineEntry {
  title: string;
  /** 0-based absolute page index. */
  pageIndex: number;
  level: number;
}

export interface BindFixtureManifest {
  version: 1;
  /** Stable, filename-safe fixture identifier. */
  name: string;
  /** Present only for the built-in canonical workload. */
  scale?: ScaleName;
  /** Planning hint used to create the fixture, when chunks use a fixed cap. */
  shardPages?: number;
  totalPages: number;
  /** Paths relative to the manifest directory. */
  shards: string[];
  outline: BindOutlineEntry[];
  /** Required for extract mode; sliced from a pre-bound source.pdf. */
  extractRanges?: BindExtractRange[];
}

export interface BindRunnerReport {
  pageCount: number;
  /** Extract mode: per-range timings, in manifest order. */
  ranges?: { name: string; wallMs: number; pageCount: number }[];
}
