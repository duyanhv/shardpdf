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
import { spawn } from "node:child_process";
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

/** Runs in a separate Node process: polls `ps` for the parent's RSS every
 * few ms and prints the maximum when stdin closes. Being a separate process
 * it keeps sampling while the parent is inside a synchronous native call. */
const SAMPLER_SOURCE = `
const { execFileSync } = require("node:child_process");
const pid = process.argv[1];
let peak = 0, samples = 0;
const tick = () => {
  try {
    const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", pid]).toString().trim()) * 1024;
    if (rss > peak) peak = rss;
    samples++;
  } catch {}
};
const iv = setInterval(tick, 2);
process.stdin.on("end", () => { clearInterval(iv); tick(); process.stdout.write(JSON.stringify({ peak, samples })); process.exit(0); });
process.stdin.resume();
`;

/**
 * Peak RSS of this process while `run` executes, measured by a separate
 * sampler process.
 *
 * An in-process `setInterval` cannot fire while a synchronous native call
 * (`appendShard`) holds the event loop, so it only observes the troughs
 * between appends and misses exactly the peaks this test exists to bound.
 * An external process has no such blind spot.
 */
async function peakRssDuring(
  run: () => Promise<unknown>,
): Promise<{ peak: number; samples: number }> {
  const sampler = spawn(
    process.execPath,
    ["-e", SAMPLER_SOURCE, String(process.pid)],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  let out = "";
  sampler.stdout.on("data", (chunk) => {
    out += chunk;
  });
  const exited = new Promise<void>((resolve) =>
    sampler.on("exit", () => resolve()),
  );
  // Let the sampler take a baseline before work starts.
  await new Promise((r) => setTimeout(r, 50));
  try {
    await run();
  } finally {
    sampler.stdin.end();
    await exited;
  }
  const parsed = JSON.parse(out) as { peak: number; samples: number };
  assert.ok(parsed.samples > 10, `sampler took only ${parsed.samples} samples`);
  return parsed;
}

test("peak RSS is bounded by shard size, not document size", {
  skip: !RUN,
}, async () => {
  const shardBudget = 400;

  const small = await peakRssDuring(() =>
    generate(planOf(10, 100), {
      outputPath: path.join(workDir, "small.pdf"),
      maxPagesPerShard: shardBudget,
    }),
  ); // 1,000 pages

  const large = await peakRssDuring(() =>
    generate(planOf(30, 100), {
      outputPath: path.join(workDir, "large.pdf"),
      maxPagesPerShard: shardBudget,
    }),
  ); // 3,000 pages

  const smallPeak = small.peak;
  const largePeak = large.peak;
  const toMb = (b: number): string => (b / 1024 / 1024).toFixed(0);
  console.log(
    `soak (external sampler): 1,000 pages peak=${toMb(smallPeak)}MB (${small.samples} samples) — 3,000 pages peak=${toMb(largePeak)}MB (${large.samples} samples)`,
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
