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

interface ManifestData {
  version: 1;
  measures: Record<string, MeasureResult>;
  renders: Record<string, { file: string; pageCount: number }>;
}

/**
 * Resume manifest + shard file cache. Keys are content hashes of everything
 * the result depends on; the manifest is rewritten (atomic rename) after
 * every completed shard so a crashed run resumes instead of restarting
 * (design spec §Workers, errors, resume).
 */
export class ShardCache {
  readonly dir: string;
  private readonly manifestPath: string;
  private data: ManifestData = { version: 1, measures: {}, renders: {} };
  private persistCounter = 0;

  constructor(dir: string) {
    this.dir = dir;
    this.manifestPath = path.join(dir, "manifest.json");
  }

  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(
        await readFile(this.manifestPath, "utf8"),
      ) as ManifestData;
      if (raw.version === 1) this.data = raw;
    } catch {
      // no manifest yet (or unreadable) — start fresh
    }
  }

  getMeasure(key: string): MeasureResult | undefined {
    return this.data.measures[key];
  }

  async putMeasure(key: string, result: MeasureResult): Promise<void> {
    this.data.measures[key] = result;
    await this.persist();
  }

  /** Returns the cached shard PDF path if present and readable. */
  async getRender(
    key: string,
  ): Promise<{ file: string; pageCount: number } | undefined> {
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

  renderPath(key: string): string {
    return path.join(this.dir, `shard-${key.slice(0, 24)}.pdf`);
  }

  async putRender(key: string, pageCount: number): Promise<void> {
    this.data.renders[key] = { file: this.renderPath(key), pageCount };
    await this.persist();
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private async persist(): Promise<void> {
    // Unique tmp per call: concurrent persists must not race on one tmp file.
    // Atomic-replace semantics make last-writer-wins safe (data is cumulative).
    const tmp = `${this.manifestPath}.${process.pid}.${this.persistCounter++}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data));
    await rename(tmp, this.manifestPath);
  }
}
