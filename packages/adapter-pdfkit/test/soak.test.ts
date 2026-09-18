/**
 * Soak test for the PDFKit adapter: the memory promise, with a failing test.
 *
 * Measures the whole process tree. The adapter runs inside forked workers, so
 * a parent-only sampler would be blind to exactly the regressions this is for.
 *
 * Two invariants that only show up at scale, and that the functional tests in
 * `adapter.test.ts` cannot see because they render a few hundred pages:
 *
 * 1. **Boundedness.** Tripling the document must not meaningfully grow the
 *    process tree's peak RSS. The adapter renders out-of-process and the Rust
 *    core streams, so the working set is one shard.
 *
 *    What this does and does not catch, established by mutation rather than
 *    assumed. Two deliberate leaks were injected into the adapter's render
 *    loop and NEITHER failed this test:
 *
 *      - 64 KB retained per page in a local array: bounded by
 *        `maxPagesPerShard` to one shard's worth (400 x 64 KB = 25 MB),
 *        however long the document is.
 *      - 64 KB pushed into a MODULE-LEVEL array: also bounded, because
 *        `pool.ts` forks a fresh worker per task and `worker.ts` calls
 *        `process.exit(0)` after one reply. Module state dies with the shard.
 *
 *    That is the architecture doing its job, and it is worth stating plainly:
 *    adapter-side retention cannot produce an unbounded working set, because
 *    nothing adapter-side outlives a single shard. What this test still
 *    genuinely covers is everything on the PARENT side of that boundary —
 *    the scheduler, the manifest, the anchor map, and the Rust assembler's
 *    streaming append — where retention really would scale with the document.
 *    The tree-wide sampler is what makes that coverage honest, since a
 *    parent-only sampler would not even see the worker peaks.
 *
 * 2. **The image cache holds at scale.** `ImageCache` is per document, so a
 *    long run must still embed one XObject per distinct image per shard, not
 *    per page. A cache that silently degraded (say, a key collision or a
 *    lifetime bug) would show up as a growing file and a growing XObject
 *    count, both of which are asserted here against the actual output.
 *
 * Gated behind SOAK=1: it renders thousands of real PDFKit pages.
 *
 * The sampler is a separate process on purpose. An in-process `setInterval`
 * cannot fire while a synchronous native call holds the event loop, so it
 * observes the troughs between appends and misses exactly the peaks this test
 * exists to bound. (Same reasoning as the orchestrator's soak test, which this
 * mirrors deliberately.)
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DocumentPlan } from "@shardpdf/orchestrator";
import { generate } from "@shardpdf/orchestrator";
import { readRasterizeLog } from "./fixtures/gauge.ts";
import type { FixtureSection } from "./fixtures/templates.ts";

const execFileP = promisify(execFile);
const RUN = process.env.SOAK === "1";
const ADAPTER_PATH = fileURLToPath(
  new URL("./fixtures/templates.ts", import.meta.url),
);

const workDir = RUN
  ? await mkdtemp(path.join(tmpdir(), "shardpdf-adapter-soak-"))
  : "";
after(() => (RUN ? rm(workDir, { recursive: true, force: true }) : undefined));

/** `sections` gauge sections of `pagesEach` pages, over 6 distinct gauges. */
function planOf(
  sections: number,
  pagesEach: number,
): DocumentPlan<FixtureSection> {
  const grades = Array.from({ length: pagesEach }, (_unused, i) => i % 6);
  return {
    adapter: { module: ADAPTER_PATH, export: "adapter", version: "soak-1" },
    sections: Array.from({ length: sections }, (_unused, i) => ({
      id: `u${i}`,
      data: { kind: "gauges" as const, grades },
      pageEstimate: pagesEach,
    })),
  };
}

const SAMPLER_PATH = fileURLToPath(
  new URL("./fixtures/tree-rss-sampler.mjs", import.meta.url),
);

