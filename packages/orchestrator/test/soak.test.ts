/**
 * Soak test (design spec §Testing strategy): "the memory promise has a
 * failing test." The invariant under test is boundedness, not a magic
 * number: tripling the document size must NOT grow the orchestrator
 * process's peak RSS meaningfully, because its working set is one shard
 * (workers render out-of-process; the Rust assembler streams).
 *
 * Gated behind SOAK=1 — renders thousands of real pdfkit pages.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate } from "../src/generate.ts";
import type { DocumentPlan } from "../src/types.ts";
import type { TestSection } from "./fixtures/test-adapter.ts";

const RUN = process.env.SOAK === "1";
const ADAPTER_PATH = fileURLToPath(
  new URL("./fixtures/test-adapter.ts", import.meta.url),
);

const workDir = RUN ? await mkdtemp(path.join(tmpdir(), "shardpdf-soak-")) : "";
after(() => (RUN ? rm(workDir, { recursive: true, force: true }) : undefined));

function planOf(
  sections: number,
  pagesEach: number,
): DocumentPlan<TestSection> {
  return {
    adapter: { module: ADAPTER_PATH, export: "adapter" },
    sections: Array.from({ length: sections }, (_, i) => ({
      id: `s${i}`,
      data: { kind: "body" as const, pages: pagesEach },
      pageEstimate: pagesEach,
    })),
  };
}

async function peakRssDuring(run: () => Promise<unknown>): Promise<number> {
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, 50);
  try {
    await run();
  } finally {
    clearInterval(sampler);
  }
  return peak;
}

test("peak RSS is bounded by shard size, not document size", {
  skip: !RUN,
}, async () => {
  const shardBudget = 400;

  const smallPeak = await peakRssDuring(() =>
    generate(planOf(10, 100), {
      outputPath: path.join(workDir, "small.pdf"),
      maxPagesPerShard: shardBudget,
    }),
  ); // 1,000 pages

  const largePeak = await peakRssDuring(() =>
    generate(planOf(30, 100), {
      outputPath: path.join(workDir, "large.pdf"),
      maxPagesPerShard: shardBudget,
    }),
  ); // 3,000 pages

  const toMb = (b: number): string => (b / 1024 / 1024).toFixed(0);
  console.log(
    `soak: 1,000 pages peak=${toMb(smallPeak)}MB — 3,000 pages peak=${toMb(largePeak)}MB`,
  );
  assert.ok(
    largePeak < smallPeak * 1.5,
    `3x document grew peak RSS ${toMb(smallPeak)}MB -> ${toMb(largePeak)}MB (>1.5x): working set is leaking past one shard`,
  );
  assert.ok(
    largePeak < 500 * 1024 * 1024,
    `absolute sanity cap: ${toMb(largePeak)}MB >= 500MB`,
  );
});
