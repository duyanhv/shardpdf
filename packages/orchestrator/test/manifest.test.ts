import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { ShardCache } from "../src/manifest.ts";

const workDir = await mkdtemp(path.join(tmpdir(), "shardpdf-manifest-test-"));
after(() => rm(workDir, { recursive: true, force: true }));

async function diskKeys(dir: string): Promise<string[]> {
  const raw = JSON.parse(
    await readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as { measures: Record<string, unknown> };
  return Object.keys(raw.measures).sort();
}

test("two instances persisting at once do not collide on temp files", async () => {
  const dir = path.join(workDir, "collide");
  const a = new ShardCache(dir);
  const b = new ShardCache(dir);
  await Promise.all([a.open(), b.open()]);
  const results = await Promise.allSettled([
    a.putMeasure("a", { pageCount: 1, anchors: [] }),
    b.putMeasure("b", { pageCount: 2, anchors: [] }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "fulfilled"],
  );
  assert.deepEqual(await diskKeys(dir), ["a", "b"]);
});

test("a stale in-memory snapshot cannot erase a newer entry on disk", async () => {
  const dir = path.join(workDir, "stale");
  const c = new ShardCache(dir);
  const d = new ShardCache(dir);
  await Promise.all([c.open(), d.open()]); // both start empty
  await c.putMeasure("first", { pageCount: 1, anchors: [] });
  // d never observed "first"; its write must merge, not replace.
  await d.putMeasure("second", { pageCount: 2, anchors: [] });
  assert.deepEqual(await diskKeys(dir), ["first", "second"]);
  // and d's own view was refreshed by the merge
  assert.ok(d.getMeasure("first"), "merge updated the in-memory snapshot");
});

test("persists within one instance are serialized in call order", async () => {
  const dir = path.join(workDir, "serial");
  const cache = new ShardCache(dir);
  await cache.open();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      cache.putMeasure(`k${i}`, { pageCount: i, anchors: [] }),
    ),
  );
  assert.equal((await diskKeys(dir)).length, 20);
});

test("commitRender promotes a temp file atomically and records it", async () => {
  const dir = path.join(workDir, "commit");
  const cache = new ShardCache(dir);
  await cache.open();
  const key = "abc123";
  const temp = cache.renderTempPath(key);
  assert.notEqual(temp, cache.renderPath(key));
  assert.ok(temp.startsWith(cache.renderPath(key)), "temp lives beside final");
  await writeFile(temp, "%PDF-fake");
  assert.equal(await cache.getRender(key), undefined, "nothing until commit");
  const file = await cache.commitRender(key, temp, 3);
  assert.equal(file, cache.renderPath(key));
  assert.deepEqual(await cache.getRender(key), { file, pageCount: 3 });
  assert.equal(await readFile(file, "utf8"), "%PDF-fake");
});

test("renderTempPath is unique per call", () => {
  const cache = new ShardCache(path.join(workDir, "unique"));
  assert.notEqual(cache.renderTempPath("k"), cache.renderTempPath("k"));
});
