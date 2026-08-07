# shardpdf — Design

**Date:** 2026-08-07
**Status:** Approved design, pre-implementation
**One-liner:** Memory-bounded generation of giant PDFs in Node — sharded rendering, two-pass layout, Rust streaming assembler.

## Problem

Node has no library that generates *giant* PDFs (thousands of pages, hundreds of MB) with a
hard memory ceiling. Every popular option materialises the whole document:

- pdf-lib runs out of memory around 10k pages ([Hopding/pdf-lib#197](https://github.com/Hopding/pdf-lib/issues/197)).
- pdf-merger-js consumes multiple GB and crashes servers on large merges ([nbesli/pdf-merger-js#27](https://github.com/nbesli/pdf-merger-js/issues/27)).
- Rendering engines (Takumi, @react-pdf/renderer, Typst, Chromium print-to-PDF) each render
  one whole document in one process/instance — no isolation, no resume, no bound.

Capable memory-conscious tools exist only outside JS (pdfcpu in Go, PDFBox in Java, qpdf in C++),
and none of them solve the *generation-side* problems: cross-shard page numbering, TOC,
progress, resumability.

The gap shardpdf fills is the **production harness**: shard a document plan, render shards in
isolated workers through pluggable engines, and bind the shards into one PDF with bounded
memory.

### Prior art and why it doesn't cover this

| Project | What it is | Why it isn't this |
|---|---|---|
| Takumi | Rust→WASM JSX/HTML+Tailwind layout engine, paginated PDF output, ~26ms warm renders | Renders one whole document in one WASM instance (hard memory cap, no isolation/resume). It is the ideal *adapter*, not the harness. |
| @react-pdf/renderer | React → PDF via Yoga | Whole-document, long-standing layout bugs, no giant-doc story. Adapter candidate at best. |
| Typst | Rust typesetting engine | Whole-document compiles; community Node bindings. Adapter candidate. |
| Puppeteer/Chromium | HTML → print PDF | Heavy, slow, memory-hungry; still whole-document per page context. Parked adapter. |
| pdfkit | Imperative drawing, true streaming output | Streams natively but no layout help; the authoring pain that motivates this project. Migration adapter. |
| qpdf / pdfcpu / PDFBox | Native merge/repair CLIs | Merge only, no generation concerns, not JS. qpdf is used as a **test oracle**, never a runtime dependency. |

## Decisions (made during design, with rationale)

1. **Engine-agnostic harness, not a rendering engine.** The layout engine is 95% of the
   difficulty of "a PDF library" and that slot is already served (Takumi, Typst, Chromium).
   shardpdf owns orchestration + assembly and treats renderers as adapters.
2. **Primary workload: giant documents.** Few but huge PDFs. Streaming assembly, bounded
   memory, chunked rendering, resumability are the design center. High-throughput small-doc
   pools are out of scope for v1.
3. **Own the assembly core, in Rust via napi-rs.** The value proposition is a *hard* memory
   bound; V8 GC and Buffer copying make that promise soft in pure TS. Rust gives deterministic
   allocation and true streaming. `lopdf` provides the PDF object model, `pdf-writer` the
   low-level incremental output — the core is streaming-merge logic on proven primitives, not
   a PDF-spec implementation. napi-rs is the established pattern (swc, LightningCSS, resvg-js,
   Takumi) with mature prebuild CI templates. Same codebase can target WASM later (parked).
4. **Two-pass measure/render protocol** solves cross-shard references (page X of Y, TOC,
   outline targets) without the merger ever rewriting content.
5. **Hard boundary: the merger patches structure, never content streams.** Page tree,
   outlines, link destinations, xref — yes. Rewriting "Page 4,812" literals inside a content
   stream — never. Correct literals are the renderer's job (enabled by pass 2's global
   context). This keeps the merge core tractable permanently.

## Architecture

Monorepo, npm scope `@shardpdf/*` (claim the npm org early — placeholder publish is fine).

```
shardpdf/
  crates/core/            Rust: streaming PDF assembler (napi-rs)
  packages/orchestrator/  TS: plan, scheduler, two-pass, workers, resume, progress
  packages/adapter-takumi/   TS: flagship adapter (JSX/Tailwind authoring)
  packages/adapter-pdfkit/   TS: migration adapter for existing pdfkit codebases
  docs/specs/
```

- **TS layer = brain.** Document plan, shard scheduling, worker lifecycle, resume manifest,
  progress/cancellation, S3/disk shard cache. Everything where iteration speed and DX matter.
- **Rust layer = muscle.** A deliberately tiny napi surface, roughly:
  `createAssembly(outputPath, opts)`, `appendShard(pdfPathOrStream, patchTable)`,
  `finalize(outline, metadata)`. Byte-level work only.

### Document plan

An ordered list of **sections**, each with a data reference and an adapter binding.
The scheduler partitions sections into **shards** under a configurable memory/page budget.
Plan and section data are content-hashed for the resume manifest.

### Two-pass protocol

- **Pass 1 — measure.** Each shard renders cheaply in an isolated worker; the adapter reports
  `{ pageCount, anchors }` (anchors = named positions for TOC/links).
- **Pass 2 — render.** Shards render for real with a global context: page offset, total pages,
  anchor→page mapping. "Page 4,812 of 9,112" is rendered correctly at the source. The TOC is
  itself just a section that renders in pass 2 after all measures land.
- **Determinism is a contract, and it is enforced:** if a shard's pass-2 page count differs
  from pass-1, the run fails loudly rather than shipping a corrupt TOC.

Cheap-measure note: for fast deterministic engines (Takumi ~26ms warm) pass 1 can be a full
render with output discarded; adapters MAY implement a cheaper measure path but are not
required to.

### Rust assembly core

Sequential append with working set = one shard:

1. Parse the incoming shard PDF (lopdf), one shard at a time.
2. Renumber objects; graft pages into the growing page tree.
3. Apply the shard's patch table: link/outline destinations resolved from plan anchors.
4. Stream objects out incrementally (pdf-writer); emit xref/trailer at finalize.

**Memory ceiling is a documented formula — `O(largest shard) + O(page-tree/outline metadata)`
— asserted by a soak test, not a marketing line.** Fonts are subset per shard and NOT deduped
across shards in v1; output size bloat is the accepted trade.

### Adapter contract

```ts
interface RendererAdapter<TSectionData> {
  measure(shard: Shard<TSectionData>, ctx: MeasureContext): Promise<{ pageCount: number; anchors: Anchor[] }>;
  render(shard: Shard<TSectionData>, ctx: GlobalContext): Promise<ShardOutput>; // stream or file path
}
```

Adapters run inside worker child processes owned by the orchestrator. Requirements:
deterministic (measure/render agreement), self-contained per shard (no cross-shard state),
produce a complete valid single-shard PDF.

### Workers, errors, resume

- One child process per shard render; crash of a shard kills and restarts that shard only,
  with bounded retries.
- **Resume manifest**: completed shards recorded under `hash(plan) + hash(sectionData)` in a
  disk or S3 cache; a crashed 9,000-page run resumes instead of restarting.
- Progress events (per-shard, per-pass) and cooperative cancellation from day one.

### Testing strategy

- Rust unit tests on synthetic PDFs (object renumbering, page-tree grafting, patch tables).
- Property test: pages(merge(shards)) == Σ pages(shard); valid xref for arbitrary shard splits.
- **qpdf as CI oracle**: `qpdf --check` on every generated output + page-count
  cross-validation. Dev/CI dependency only — never shipped, never required at runtime.
- Golden-file tests for outlines/TOC/link targets.
- **Soak test**: generate a multi-thousand-page document under an asserted RSS cap. The memory
  promise has a failing test.

## Out of scope for v1 (parked, stated in the README)

- Encrypted PDFs (input or output)
- AcroForm/forms merging
- Tagged PDF / accessibility structure trees (matters for compliance eventually — parked, not ignored)
- Cross-shard font dedup (accepted output bloat)
- WASM/edge target (same Rust codebase makes it possible later)
- Chromium adapter
- High-throughput small-document pooling

## Naming

`shardpdf` — names the core mechanic (sharded rendering + binding), npm package and org free
at decision time, zero GitHub collisions. Rejected: `bookbinder` (430★ bookbinder-js is
active and PDF-adjacent), `bindpdf` (112★ macOS app), `pdfcollate`/`quirepdf` (describe only
the merge half; Getty Quire confusion).

## Risks (eyes open)

- **Merge-core correctness surface**: PDFs in the wild are messy; v1 only ever consumes PDFs
  produced by its own adapters, which shrinks the parser surface substantially. qpdf oracle
  guards regressions.
- **Native maintenance tax**: dual-language repo, prebuild matrix (darwin/linux/win ×
  x64/arm64), cross-boundary debugging. Accepted knowingly (team is comfortable in Rust).
  An unmaintained native core is worse than a slow TS core.
- **Honest v1 estimate: ~2–3 months of focused work**, dominated by the Rust core and its
  test suite, not by the TS orchestration.
