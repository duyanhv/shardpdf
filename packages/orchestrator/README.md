# @shardpdf/orchestrator

The TS brain (design spec §Architecture): document plan → shard scheduling →
two-pass measure/render through isolated worker processes → streaming assembly
via `@shardpdf/core`. Resume manifest, progress events, cooperative
cancellation.

```ts
import { generate } from "@shardpdf/orchestrator";

const result = await generate(
  {
    adapter: { module: "/abs/path/my-adapter.ts", export: "adapter" },
    sections: [
      { id: "toc", data: { kind: "toc" }, pageEstimate: 2 },
      { id: "ch1", data: { kind: "chapter", n: 1 }, pageEstimate: 40 },
      // …
    ],
  },
  {
    outputPath: "out/report.pdf",
    maxPagesPerShard: 400,
    outline: [
      { title: "Table of contents", anchor: "toc" },
      { title: "Chapter 1", anchor: "chapter:1" },
    ],
    onProgress: (e) => console.log(e.phase, e.done, "/", e.total),
  },
);
```

## Adapter contract

An adapter module exports a `RendererAdapter`: `measure(shard, ctx)` returns
`{ pageCount, anchors }`; `render(shard, ctx)` writes a complete single-shard
PDF to `ctx.outputPath` using the global context (`pageOffset`, `totalPages`,
`anchorPages`) so "Page X of Y" and TOC page numbers are correct at the source.
Adapters run in forked child processes: section data must be plain
JSON-serializable data, and rendering must be deterministic — a pass-2 page
count that disagrees with pass-1 fails the run (`DeterminismError`) rather than
shipping a corrupt TOC.

## Bookmarks and resume

`outline` entries target anchor names reported by the adapter in pass 1. The
orchestrator resolves them to absolute pages and the Rust core writes a PDF
`/Outlines` tree. Use `level` for nesting; levels must start at zero and may
only increase one step at a time.

Completed measures/renders are cached under content hashes of everything they
depend on (adapter ref, section data, global context) in
`<outputPath>.shardcache/`. A crashed run re-uses them; pass `keepCache: true`
to retain the cache after success.

## Tests

- `bun run --cwd packages/orchestrator test` — 19 tests incl. end-to-end
  multi-shard generation, cross-shard link integrity, resume, determinism
  enforcement, abort.
- `bun run --cwd packages/orchestrator soak` — the memory-boundedness
  invariant: tripling document size must not grow orchestrator peak RSS
  (measured: 88MB @ 1,000 pages vs 90MB @ 3,000 pages).
