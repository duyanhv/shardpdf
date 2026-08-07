# shardpdf — Design and implementation plan

**Created:** 2026-08-07

**Last updated:** 2026-08-07

**Status:** Active — core and two-pass orchestrator MVP implemented; production adoption work remains

**One-liner:** Memory-bounded PDF assembly and optional giant-document generation for Node and Bun.

## Problem

Node has no cohesive library for generating giant PDFs (thousands of pages, hundreds of MB)
under a predictable memory ceiling. Popular document libraries tend to materialize too much of a
document or its layout in one process:

- pdf-lib runs out of memory around 10k pages
  ([Hopding/pdf-lib#197](https://github.com/Hopding/pdf-lib/issues/197)).
- pdf-merger-js consumes memory proportional to the complete merge and can lose cross-shard named
  destinations ([nbesli/pdf-merger-js#27](https://github.com/nbesli/pdf-merger-js/issues/27)).
- Rendering engines such as Takumi, `@react-pdf/renderer`, Typst, and Chromium normally render one
  whole document in one process or instance. They do not provide shard isolation, durable resume,
  or an end-to-end memory policy.

Memory-conscious native tools already exist. qpdf, pdfcpu, and PDFBox are mature choices for
assembly and repair. They do not, however, provide a Node-native generation harness for shard
planning, renderer isolation, global page context, resumability, progress, and cancellation.

The gap shardpdf fills has two layers:

1. A small, streaming Rust assembler that existing Node/Bun pipelines can adopt without replacing
   their queue, renderer, or storage architecture.
2. Optional TypeScript pipeline and orchestration layers for applications that do not already have
   those production controls.

The Floor Inspector backend is the reference workload. It already implements chunked PDFKit
rendering, disposable child processes, disk intermediates, BullMQ lifecycle management, qpdf
assembly, and S3 storage so that multi-thousand-page reports can run on a shared AWS `t3.small`.
That implementation proves the problem, but it also means shardpdf must integrate incrementally;
replacing its complete export pipeline would duplicate working infrastructure.

## Product boundaries

Shardpdf is three independently adoptable layers, not one mandatory framework.

| Layer | Responsibility | Adoption target |
| --- | --- | --- |
| `@shardpdf/core` | Streaming assembly, destination preservation, outlines, structural PDF operations | Existing production pipelines such as Floor Inspector |
| `@shardpdf/pipeline` | Planned reusable cache/resume, content hashing, progress, cancellation, and resource policy primitives | Applications with their own queue or workflow engine |
| `@shardpdf/orchestrator` | Batteries-included process pool, scheduler, two-pass rendering, resume, and assembly | Applications without an existing export engine |

The core is the foundation. The orchestrator is a convenience layer, not a prerequisite for using
the native assembler.

## Decisions

1. **Core-first adoption.** Prove the Rust assembler against production-generated shards before
   asking applications to adopt shardpdf's scheduler or worker model.
2. **Engine-agnostic, not a rendering engine.** Layout engines already exist. Shardpdf treats them
   as adapters and owns only the production harness and structural assembly.
3. **Primary workload: giant documents.** Few but huge PDFs are the design center. High-throughput
   small-document pooling is out of scope for v1.
4. **Own the assembly core in Rust via napi-rs.** Rust provides deterministic ownership and true
   streaming without V8 `Buffer` copies. `lopdf` supplies the object model; the shardpdf core owns
   the bounded assembly algorithm rather than implementing general-purpose PDF authoring.
5. **Support both single-pass and two-pass generation.** Existing systems that already render
   bounded shards should render them once and bind them. Two-pass measure/render is used only when
   page contents require global offsets, total pages, or cross-shard TOC literals.
6. **Patch structure, never content streams.** Page trees, outlines, named destinations, links,
   xref, and metadata are in scope. Rewriting rendered text such as `Page 4,812 of 9,112` is not.
7. **Integrate behind narrow interfaces.** Queue semantics, domain state, storage, and deployment
   policy stay with the host application. Shardpdf should not force BullMQ users to replace BullMQ.
8. **qpdf is both oracle and competitor.** It remains a development/CI validator, and it is the
   production baseline shardpdf must match for correctness and resource use. Claims based only on
   comparisons with JavaScript mergers are insufficient.

## Current implementation state

The original MVP milestones are complete on `main`:

- Rust/napi assembler with page-tree grafting and object renumbering.
- Named-destination preservation across PDFKit shards.
- Streaming writer with a one-shard working set.
- Native outline generation, including nested outline levels.
- Typed high-level `assemble()` API with atomic promotion, deterministic
  partial cleanup, and between-shard cancellation; low-level `Assembly` remains
  available and now supports explicit `abort()`.
- Two-pass TypeScript orchestrator with isolated workers.
- Disk resume manifest, progress events, cancellation, and deterministic page-count enforcement.
- RSS soak test demonstrating that orchestrator memory follows shard size rather than document size.
- Fuzz target for shard append and native prebuild CI for macOS, Linux GNU, and Windows on x64/arm64.
- Reproducible synthetic benchmarks against pdf-lib, React PDF, PDFKit, and pdf-merger-js.

Still unproven or unimplemented:

- Head-to-head qpdf assembly and outline benchmarks on constrained Linux and a
  real `t3.small`. The local Apple Silicon bind-only baseline is now recorded.
- A sanitized production export and second-validator visual parity. A
  self-contained production-shaped PDFKit corpus is now recorded locally.
- Confirmation on a real `t3.small`; the current constrained result is a Docker simulation.
- Linux musl prebuilds and an explicit Node/Bun runtime compatibility matrix.
- A public package release and consumer installation test.
- Page-range extraction, which is required before applications such as Floor Inspector can remove
  their qpdf runtime dependency.

## Architecture

```text
shardpdf/
  crates/core/                Rust streaming PDF assembler exposed through napi-rs
  packages/pipeline/          planned host-agnostic resume/resource primitives
  packages/orchestrator/      implemented two-pass scheduler and worker pool
  packages/adapter-takumi/    planned flagship adapter
  packages/adapter-pdfkit/    planned migration adapter
  benchmarks/                 synthetic and production-corpus benchmarks
  docs/specs/                 design and implementation plan
```

### Rust assembly core

Assembly is sequential, with a working set of one input shard:

1. Parse one complete shard PDF.
2. Push inherited page attributes down where required.
3. Renumber objects and graft pages into the output page tree.
4. Preserve and remap named destinations.
5. Stream rewritten objects to the partial output and release the shard.
6. At finalization, write optional outlines, xref, and trailer.
7. Atomically promote the partial file only after successful validation by the caller.

The memory contract is:

```text
O(largest input shard) + O(page/destination/outline metadata)
```

It is not a fixed-MB promise for arbitrarily large shards. The caller still owns shard sizing and,
for untrusted or unusually large inputs, process isolation.

Fonts are subset per shard and are not deduplicated across shards in v1. The output-size increase is
an accepted trade for bounded memory and simpler correctness.

### Single-pass protocol

Single-pass is the default integration model for existing pipelines:

1. The host application plans and renders each shard once using its existing renderer and workers.
2. Each render returns its PDF path plus local page/anchor metadata.
3. The host accumulates page offsets and resolves structural outline targets.
4. `@shardpdf/core` appends the already-rendered shards and writes outlines during finalization.

This supports Floor Inspector's current model because its outlines come from per-chunk section-index
sidecars. It does not support content whose rendered text depends on a future global page count.

The planned ergonomic API is deliberately small:

```ts
interface PdfAssembler {
  assemble(input: {
    shards: string[];
    outputPath: string;
    outline?: Array<{ title: string; pageIndex: number; level?: number }>;
    signal?: AbortSignal;
  }): Promise<{ pageCount: number }>;
}
```

The low-level `Assembly` class remains available for callers that want to delete each shard
immediately after append.

### Two-pass protocol

Two-pass generation is optional and remains the correct tool when rendered content needs global
document information:

- **Pass 1 — measure.** Each shard reports `{ pageCount, anchors }` in an isolated worker.
- **Pass 2 — render.** Each shard receives its absolute page offset, total pages, and global anchor
  map. TOC page literals and `Page X of Y` are rendered correctly at the source.
- **Determinism contract.** If pass 2 produces a different page count, generation fails instead of
  shipping incorrect references.

Adapters may implement cheap measurement. A full throwaway render is permitted but must be an
explicit tradeoff; applications with expensive PDFKit layouts should not be forced into it.

### Workers and resource policy

The existing orchestrator owns a child-process pool and retries failed shard tasks. Its concurrency
must be configurable by the host. A default based only on CPU count is not sufficient for
memory-constrained production.

The reusable resource-policy target is:

```ts
interface ResourcePolicy {
  concurrency: number;
  maxWorkerRssMb?: number;
  maxAggregateWorkerRssMb?: number;
}
```

For Floor Inspector on `t3.small`, concurrency remains `1`. Four concurrent 300 MB PDFKit workers
would defeat the purpose of bounded per-shard rendering.

### Resume

Resume keys must include every input that can change bytes or pagination:

```text
snapshot/data hash
+ renderer/adapter version
+ template version
+ font version
+ locale
+ shard plan
+ global render context when using two-pass mode
```

The existing orchestrator implements a disk cache. The production-facing pipeline layer must make
the cache backend pluggable so hosts can use local disk, EBS, or S3 and apply TTL cleanup. A retry
must verify cached page counts and hashes before reuse.

## Floor Inspector reference integration

Floor Inspector should not adopt the full orchestrator first. Its implementation plan is:

1. Introduce a backend-owned `PdfAssembler` interface at the current qpdf merge seam.
2. Keep `QpdfAssembler` as the default and rollback implementation.
3. Add `ShardPdfAssembler` using `@shardpdf/core` only.
4. Convert the existing reassembled section index into shardpdf outline entries and generate the
   final PDF and outline tree in one native pass.
5. Preserve the current BullMQ queue, `listChunks -> renderChunk -> merge -> store` lifecycle,
   snapshot child, PDFKit render children, S3 upload, progress, cancellation, and concurrency `1`.
6. Shadow-run both assemblers in QA and compare outputs semantically. Do not shadow-run in normal
   production because it doubles finalization work and disk usage.
7. Canary shardpdf behind `REPORT_PDF_ASSEMBLER=qpdf|shardpdf`, with qpdf available for immediate
   rollback.
8. After assembly is proven, add durable shard resume using the report snapshot/template/font/locale
   hashes already present in the backend.
9. Keep qpdf installed until shardpdf implements and proves page-range extraction for selective
   downloads and report post-processing.

This integration is expected to improve finalization memory and remove the Node-side qpdf JSON
outline round-trip. It is not expected to materially reduce snapshot or PDFKit rendering memory;
those are separate, larger costs in the Floor pipeline.

## Testing and benchmark strategy

### Correctness

- Rust unit tests for renumbering, page-tree grafting, inherited attributes, destinations, and
  outlines.
- Property tests asserting `pages(assemble(shards)) == sum(pages(shard))` across arbitrary splits.
- Fuzzing must never panic or abort on malformed shard input.
- qpdf `--check` and page-count validation for every generated fixture in CI.
- Add a second independent validator, preferably MuPDF, so qpdf is not the sole oracle.
- Golden semantic tests for outlines, named destinations, annotations, metadata, and link targets.
- Render representative pages and pixel-compare them when testing production-shaped fixtures.

### Production-shaped corpus

Add sanitized Floor Inspector fixtures containing:

- Korean embedded/subset fonts.
- Large JPEG covers and transparent PNG overlays.
- Repeated fonts and images embedded independently in many shards.
- Nested block/unit outline trees with hundreds or thousands of entries.
- PDFKit named destinations and annotations.
- Empty, one-page, and continuation sections.
- Inherited page resources and representative crop/media boxes.

Qualify releases in Preview, Acrobat, and Chromium in addition to automated structural checks.

### Performance

Add a bind-only qpdf matrix over synthetic and Floor-shaped inputs:

| Scenario | Required measurements |
| --- | --- |
| Merge only | Peak RSS, wall time, output bytes, page count |
| Merge plus nested outlines | Peak RSS, wall time, outline target parity |
| Approximately 350, 1,000, and 9,000 pages | Resource curve at fixed shard size |
| Docker-constrained 2 GiB / 2 CPU | Survival and peak system RSS |
| Real `t3.small` | Final release evidence including CPU steal and disk behavior |

Existing pdf-merger-js results remain useful, but they do not establish superiority over qpdf.

## Implementation roadmap

### Phase 0 — foundation (complete)

- Streaming native assembler, destination preservation, outlines, fuzz target, prebuild CI.
- Two-pass orchestrator, workers, resume, progress/cancellation, and RSS soak test.

### Phase 1 — establish production truth

- Add qpdf merge and merge-plus-outline benchmark runners. **Complete locally:**
  the bind-only harness measures aggregate runner/subprocess RSS and validates
  pages, links, and outline targets over the shared 11,164-page fixture.
- Add a self-contained production-shaped PDFKit corpus. **Complete locally:** 32
  shards and 2,560 pages exercise embedded Korean fonts, JPEG/alpha-PNG images,
  repeated resources, annotations, 2,560 named links, and 354 nested outlines
  without reading or modifying the Floor Inspector repository.
- Capture a sanitized production export later, during the approved integration
  phase, and compare representative page renders with a second validator.
- Run the benchmark matrix under Docker constraints and on a real `t3.small`.
- Record native core RSS separately from renderer/layout RSS.

Exit gate: shardpdf matches qpdf's structural correctness on the complete corpus and its resource
claims are backed by a direct qpdf comparison.

### Phase 2 — harden the core for consumers

- Add an ergonomic single-pass `assemble` API while retaining incremental
  append. **Complete locally.**
- Guarantee partial-file cleanup and atomic final-file promotion in the
  high-level API. **Complete locally and covered by Node tests.**
- Define cancellation behavior between shard appends. **Complete locally:** an
  in-flight native append completes, then the signal is observed before the
  next append or finalization.
- Add metadata parity tests and explicit unsupported-input errors. Duplicate
  named destinations are now rejected explicitly; broader metadata parity is
  still pending.
- Add Linux musl builds plus Node and Bun load/smoke tests for every supported target.
- Publish prerelease packages and test installation outside the monorepo.

Exit gate: a consumer can install the package, assemble a real corpus, cancel safely, and receive no
final-looking file after failure.

### Phase 3 — Floor Inspector canary

- Add the backend assembler interface and qpdf/shardpdf implementations.
- Shadow-compare in QA.
- Canary shardpdf with metrics and immediate feature-flag rollback.
- Measure whole-host RSS, assembly RSS, finalization time, output size, and outline parity.

Exit gate: no invalid output or bookmark regression, bounded assembly memory, and no material
end-to-end resource regression under the production workload.

### Phase 4 — reusable resume and resource policy

- Extract host-agnostic cache/resume primitives only after the Floor integration proves the seam.
- Support pluggable durable cache storage and TTL cleanup.
- Add aggregate worker-memory policy in addition to concurrency.
- Integrate durable resume with Floor's existing BullMQ/report state machine without replacing it.

Exit gate: a deliberately interrupted multi-thousand-page run resumes only missing shards and
produces output identical to an uninterrupted run.

### Phase 5 — broader utility and adapters

- Add page-count, validation, and page-range extraction APIs.
- Prove extraction parity before removing qpdf from any production deployment.
- Build PDFKit and Takumi adapters using the single-pass/two-pass distinction explicitly.
- Revisit WASM, Chromium, forms, tagged PDF, and font dedup only after the core adoption path is
  stable.

## Release gates

Shardpdf does not become Floor Inspector's default assembler until all of these hold:

- Every corpus output passes qpdf and the second validator.
- Page count, page boxes, links, named destinations, and outline targets match the expected output.
- Representative rendered pages have no unintended visual differences.
- Assembly peak RSS stays below the agreed ceiling at fixed shard size as document size grows.
- End-to-end host RSS is no worse than the existing qpdf pipeline.
- Finalization time stays within the agreed regression budget.
- Cancellation and failure leave no final-looking partial artifact.
- Bun on production Linux loads the shipped prebuild without a build toolchain.
- qpdf remains a one-flag rollback until at least one full release cycle succeeds.

## Out of scope for v1

- Encrypted PDFs, as input or output.
- AcroForm merging.
- Tagged PDF/accessibility structure trees.
- Cross-shard font deduplication.
- Content-stream rewriting.
- Chromium adapter.
- High-throughput small-document pooling.

Page-range extraction and WASM are roadmap items, but they are not part of the initial assembly
adoption gate.

## Risks

- **Merge-core correctness surface.** PDFs are messy. The first supported set is output produced by
  known adapters and the Floor compatibility corpus, not arbitrary hostile PDFs.
- **Native crash blast radius.** A malformed shard must return an error, never panic. Applications
  needing stronger isolation should run assembly in their existing disposable export worker.
- **Native maintenance tax.** The prebuild/runtime matrix includes multiple operating systems,
  architectures, C libraries, Node versions, and Bun. An unmaintained native core is worse than a
  mature external qpdf process.
- **Misleading whole-run benchmarks.** Renderer/layout memory can dominate the native bind. Report
  core-only and end-to-end measurements separately.
- **Two-pass cost.** Expensive renderers may nearly double CPU and wall time if measurement is a
  full render. Single-pass must remain a first-class path.
- **Host oversubscription.** Per-worker bounds do not prevent aggregate OOM when concurrency is too
  high. Resource policy belongs in the public contract.
- **Scope creep into a PDF engine.** Structural operations are the boundary. Layout and arbitrary
  content rewriting remain adapter responsibilities.

## Naming

`shardpdf` names the core mechanic: render in bounded shards, then bind them safely. The npm scope is
`@shardpdf/*`.
