import { rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { assemble } from "@shardpdf/core";
import { DeterminismError, DuplicateAnchorError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import { ShardCache } from "./manifest.ts";
import { WorkerPool } from "./pool.ts";
import { partition } from "./scheduler.ts";
import type {
  AdapterRef,
  DocumentPlan,
  GenerateOptions,
  GenerateResult,
  GlobalContext,
  MeasureResult,
  ProgressEvent,
  Shard,
} from "./types.ts";

/**
 * Two-pass generation (design spec §Two-pass protocol):
 *
 *  1. measure — every shard reports { pageCount, anchors } from an isolated
 *     worker; results are cached in the resume manifest.
 *  2. render  — every shard renders with the global context (page offset,
 *     total pages, anchor→page map), so cross-shard literals are correct at
 *     the source. Outputs land in the shard cache.
 *  3. assemble — @shardpdf/core streams the shards into one PDF. The page
 *     count it reports per shard MUST match pass 1 (determinism contract).
 */
export async function generate<TData>(
  plan: DocumentPlan<TData>,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const signal = options.signal;
  signal?.throwIfAborted();

  const adapter: AdapterRef = {
    module: isAbsolute(plan.adapter.module)
      ? plan.adapter.module
      : resolvePath(plan.adapter.module),
    ...(plan.adapter.export !== undefined && { export: plan.adapter.export }),
    ...(plan.adapter.version !== undefined && {
      version: plan.adapter.version,
    }),
  };
  const shards = partition(
    { ...plan, adapter },
    options.maxPagesPerShard ?? 500,
  );
  if (shards.length === 0) {
    throw new RangeError("plan has no sections");
  }

  const cache = new ShardCache(
    options.cacheDir ?? `${options.outputPath}.shardcache`,
  );
  await cache.open();

  const pool = new WorkerPool({
    concurrency:
      options.concurrency ??
      Math.min(4, Math.max(1, availableParallelism() - 1)),
    retries: options.retries ?? 1,
    ...(signal !== undefined && { signal }),
  });

  const emit = (event: ProgressEvent): void => options.onProgress?.(event);

  try {
    // Pass 1 — measure (cache-aware, all shards concurrent under the pool cap).
    let measured = 0;
    const measures = await Promise.all(
      shards.map(async (shard): Promise<MeasureResult> => {
        const key = measureKey(adapter, shard);
        const cachedResult = cache.getMeasure(key);
        const result =
          cachedResult ??
          ((await pool.run({
            kind: "measure",
            adapter,
            shard: shard as Shard,
            ctx: { shardIndex: shard.index },
          })) as MeasureResult);
        if (cachedResult === undefined) await cache.putMeasure(key, result);
        measured++;
        emit({
          phase: "measure",
          shardIndex: shard.index,
          done: measured,
          total: shards.length,
          cached: cachedResult !== undefined,
        });
        return result;
      }),
    );

    // Global context: offsets, totals, anchor map (1-based page numbers).
    const pageOffsets: number[] = [];
    let totalPages = 0;
    for (const measure of measures) {
      pageOffsets.push(totalPages);
      totalPages += measure.pageCount;
    }
    const anchorPages: Record<string, number> = {};
    const anchorOwner = new Map<string, number>();
    measures.forEach((measure, shardIndex) => {
      const offset = pageOffsets[shardIndex] ?? 0;
      for (const anchor of measure.anchors) {
        const owner = anchorOwner.get(anchor.name);
        if (owner !== undefined) {
          throw new DuplicateAnchorError(anchor.name, owner, shardIndex);
        }
        anchorOwner.set(anchor.name, shardIndex);
        anchorPages[anchor.name] = offset + anchor.pageIndexInShard + 1;
      }
    });

    // Resolve anchor-referenced bookmarks now, before the expensive render
    // pass: a typo in the outline should fail in milliseconds, not minutes.
    const outlineEntries = options.outline?.map((spec) => {
      const page = anchorPages[spec.anchor];
      if (page === undefined) {
        throw new Error(
          `outline entry "${spec.title}" references unknown anchor "${spec.anchor}"`,
        );
      }
      return {
        title: spec.title,
        pageIndex: page - 1,
        level: spec.level ?? 0,
      };
    });

    // Pass 2 — render with global context (cache-aware).
    let rendered = 0;
    let renderedFresh = 0;
    const shardFiles = await Promise.all(
      shards.map(async (shard): Promise<string> => {
        const ctx: Omit<GlobalContext, "outputPath"> = {
          shardIndex: shard.index,
          pageOffset: pageOffsets[shard.index] ?? 0,
          totalPages,
          anchorPages,
        };
        const key = renderKey(adapter, shard, ctx);
        const cachedRender = await cache.getRender(key);
        let file: string;
        if (cachedRender !== undefined) {
          file = cachedRender.file;
        } else {
          // Render into a unique temp file and promote it only when the
          // worker has finished: a crash mid-render leaves no half-written
          // shard at the cache path for a resumed run to trip over, and two
          // runs rendering the same key never write to the same file.
          const tempFile = cache.renderTempPath(key);
          try {
            await pool.run({
              kind: "render",
              adapter,
              shard: shard as Shard,
              ctx: { ...ctx, outputPath: tempFile },
            });
            file = await cache.commitRender(
              key,
              tempFile,
              measures[shard.index]?.pageCount ?? 0,
            );
          } finally {
            await rm(tempFile, { force: true });
          }
          renderedFresh++;
        }
        rendered++;
        emit({
          phase: "render",
          shardIndex: shard.index,
          done: rendered,
          total: shards.length,
          cached: cachedRender !== undefined,
        });
        return file;
      }),
    );

    // Assemble through the core's atomic wrapper (unique partial path, cleanup
    // on every failure path) and enforce the determinism contract per shard.
    await assemble({
      shards: shardFiles,
      outputPath: options.outputPath,
      ...(outlineEntries !== undefined && { outline: outlineEntries }),
      ...(signal !== undefined && { signal }),
      onShard: ({ index, pageCount }) => {
        const shard = shards[index];
        const expected = measures[index]?.pageCount;
        if (shard === undefined || expected === undefined) {
          throw new Error(`unreachable: no measurement for shard ${index}`);
        }
        if (pageCount !== expected) {
          throw new DeterminismError(shard.index, expected, pageCount);
        }
        emit({
          phase: "assemble",
          shardIndex: shard.index,
          done: index + 1,
          total: shards.length,
          cached: false,
        });
      },
    });

    if (options.keepCache !== true) {
      await cache.destroy();
    }

    return {
      outputPath: options.outputPath,
      totalPages,
      shardCount: shards.length,
      renderedShards: renderedFresh,
      cachedShards: shards.length - renderedFresh,
    };
  } finally {
    pool.dispose();
  }
}

function measureKey(adapter: AdapterRef, shard: Shard<unknown>): string {
  return contentHash({
    v: 1,
    kind: "measure",
    adapter,
    sections: shard.sections,
  });
}

function renderKey(
  adapter: AdapterRef,
  shard: Shard<unknown>,
  ctx: Omit<GlobalContext, "outputPath">,
): string {
  return contentHash({
    v: 1,
    kind: "render",
    adapter,
    sections: shard.sections,
    ctx,
  });
}
