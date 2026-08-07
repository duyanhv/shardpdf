/**
 * The shard-and-merge workaround: render 400-page shards with pdfkit (each
 * bounded), then bind them with pdf-merger-js. This is what teams reach for
 * today. Measured outcome: on this text-only, standard-font workload (the
 * merge tool's best case — nothing embedded, tiny shards) memory survives the
 * 2 GiB cap, but pdf-merger-js silently drops the named-destination tree, so
 * every cross-shard TOC link in the output is dead. wrong-output, not oom.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import PDFMerger from "pdf-merger-js";
import { runnerMain } from "../../harness/protocol.ts";
import { generateWorkload } from "../../workload/data.ts";
import { layoutDocument } from "../../workload/layout.ts";
import { renderPagesWithPdfkit } from "../pdfkit/render.ts";

const SHARD_PAGES = 400;

runnerMain(async (scale, outPath) => {
  const layout = layoutDocument(generateWorkload(scale));
  const shardDir = await mkdtemp(path.join(tmpdir(), "shardpdf-bench-"));

  try {
    // Phase 1: render shards sequentially — memory stays bounded here.
    const shardPaths: string[] = [];
    for (let start = 0; start < layout.pages.length; start += SHARD_PAGES) {
      const shardPath = path.join(shardDir, `shard-${shardPaths.length}.pdf`);
      await renderPagesWithPdfkit(
        layout.pages.slice(start, start + SHARD_PAGES),
        start,
        layout,
        shardPath,
      );
      shardPaths.push(shardPath);
    }

    // Phase 2: bind. This is where the workaround's memory promise breaks.
    const merger = new PDFMerger();
    for (const shardPath of shardPaths) {
      await merger.add(shardPath);
    }
    await merger.save(outPath);
    return layout.totalPages;
  } finally {
    await rm(shardDir, { recursive: true, force: true });
  }
});
