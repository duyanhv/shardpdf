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
 * One write chain per manifest path, shared by every ShardCache instance in
 * this process. Two `generate()` calls on the same cache dir then persist
 * strictly one after another, each merging the other's entries.
 */
const persistChains = new Map<string, Promise<void>>();

/**
 * Resume manifest + shard file cache. Keys are content hashes of everything
 * the result depends on; the manifest is rewritten (atomic rename) after
 * every completed shard so a crashed run resumes instead of restarting
 * (design spec §Workers, errors, resume).
 *
 * Concurrency model: several `generate()` calls may share a cache directory.
 * Every persist re-reads the on-disk manifest, merges this instance's entries
 * into it, and replaces it atomically through a uniquely named temp file.
 * Within one process, persists to the same manifest are serialized across
 * all instances, so no stale snapshot can overwrite a newer one.
 *
 * Across processes there is no lock: two processes that read, merge, and
 * rename at the same instant can lose one entry. The cost is a redundant
 * re-render of that shard on the next resume, never a wrong document, since
 * entries are idempotent and shard files are only recorded once complete.
 * A cross-process lock is deliberately out of scope for this layer; the
 * pluggable cache backend planned in the design spec is the place for it.
 *
 * Shard PDFs are written to a temp path and renamed into place, so a reader
 * that finds `renderPath(key)` on disk always sees a complete file.
 */
export class ShardCache {
  readonly dir: string;
  private readonly manifestPath: string;
  private data: ManifestData = emptyManifest();

  constructor(dir: string) {
    this.dir = dir;
    this.manifestPath = path.join(dir, "manifest.json");
  }

  async open(): Promise<void> {
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

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private persist(): Promise<void> {
    const previous = persistChains.get(this.manifestPath) ?? Promise.resolve();
    const run = previous.then(() => this.persistNow());
    // Keep the chain alive even if one persist fails.
    persistChains.set(
      this.manifestPath,
      run.catch(() => {}),
    );
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