async function peakRssDuring(
  run: () => Promise<unknown>,
): Promise<{ peak: number; samples: number }> {
  const sampler = spawn(process.execPath, [SAMPLER_PATH, String(process.pid)], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  sampler.stdout.on("data", (chunk) => {
    out += chunk;
  });
  const exited = new Promise<void>((resolve) =>
    sampler.on("exit", () => resolve()),
  );
  await new Promise((r) => setTimeout(r, 50));
  try {
    await run();
  } finally {
    sampler.stdin.end();
    await exited;
  }
  assert.ok(
    out.length > 0,
    "sampler produced no output; it probably failed to start",
  );
  const parsed = JSON.parse(out) as { peak: number; samples: number };
  assert.ok(parsed.samples > 10, `sampler took only ${parsed.samples} samples`);
  return parsed;
}

async function imageObjectCount(pdfPath: string): Promise<number> {
  const { stdout } = await execFileP(
    "qpdf",
    ["--qdf", "--object-streams=disable", pdfPath, "-"],
    { maxBuffer: 1 << 28 },
  );
  return (stdout.match(/\/Subtype \/Image/g) ?? []).length;
}

const toMb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(0);

test("peak RSS is bounded by shard size, not document size", {
  skip: !RUN,
}, async () => {
  const shardBudget = 400;

  // 1,000 pages: 10 sections x 100.
  const small = await peakRssDuring(() =>
    generate(planOf(10, 100), {
      outputPath: path.join(workDir, "small.pdf"),
      maxPagesPerShard: shardBudget,
    }),
  );

  // 3,000 pages: same shard budget, 3x the document.
  const large = await peakRssDuring(() =>
    generate(planOf(30, 100), {
      outputPath: path.join(workDir, "large.pdf"),
      maxPagesPerShard: shardBudget,
    }),
  );

  console.log(
    `adapter soak: 1,000 pages peak=${toMb(small.peak)}MB (${small.samples} samples) — ` +
      `3,000 pages peak=${toMb(large.peak)}MB (${large.samples} samples)`,
  );
  assert.ok(
    large.peak < small.peak * 1.5,
    `3x document grew peak RSS ${toMb(small.peak)}MB -> ${toMb(large.peak)}MB (>1.5x): ` +
      "the adapter is retaining something per page",
  );
});

test("the image cache still holds over thousands of pages", {
  skip: !RUN,
}, async (t) => {
  process.env.ADAPTER_TEST_RASTERIZE_LOG = path.join(
    workDir,
    "soak.rasterize.log",
  );
  const outputPath = path.join(workDir, "cache-scale.pdf");

  // 3,000 pages over 6 distinct gauges, 400 pages per shard.
  const result = await generate(planOf(30, 100), {
    outputPath,
    maxPagesPerShard: 400,
  });

  assert.equal(result.totalPages, 3000);

  // Per-shard caches: 6 distinct gauges x however many shards, never 3,000.
  const log = readRasterizeLog();
  const ceiling = result.shardCount * 6;
  assert.equal(
    log.total,
    ceiling,
    `expected ${result.shardCount} shards x 6 gauges = ${ceiling} rasterizes, got ${log.total}`,
  );

  // The output must stay small: 3,000 pages of 6 shared images.
  const { size } = await stat(outputPath);
  console.log(
    `adapter soak: 3,000 pages, ${result.shardCount} shards, ` +
      `${log.total} rasterizes, ${size} bytes`,
  );
  assert.ok(
    size < 3000 * 1024,
    `3,000 pages sharing 6 images should stay under 3MB, got ${size}`,
  );

  if (!(await qpdfAvailable())) return t.skip("qpdf not installed");
  const images = await imageObjectCount(outputPath);
  assert.ok(
    images <= ceiling,
    `expected <= ${ceiling} image XObjects across ${result.shardCount} shards, got ${images}`,
  );
});

async function qpdfAvailable(): Promise<boolean> {
  try {
    await execFileP("qpdf", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
