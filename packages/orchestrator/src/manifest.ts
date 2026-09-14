import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { MeasureResult } from "./types.ts";

interface RenderEntry {
  file: string;
  pageCount: number;
}

interface ManifestData {
  version: 1;
  measures: Record<string, MeasureResult>;
  renders: Record<string, RenderEntry>;
}

function emptyManifest(): ManifestData {
  return { version: 1, measures: {}, renders: {} };
}

/**
 * Per-directory state shared by every open ShardCache in this process.
 *
 * - `users`: open caches. `destroy()` removes the directory only when the
 *   last user closes; earlier callers just mark it. Without this, a short
 *   run finishing with `keepCache: false` deleted files a longer run in the
 *   same process was still reading.
 * - `pendingDestroy`: set when any user asked for cleanup; honored by
 *   whichever user closes last.
 * - `chain`: serializes manifest writes. Dropped once the last queued write
 *   settles so the registry does not grow with every directory ever seen.
 */
interface DirState {
  users: number;
  pendingDestroy: boolean;
  chain: Promise<void> | undefined;
  inFlight: number;
}

const registry = new Map<string, DirState>();

function stateFor(dir: string): DirState {
  let state = registry.get(dir);
  if (state === undefined) {
    state = { users: 0, pendingDestroy: false, chain: undefined, inFlight: 0 };
    registry.set(dir, state);
  }
  return state;
}

function maybeForget(dir: string): void {
  const state = registry.get(dir);
  if (
    state !== undefined &&
    state.users === 0 &&
    state.inFlight === 0 &&
    !state.pendingDestroy
  ) {
    registry.delete(dir);
  }
}

/** Test/diagnostic hook: number of directories the registry is tracking. */
export function trackedCacheDirs(): number {
  return registry.size;
}

/**
 * Resume manifest + shard file cache. Keys are content hashes of everything
 * the result depends on; the manifest is rewritten (atomic rename) after
 * every completed shard so a crashed run resumes instead of restarting
 * (design spec §Workers, errors, resume).
 *
 * Concurrency model, within one process: several `generate()` calls may
 * share a cache directory. Persists to the same manifest are serialized and
 * each one re-reads the on-disk manifest and merges before writing, so no
 * stale snapshot can overwrite a newer one. Cleanup is reference counted:
 * the directory is removed only when the last open cache closes with a
 * destroy request outstanding.
 *
 * Across processes there is no lock and no reference count. Two processes
 * that read, merge, and rename at the same instant can lose one entry (cost:
 * one redundant re-render on the next resume, never a wrong document), and
 * a process finishing with `keepCache: false` can delete shards another
 * process still needs (that run fails with `SHARDPDF_IO`; nothing corrupt is
 * produced). Processes sharing a cache directory should pass `keepCache:
 * true` and clean up externally, or use distinct `cacheDir`s. A pluggable
 * cache backend with real locking is the design spec's answer.
 *
 * Shard PDFs are written to a temp path and renamed into place, so a reader
 * that finds `renderPath(key)` on disk always sees a complete file.
 */
export class ShardCache {
  readonly dir: string;
  private readonly manifestPath: string;
  private data: ManifestData = emptyManifest();
  private opened = false;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.manifestPath = path.join(this.dir, "manifest.json");
  }

  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    stateFor(this.dir).users++;
    await mkdir(this.dir, { recursive: true });
    this.data = await this.readDisk();
  }

  getMeasure(key: string): MeasureResult | undefined {
    return this.data.measures[key];
  }

  async putMeasure(key: string, result: MeasureResult): Promise<void> {
    this.data.measures[key] = result;
    await this.persist();
  }

  /** Returns the cached shard PDF path if present and readable. */
  async getRender(key: string): Promise<RenderEntry | undefined> {
    const entry = this.data.renders[key];
    if (entry === undefined) return undefined;
    try {
      await access(entry.file);
      return entry;
    } catch {
      delete this.data.renders[key];
      return undefined;
    }
  }

  /** Final location of a rendered shard. Only complete files live here. */
  renderPath(key: string): string {
    return path.join(this.dir, `shard-${key.slice(0, 24)}.pdf`);
  }

  /**
   * Where a worker should write a shard it is currently rendering. Unique
   * per call so two runs rendering the same key never share a file.
   */
  renderTempPath(key: string): string {
    return `${this.renderPath(key)}.${process.pid}-${randomUUID()}.tmp`;
  }

  /** Promotes a completed temp render to its final path and records it. */
  async commitRender(
    key: string,
    tempFile: string,
    pageCount: number,
  ): Promise<string> {
    const file = this.renderPath(key);
    await rename(tempFile, file);
    this.data.renders[key] = { file, pageCount };
    await this.persist();
    return file;
  }

  /**
   * Releases this cache's hold on the directory. With `destroy`, requests
   * removal; the directory is actually deleted only when the last open
   * cache in this process closes and some closer asked for removal.
   */
  async close(options: { destroy: boolean }): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    const state = stateFor(this.dir);
    state.users--;
    if (options.destroy) state.pendingDestroy = true;
    if (state.users === 0 && state.pendingDestroy) {
      // Let any queued manifest write finish before removing its directory.
      if (state.chain !== undefined) await state.chain.catch(() => {});
      state.pendingDestroy = false;
      await rm(this.dir, { recursive: true, force: true });
    }
    maybeForget(this.dir);
  }

  /** Close and remove the directory (subject to other open users). */
  destroy(): Promise<void> {
    return this.close({ destroy: true });
  }

  private persist(): Promise<void> {
    const state = stateFor(this.dir);
    const previous = state.chain ?? Promise.resolve();
    state.inFlight++;
    const run = previous.then(() => this.persistNow());
    const settled = run.then(
      () => {},
      () => {},
    );
    state.chain = settled;
    void settled.then(() => {
      state.inFlight--;
      if (state.inFlight === 0 && state.chain === settled) {
        state.chain = undefined;
        maybeForget(this.dir);
      }
    });
    return run;
  }

  private async persistNow(): Promise<void> {
    const onDisk = await this.readDisk();
    const merged: ManifestData = {
      version: 1,
      measures: { ...onDisk.measures, ...this.data.measures },
      renders: { ...onDisk.renders, ...this.data.renders },
    };
    this.data = merged;
    const tmp = `${this.manifestPath}.${process.pid}-${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(merged));
    await rename(tmp, this.manifestPath);
  }

  private async readDisk(): Promise<ManifestData> {
    try {
      const raw = JSON.parse(
        await readFile(this.manifestPath, "utf8"),
      ) as ManifestData;
      if (raw.version === 1) return raw;
    } catch {
      // no manifest yet (or unreadable) — start fresh
    }
    return emptyManifest();
  }
}
