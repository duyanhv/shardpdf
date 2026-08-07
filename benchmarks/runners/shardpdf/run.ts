/**
 * shardpdf runner: identical sharded pdfkit rendering to the merge runner,
 * but bound with @shardpdf/core (Rust, lopdf) instead of pdf-merger-js.
 * The claim under test: cross-shard named destinations survive the bind
 * (linkCheck=pass where pdf-merger-js fails).
 *
 * v0 core is correctness-first, NOT yet streaming — the output document
 * accumulates in Rust memory at bind time. Memory numbers are real but do not
 * yet represent the final O(largest shard) design.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Assembly } from "@shardpdf/core";
import { runnerMain } from "../../harness/protocol.ts";
import { generateWorkload } from "../../workload/data.ts";
import { layoutDocument } from "../../workload/layout.ts";
import { renderPagesWithPdfkit } from "../pdfkit/render.ts";

const SHARD_PAGES = 400;

runnerMain(async (scale, outPath) => {
  const layout = layoutDocument(generateWorkload(scale));
  const shardDir = await mkdtemp(path.join(tmpdir(), "shardpdf-bench-"));

  try {
    const assembly = new Assembly(outPath);
    let appended = 0;
    for (let start = 0; start < layout.pages.length; start += SHARD_PAGES) {
      const shardPath = path.join(shardDir, `shard-${start}.pdf`);
      await renderPagesWithPdfkit(
        layout.pages.slice(start, start + SHARD_PAGES),
        start,
        layout,
        shardPath,
      );
      appended += assembly.appendShard(shardPath);
      await rm(shardPath, { force: true }); // working set: one shard on disk
    }
    if (appended !== layout.totalPages) {
      throw new Error(
        `appended ${appended} pages, layout says ${layout.totalPages}`,
      );
    }
    assembly.finalize();
    return layout.totalPages;
  } finally {
    await rm(shardDir, { recursive: true, force: true });
  }
});
