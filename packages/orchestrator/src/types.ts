/**
 * Public contracts. Section data crosses a process boundary (structured
 * clone) and feeds content hashing (canonical JSON), so it must be plain
 * JSON-serializable data — no functions, no class instances.
 */

/** How workers load the adapter: a module specifier + optional export name. */
export interface AdapterRef {
  /** Absolute path (or resolvable specifier) of the adapter module. */
  module: string;
  /** Named export to use; defaults to `default`, then `adapter`. */
  export?: string;
  /**
   * Opaque version stamp folded into resume-cache keys. Bump it whenever the
   * adapter's output could change for the same section data (template,
   * font, or layout changes), or a stale shard cache will be reused.
   */
  version?: string;
}

export interface SectionSpec<TData = unknown> {
  id: string;
  data: TData;
  /** Scheduler packing hint; defaults to 1. Real counts come from pass 1. */
  pageEstimate?: number;
}

export interface DocumentPlan<TData = unknown> {
  adapter: AdapterRef;
  sections: SectionSpec<TData>[];
}

export interface Shard<TData = unknown> {
  index: number;
  sections: SectionSpec<TData>[];
}

/** A named position the shard exposes for cross-shard links/TOC entries. */
export interface Anchor {
  name: string;
  /** 0-based page index within the shard. */
  pageIndexInShard: number;
}

export interface MeasureResult {
  pageCount: number;
  anchors: Anchor[];
}

export interface MeasureContext {
  shardIndex: number;
}

/** Pass-2 context: everything global the renderer needs to emit correct
 * literals ("Page X of Y", TOC page numbers) at the source. */
export interface GlobalContext {
  shardIndex: number;
  /** 0-based absolute index of this shard's first page. */
  pageOffset: number;
  totalPages: number;
  /** anchor name -> 1-based absolute page number. */
  anchorPages: Record<string, number>;
  /** Where the adapter must write the complete single-shard PDF. */
  outputPath: string;
}

/**
 * The adapter contract (design spec §Adapter contract). Runs inside a worker
 * child process. Must be deterministic: pass-2 page count per shard MUST
 * equal pass-1's, or the run fails loudly.
 */
export interface RendererAdapter<TData = unknown> {
  measure(
    shard: Shard<TData>,
    ctx: MeasureContext,
  ): Promise<MeasureResult> | MeasureResult;
  render(shard: Shard<TData>, ctx: GlobalContext): Promise<void> | void;
}

export interface ProgressEvent {
  phase: "measure" | "render" | "assemble";
  shardIndex: number;
  done: number;
  total: number;
  /** True when the result came from the resume cache, not a fresh render. */
  cached: boolean;
}

/** A document bookmark whose target is an anchor name from pass 1 — the
 * orchestrator resolves it to an absolute page at assembly time. */
export interface OutlineSpec {
  title: string;
  anchor: string;
  /** Nesting depth (child = parent + 1). Default 0. */
  level?: number;
}

export interface GenerateOptions {
  outputPath: string;
  /** Bookmarks (/Outlines) for the assembled document. */
  outline?: OutlineSpec[];
  /** Shard cache + resume manifest location. Default: `<outputPath>.shardcache` */
  cacheDir?: string;
  /** Scheduler budget against pageEstimate hints. Default: 500. */
  maxPagesPerShard?: number;
  /** Concurrent worker processes. Default: min(4, availableParallelism - 1). */
  concurrency?: number;
  /** Re-attempts per shard task after a crash. Default: 1. */
  retries?: number;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  /** Keep the shard cache after success (default: removed). */
  keepCache?: boolean;
}

export interface GenerateResult {
  outputPath: string;
  totalPages: number;
  shardCount: number;
  /** Shards rendered fresh in this run. */
  renderedShards: number;
  /** Shards satisfied by the resume cache. */
  cachedShards: number;
}
