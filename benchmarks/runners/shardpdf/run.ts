/**
 * shardpdf runner: identical sharded pdfkit rendering to the merge runner,
 * but bound with @shardpdf/core (Rust, lopdf) instead of pdf-merger-js.
 * The claims under test: cross-shard named destinations survive the bind
 * (linkCheck=pass where pdf-merger-js fails), and the bind's working set is
 * one shard — the core streams every shard object to disk as it is parsed.
 * Whole-runner RSS is dominated by the JS side (layout precompute + pdfkit
 * rendering); see docs/benchmarks for the isolated bind-only measurement.
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
