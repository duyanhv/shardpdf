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

Author adapters through `defineAdapter<TData>()` — it types the section-data
contract at the definition site (the process boundary otherwise erases it)
and rejects malformed adapters immediately:

```ts
import { defineAdapter } from "@shardpdf/orchestrator";
export const adapter = defineAdapter<MySectionData>({
  measure(shard) { /* ... */ },
  render(shard, ctx) { /* ... */ },
});
```

A plan whose `adapter.module` cannot be resolved fails in the parent with
`AdapterResolutionError` before any worker spawns. Worker retries surface as
`phase: "retry"` progress events, and errors thrown inside workers keep their
original `name` across the process boundary.


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

The cache cannot see inside your adapter. Set `adapter.version` to any string
that changes whenever the adapter's output could change for the same section
data (template, font, or layout edits); it is folded into every cache key.
Without it, a resumed run after an adapter change will silently reuse stale
shards.

### Sharing a cache directory

Within one process, any number of `generate()` calls may share a cache
directory (the default `<outputPath>.shardcache` is shared whenever two calls
target the same output). Manifest writes are serialized and merged, rendered
shards are promoted atomically, and cleanup is reference counted: a run that
finishes with `keepCache` unset only marks the directory for removal, and it
is deleted when the last run using it closes.

Across processes none of that coordination exists. Two processes writing the
same manifest at the same instant can lose one entry (cost: a redundant
re-render on the next resume, never a wrong document), and a process that
finishes with `keepCache` unset can delete shards another process still needs
(that run fails with `SHARDPDF_IO`). If separate processes must share a cache
directory, pass `keepCache: true` in every process and clean up externally, or
give each process its own `cacheDir`.

## Tests

- `bun run --cwd packages/orchestrator test` — 20 tests incl. end-to-end
  multi-shard generation, cross-shard link integrity, resume, determinism
  enforcement, abort, cache invalidation on adapter version.
- `bun run --cwd packages/orchestrator soak` — the memory-boundedness
  invariant: tripling document size must not grow orchestrator peak RSS
  (measured: 88MB @ 1,000 pages vs 90MB @ 3,000 pages).

## Subpath exports

`defineAdapter` and the public types are also reachable without loading the
assembler:

| Import | Contents | Loads the native core? |
| --- | --- | --- |
| `@shardpdf/orchestrator` | everything, including `generate()` | yes |
| `@shardpdf/orchestrator/adapter` | `defineAdapter` | no |
| `@shardpdf/orchestrator/types` | the public types | no |

Adapter packages should use the deep paths. The barrel re-exports `generate()`,
which imports `@shardpdf/core` and therefore a platform `.node` binary, so
importing it would make merely *authoring* an adapter require a native build.
`@shardpdf/adapter-pdfkit` does this, and its consumer smoke test asserts the
property by deleting `@shardpdf/core` and authoring an adapter anyway.
