import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DeterminismError } from "../src/errors.ts";
import { generate } from "../src/generate.ts";
import type { DocumentPlan, ProgressEvent } from "../src/types.ts";
import type { TestSection } from "./fixtures/test-adapter.ts";

const execFileP = promisify(execFile);
const ADAPTER_PATH = fileURLToPath(
  new URL("./fixtures/test-adapter.ts", import.meta.url),
);
const LYING_ADAPTER_PATH = fileURLToPath(
  new URL("./fixtures/lying-adapter.ts", import.meta.url),
);

const workDir = await mkdtemp(path.join(tmpdir(), "shardpdf-orch-test-"));
after(() => rm(workDir, { recursive: true, force: true }));

/** 3 body sections + a TOC that references all of them; page estimates force
 * multiple shards, so the TOC's links are genuinely cross-shard. */
function testPlan(): DocumentPlan<TestSection> {
  return {
    adapter: { module: ADAPTER_PATH, export: "adapter" },
    sections: [
      {
        id: "toc",
        data: { kind: "toc", refs: ["a", "b", "c"] },
        pageEstimate: 1,
      },
      { id: "a", data: { kind: "body", pages: 3 }, pageEstimate: 3 },
      { id: "b", data: { kind: "body", pages: 4 }, pageEstimate: 4 },
      { id: "c", data: { kind: "body", pages: 2 }, pageEstimate: 2 },
    ],
  };
}

async function qpdfAvailable(): Promise<boolean> {
  try {
    await execFileP("qpdf", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

test("generates a multi-shard document end to end", async () => {
  const outputPath = path.join(workDir, "e2e.pdf");
  const events: ProgressEvent[] = [];
  const result = await generate(testPlan(), {
    outputPath,
    maxPagesPerShard: 4, // → shards: [toc+a], [b], [c]
    concurrency: 2,
    onProgress: (e) => events.push(e),
  });

  assert.equal(result.totalPages, 10);
  assert.equal(result.shardCount, 3);
  assert.equal(result.renderedShards, 3);
  assert.equal(result.cachedShards, 0);
  assert.ok((await stat(outputPath)).size > 0);

  assert.equal(events.filter((e) => e.phase === "measure").length, 3);
  assert.equal(events.filter((e) => e.phase === "render").length, 3);
  assert.equal(events.filter((e) => e.phase === "assemble").length, 3);

  if (await qpdfAvailable()) {
    await execFileP("qpdf", ["--check", outputPath]); // throws on failure
    const { stdout } = await execFileP("qpdf", ["--show-npages", outputPath]);
    assert.equal(Number(stdout.trim()), 10);
  }
});

test("cross-shard links resolve to defined named destinations", async (t) => {
  if (!(await qpdfAvailable())) return t.skip("qpdf not installed");
  const outputPath = path.join(workDir, "links.pdf");
  await generate(testPlan(), { outputPath, maxPagesPerShard: 4 });

  const qdfPath = `${outputPath}.qdf`;
  await execFileP("qpdf", [
    "--qdf",
    "--object-streams=disable",
    outputPath,
    qdfPath,
  ]);
  const text = await import("node:fs/promises").then((fs) =>
    fs.readFile(qdfPath, "latin1"),
  );
  const referenced = new Set<string>();
  const defined = new Set<string>();
  for (const chunk of text.split("endobj")) {
    if (chunk.includes("/S /GoTo")) {
      for (const m of chunk.matchAll(/\/D \(([^)]*)\)/g)) {
        if (m[1] !== undefined) referenced.add(m[1]);
      }
    }
    if (/\/(?:Names|Limits) \[/.test(chunk)) {
      for (const m of chunk.matchAll(/\(([^)]*)\)/g)) {
        if (m[1] !== undefined) defined.add(m[1]);
      }
    }
  }
  assert.equal(referenced.size, 3, "TOC links present");
  for (const name of referenced) {
    assert.ok(defined.has(name), `destination ${name} must be defined`);
  }
});

test("a crashed run resumes from the shard cache", async () => {
  const outputPath = path.join(workDir, "resume.pdf");
  const cacheDir = path.join(workDir, "resume-cache");

  const first = await generate(testPlan(), {
    outputPath,
    cacheDir,
    maxPagesPerShard: 4,
    keepCache: true,
  });
  assert.equal(first.renderedShards, 3);

  await rm(outputPath); // simulate: run died before/at delivery
  const second = await generate(testPlan(), {
    outputPath,
    cacheDir,
    maxPagesPerShard: 4,
    keepCache: true,
  });
  assert.equal(second.renderedShards, 0, "no re-render on resume");
  assert.equal(second.cachedShards, 3);
  assert.equal(second.totalPages, 10);
  assert.ok((await stat(outputPath)).size > 0);
});

test("a non-deterministic adapter fails loudly and ships nothing", async () => {
  const outputPath = path.join(workDir, "lying.pdf");
  const plan = testPlan();
  plan.adapter = { module: LYING_ADAPTER_PATH, export: "adapter" };

  await assert.rejects(
    generate(plan, { outputPath, maxPagesPerShard: 4 }),
    DeterminismError,
  );
  await assert.rejects(stat(outputPath), "no partial output may exist");
});

test("duplicate anchors across shards are rejected", async () => {
  const plan = testPlan();
  plan.sections.push({
    id: "a", // same id → same `sec:a` anchor in another shard
    data: { kind: "body", pages: 1 },
    pageEstimate: 1,
  });
  await assert.rejects(
    generate(plan, {
      outputPath: path.join(workDir, "dup.pdf"),
      maxPagesPerShard: 4,
    }),
    /anchor "sec:a"/,
  );
});

test("an aborted signal stops the run", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generate(testPlan(), {
      outputPath: path.join(workDir, "aborted.pdf"),
      signal: controller.signal,
    }),
    (err: Error) => err.name === "AbortError",
  );
});
