import type { ScaleName } from "../workload/data.ts";

/**
 * `shardpdf` drives the low-level sync `Assembly` in-process; `shardpdf-merge`
 * calls the public async `merge()` facade, which is what a host like Floor
 * Inspector would import.
 */
export type BindEngine = "qpdf" | "shardpdf" | "shardpdf-merge";
export type BindMode = "merge" | "outline";

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
}

export interface BindRunnerReport {
  pageCount: number;
}
