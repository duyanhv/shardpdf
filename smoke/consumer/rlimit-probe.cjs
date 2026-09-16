// Floor's "rlimit" limiter wraps subprocesses in `ulimit -v <capKb>; exec`.
// A native addon under a virtual-address-space cap can fail in ways a plain
// qpdf binary does not (thread stacks, mmap arenas, JIT). This probe merges
// the same 11-shard fixture the other smoke tests use, under a given cap,
// so run.sh can show the facade still works at Floor's default 768 MB.
"use strict";
const { merge } = require("@shardpdf/core");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { writePdf } = require("./fixtures.cjs");

(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rlimit-probe-"));
  try {
    const chunks = [];
    for (let i = 0; i < 11; i++) {
      const file = path.join(dir, `chunk-${i}.pdf`);
      await writePdf(file, 200, `chunk ${i}`);
      chunks.push(file);
    }
    const out = path.join(dir, "merged.pdf");
    const r = await merge(chunks, out, {
      outline: chunks.map((_, i) => ({
        title: `chunk ${i}`,
        pageIndex: i * 200,
      })),
    });
    const rss = (process.memoryUsage().rss / 1048576).toFixed(0);
    console.log(`ok rlimit-probe: pages=${r.pageCount} rss=${rss}MB`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error("FAIL rlimit-probe:", e.code ?? e.message ?? e);
  process.exit(1);
});
