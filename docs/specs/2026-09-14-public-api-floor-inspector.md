# Public API proposal, grounded in Floor Inspector

Date: 2026-09-14. Status: **implemented in `@shardpdf/core` as of `ae0c330`
(2026-09-16); steps 1 to 4 below are done, step 5 (Floor canary) is not**.
Originally inspected shardpdf at `32e13a5` and Floor Inspector backend at
`4658e375d`.

## Review (2026-09-15)

Re-checked against shardpdf `ee3f33d` and Floor Inspector `4658e375d`.

- Evidence table verified: every cited file exists; `bufferPages: false`,
  `isolateRun = true`, `qpdfMerge` in `merge`, the outline try/catch fallback
  in `store`, 8 blocks / 60 units / 12,000 pages, and the qpdf memory cap and
  cancellation all match. No named-destination or `.link()` calls in the
  renderer subtree.
- Status line is still accurate: `merge`, `extract`, and `getPageCount` are not
  exported. `@shardpdf/core` exports `assemble`, `extractPages`, `Assembly`,
  `buildInfo`. All napi calls are synchronous; `assemble` yields between
  shards but does not run off-thread.
- Error codes: five codes exist (`PDF_PARSE`, `IO`, `MALFORMED`, `CONSUMED`,
  `INVALID_ARG`). Bindings are `catch_unwind`, but a caught panic surfaces as a
  generic napi error with no `SHARDPDF_*` code, and wrapper `rename`/`rm`
  failures surface as plain Node errors. The spec's warning about the code
  union stands.
- Discrepancy fixed in this pass: `extract.rs` removes the entire `/Annots`
  array, but the doc comments, `native.d.ts`, and README said "link
  annotations". Wording corrected to "all annotations" to match the
  `annotations: "drop"` acknowledgement proposed here.

## Implementation record (2026-09-16)

Landed in four commits, each verified with `cargo test`, `node --test`,
`bun test`, `tsc`, and biome:

- `024503f` natives: `pageCount`, `extractSelection` (zero-based, ordered,
  one source parse), `Assembly#appendShardBytes`, `SHARDPDF_PANIC` on caught
  unwinds. Shared extraction core behind the legacy 1-based `extractPages`.
- `fed6847` facade: `merge`, `extract`, `getPageCount` exactly as in the
  contract below, nested outline flattening, atomic sibling-temp publication,
  `byteLength` from the closed file, `inputs[i].{pageCount,startPageIndex}`,
  mandatory `annotations: "drop"`. Public types exported from `index.d.ts`.
- `35f7906` consumer smoke (`bun run smoke:consumer`): `npm pack` tarball
  installed into a standalone package, run under Node 24.15 and Bun 1.4.2 in
  CJS and ESM, plus `tsc` nodenext type checks with load-bearing negative
  cases. Added `files`, `exports`, `engines` to the package. Only darwin-arm64
  prebuilt here; see `docs/audits/2026-09-16-consumer-package-smoke.md`.
- `ae0c330` off-thread execution: napi `Task` variants (`pageCountAsync`,
  `extractSelectionAsync`, `Assembly#appendShardAsync`/`appendShardBytesAsync`/
  `finalizeAsync`); the facade uses them. Measured on a 400-page source: sync
  calls tick a 1 ms interval 0 times, async 25 to 51 times, identical under
  Node and Bun. One operation per `Assembly` at a time (`busy` getter,
  overlapping calls reject with `SHARDPDF_INVALID_ARG`). `assemble()` keeps
  the sync natives by design.

Deviations from the contract: `PDFOptions` gained `maxDecompressedBytes`
(pass-through of the existing zip-bomb bound). `AbortSignal` is observed at
checkpoints only; an in-flight native task completes before cancellation is
seen, so Floor's capped subprocess remains the hard limit as stated below.
Error union: `SHARDPDF_*` codes are native-only; wrapper validation throws
`TypeError`/`RangeError`, cancellation `AbortError`, and rename/stat failures
plain Node errors. This is documented on the union rather than hidden.

Acceptance evidence: `smoke/consumer/floor-acceptance.cjs` reproduces the
mapping block below end to end through the installed package: five PDFKit
chunks (head, two block windows, two unit windows) with an embedded CJK font
and the exact section labels from `pdf-outline.util.ts`, `merge` with the
`toPDFOutline` conversion, the sidecar and total page-count checks,
`getPageCount`, `extract` of the block and unit ranges, the selected merge and
its requested-page-count check, abort preserving `full.pdf`, and a bad outline
rejecting with a classified code. Every count is compared against the exact
qpdf commands Floor runs today (`--empty --pages ... --`, `--show-npages`),
bookmark titles and targets are read back through qpdf JSON, and the run is
identical under Node 24.15 and Bun 1.4.2. It found one contract bug: an
outline targeting a page past the document was `SHARDPDF_MALFORMED`, which
would have made the host's "retry without an outline" rule indistinguishable
from a broken input. Fixed: every caller-supplied outline problem is now
`SHARDPDF_INVALID_ARG`; `MALFORMED` is reserved for input PDFs.

Scale and resource boundary: the bind harness now has a `shardpdf-merge`
engine that calls the public `merge()`. On the 11,164-page `full` fixture
(Floor's ceiling is 12,000) with a release build, `merge()` peaks at 87 MB
process-tree RSS and 0.16 s in both merge and merge+outline modes, identical
to the low-level `Assembly` path and byte-identical output, versus qpdf at
193 to 201 MB and 0.43 to 1.34 s (`docs/benchmarks/2026-08-07-baseline.md`,
rerun 2026-09-16). Floor's `EXPORT_MEMORY_CAP_MB` defaults to 768, so the
facade sits about 9x under the cap Floor already enforces on qpdf.

Type boundary: `smoke/consumer` also compiles the public types under
`module: esnext` + `moduleResolution: bundler`, the shape of Floor's
`apps/backend/tsconfig.json`, and passes with Floor's own installed `tsc`
(7.0.2).

Platform boundary: `smoke/linux/` builds the binding from a clean copy inside
`node:24-bookworm` and runs the full consumer smoke. CI run 35100920445 passed
it on linux/amd64 and linux/arm64 (Node 24.21, Bun 1.4.2, glibc 2.36) and
also smoked a single tarball bundling all six prebuilt bindings.

Resource-limiter boundary: Floor's `rlimit` mode (`ulimit -v`, default
768 MB) cannot start Node 24 at all on either architecture, and cannot start
Bun on aarch64. Where the runtime starts, `merge()` completes, after lopdf's
rayon thread pool was disabled (it was the one shardpdf-side address-space
consumer, and it panicked spawning threads under the cap; cost 0.16 s to
0.22 s on 11k pages, RSS unchanged). A shardpdf child in Floor must use the
`cgroup` limiter. Details and the table are in
`docs/audits/2026-09-16-consumer-package-smoke.md`.

Not done: step 5, the Floor canary on real shards under the process cap in
the Floor repo. See `docs/specs/2026-09-15-floor-integration-benchmark-plan.md`.

## Recommendation

Publish a small set of PDF operations from `@shardpdf/core`: `merge`,
`extract`, and `getPageCount`. Keep generation and worker scheduling in the
optional orchestrator. A caller should be able to use its existing renderer,
job queue, storage service, and section model.

Here, universal means renderer- and application-independent within Node and
Bun. It does not mean browser/edge support or complete preservation of every
PDF feature. Native binary and filesystem requirements must be explicit.

There is no single common API among the libraries examined:

- [pdf-lib](https://pdf-lib.js.org/docs/api/classes/pdfdocument) uses
  `PDFDocument.create/load`, `copyPages`, and `save()` returning bytes.
- [PDFKit](https://pdfkit.org/docs/getting_started.html) exposes a document
  stream with `pipe()` and `end()`.
- [pdf-merger-js](https://github.com/nbesli/pdf-merger-js) uses
  `add()`, `save(path)`, and `saveAsBuffer()`.
- [qpdf](https://qpdf.readthedocs.io/en/stable/cli.html#page-selection) exposes
  file-based merge/extract operations through its CLI.

Use familiar operation names, Promises, `AbortSignal`, file URLs, byte arrays,
and explicit page-index conventions. Do not expose Rust types, PDF object IDs,
shard scheduling, or a mandatory `measure/render` adapter to ordinary users.

## What Floor Inspector actually does

The backend root inspected was
`/Users/duyanhvu/works/Meta/iot/floor-inspector-backend`.

| Stage | Implementation evidence | Consequence for shardpdf |
| --- | --- | --- |
| Job orchestration | `apps/backend/src/core/exports/chunked-export-pipeline.ts`, sequential `renderChunks`; `report-generation.definition.ts`, `isolateRun = true` | Keep BullMQ, run isolation, cancellation, and work-directory ownership in the backend. |
| Snapshot and rendering | `report-pdf-isolation.service.ts`; `report-pdf-chunking.ts` | Snapshot setup and each PDF chunk already run in disposable children. The backend plans a head chunk, then block/unit windows. |
| Layout | `pdf-renderer/report-pdf.generator.ts`, `bufferPages: false` | PDFKit renders each chunk once and records its page count. No whole-report measure/render pass is required by this path. |
| Chunk sizing | `report-generation.constants.ts` | Current defaults are 8 blocks or 60 units per chunk; the whole-report ceiling is 12,000 pages. These are application policy. |
| Section index | `report-pdf-chunking.ts`, `reassembleSectionIndex` | Local one-based inclusive page ranges become a global section index. Preserve that application-owned structure. |
| Assembly | `report-generation.definition.ts`, `merge` | Ordered file paths go to `qpdfMerge`; actual per-input counts would let the replacement verify sidecars. |
| Bookmarks | `report-generation.definition.ts`, `store`; `utils/pdf-outline.util.ts` | qpdf JSON round-trip adds Korean titles and section/block/unit nesting. Failure currently falls back to uploading the base PDF. |
| Upload | `report-generation.definition.ts`, `store` | Finished files stream from disk to S3 with a known content length. Returning a whole-PDF Buffer is unnecessary. |
| Selective download | `application/services/report-pdf.service.ts` | Download full PDF to disk, check page count, extract one-based ranges, cache section PDFs in S3, merge cached selections, validate count, upload. No re-rendering. |
| Full download | `application/services/report-pdf-access.service.ts` | Return a presigned URL for an existing S3 object. No PDF-library work. |
| Resource control | `apps/backend/src/core/utils/process/qpdf.ts` and `spawn-with-memory-cap.ts` | qpdf has a separately enforced process cap and cancellation polling. An in-process native replacement must not silently remove this protection. |

The renderer contains local page counters, including a project-analysis
subsection counter. This is not evidence of a document-wide `Page X of Y`
requirement. No named-destination authoring calls were found in the inspected
PDF renderer subtree; link preservation is useful library functionality, not
a reason to force two-pass rendering into this integration.

## Proposed public contract

The following is the target contract, including additions beyond today's
implementation. Buffer works through its Uint8Array inheritance. URLs are
`file:` only; downloading remote content belongs to the host.

```ts
export type PDFSource = string | URL | Uint8Array;
export type PDFFile = string | URL;

export interface PDFOutlineEntry {
  title: string;
  pageIndex: number; // zero-based, in the output document
  children?: readonly PDFOutlineEntry[];
}

export interface PDFProgress {
  operation: "merge" | "extract";
  completed: number; // input files for merge; selected pages for extract
  total: number;
  pageCount: number; // cumulative output pages
}

export interface PDFOptions {
  signal?: AbortSignal;
}

export interface PDFWriteOptions extends PDFOptions {
  onProgress?: (event: PDFProgress) => void;
}

export interface PDFResult {
  pageCount: number;
  byteLength: number;
}

export interface PDFMergeResult extends PDFResult {
  inputs: readonly {
    pageCount: number;
    startPageIndex: number;
  }[];
}

export interface PDFMergeOptions extends PDFWriteOptions {
  outline?: readonly PDFOutlineEntry[];
}

export type PDFPageSelection =
  | readonly number[] // zero-based indices, in requested output order
  | { start: number; end: number }; // zero-based, end-exclusive

export interface PDFExtractOptions extends PDFWriteOptions {
  pages: PDFPageSelection;
  // Required acknowledgement of the first release's extraction limitation.
  // This drops ALL annotations, including widgets, not only navigation links.
  annotations: "drop";
}

export declare function merge(
  inputs: readonly PDFSource[],
  output: PDFFile,
  options?: PDFMergeOptions,
): Promise<PDFMergeResult>;

export declare function extract(
  input: PDFSource,
  output: PDFFile,
  options: PDFExtractOptions,
): Promise<PDFResult>;

export declare function getPageCount(
  input: PDFSource,
  options?: PDFOptions,
): Promise<number>;
```

An array passed as `pages` preserves its specified order. The first release
should reject duplicates explicitly until repeated-page copying has been
implemented and tested. Ranges require `0 <= start < end <= sourcePageCount`.
Every index must be a finite integer. Reject an empty selection.

Nested `children` express outline structure directly; the wrapper can flatten
them into today's native preorder entries and levels. The API creates an
explicit output outline; it does not promise to merge source bookmarks, forms,
tags, signatures, or arbitrary document metadata. Document those preservation
limits next to the merge example. Extraction also drops source destinations
and outlines in its initial supported mode.

### I/O and execution semantics

- File operations write a unique sibling temporary file, close it, then rename
  it into place. Errors and cancellation preserve an existing output. A crash
  may leave a temporary file; atomic publication is not a durability guarantee.
- A successful result describes a closed file ready to upload. `byteLength`
  comes from the output file's size.
- Merge retains one parsed input plus accumulated object-offset/page/
  destination/outline metadata. Bytes supplied by the caller remain part of the
  caller's memory. Passing an array of Buffers can itself retain all inputs.
- Extraction currently parses the entire source. It must not inherit the
  one-shard memory claim. Non-contiguous selection must parse the source once,
  not run one full parse per requested range or page.
- Promise-based signatures must be accompanied by actual off-thread native work
  before advertising nonblocking execution. A Promise around today's sync napi
  calls is not sufficient. Workers/async tasks and cancellation require testing
  under both Node and Bun.
- `AbortSignal` is the common cancellation input. Define checkpoints and the
  non-interruptible publication boundary. It is not a hard native time or memory
  limit. Floor must retain a capped, killable subprocess for equivalent limits.
- Progress callbacks run on the caller's JS thread; callbacks are synchronous.
  A callback failure before publication rejects the operation and cleans up.
- Keep PDF/domain errors machine-readable; distinguish ordinary filesystem
  failures, invalid inputs, malformed PDFs, cancellation, and caught native
  unwinding panics. Do not advertise an exhaustive code union while excluding
  wrapper filesystem failures or native panic errors.
- Readable/Writable streams and Buffer-returning helpers can follow demonstrated
  demand. Input streams may need disk spooling because PDF parsing needs random
  access. Direct output streams cannot provide rollback after publication and
  need a different failure contract. Do not label spooled I/O as direct streaming.

## Floor Inspector mapping

Proposed usage after the contract is implemented:

```ts
import { extract, getPageCount, merge } from "@shardpdf/core";

const merged = await merge(chunkPaths, fullPdfPath, {
  signal,
  outline: toPDFOutline(sectionIndex),
});
// The backend checks merged.pageCount against sectionIndex.totalPages and
// merged.inputs[i].pageCount against each chunk's sidecar before uploading.

const sourcePages = await getPageCount(sourcePdfPath, { signal });
// Apply the backend's existing source/index mismatch check here.

await extract(sourcePdfPath, sectionPdfPath, {
  pages: { start: range.startPage - 1, end: range.endPage },
  annotations: "drop",
  signal,
});

const selected = await merge(sectionPaths, selectedPdfPath, { signal });
// Apply the existing requested-page-count check before the S3 upload.
```

`toPDFOutline` belongs in the backend: keep Korean section labels, unit grouping,
and ordering there, and convert each one-based `startPage` with
`pageIndex = startPage - 1`.
No report IDs, section enums, Nest providers, S3 keys, Redis keys, or limiter
strategy strings belong in the general PDF API.

The existing bookmark fallback is a real behavior to preserve explicitly.
First build/validate the outline independently. For a classified outline error,
the host may retry the merge without an outline and log the degraded result.
Never turn cancellation, OOM, disk failure, or arbitrary parser failure into a
silent success. Keeping the existing qpdf post-processing during the first
assembly-only canary is another way to preserve the current behavior.

The first adoption replaces `qpdfMerge` behind a backend-owned interface. Keep
the existing qpdf implementation available for rollback. Add native outlines
after validating title encoding, hierarchy, targets, and the fallback policy.
Migrate extraction/page-count calls only after large-source memory and feature
parity checks; native extraction currently drops more annotation information
than qpdf. Keep source-count validation even if merge now returns its own count.

## Implementation and release sequence

1. Add the operation facade and nested-outline conversion without breaking
   `assemble`, `extractPages`, or low-level `Assembly`. Keep the legacy extraction
   API one-based; only the new `extract` contract uses zero-based indices.
2. Implement page-count inspection, file-URL normalization, byte-array inputs,
   atomic extraction, selection semantics, result metadata, and error handling.
   These are capabilities to build, not merely export renames.
3. Implement and verify asynchronous execution. Preserve an explicit sync/low-level
   entrypoint for hosts already executing in a dedicated child process.
4. Test a consumer package under Node and Bun: both module systems, public types,
   supported prebuilt platforms, and installation without a local Rust toolchain.
5. Canary the Floor assembly integration on sanitized real shards under the
   existing process cap. Compare total process-tree RSS and elapsed time against
   qpdf, including the separate extraction workload.

Acceptance fixtures must cover first/last/single-page slices, non-contiguous
selection order, annotation-loss acknowledgement, inherited resources, embedded
Korean fonts, images, named links, nested Korean bookmarks, count mismatches,
concurrent outputs, disk failure, cancellation, and output preservation.
Use qpdf plus an independent renderer for visual comparison. Performance
claims must identify the workload and include host/worker memory.

The optional orchestrator continues to use the same core operations. Floor's
single-pass pipeline does not need an adapter migration to benefit from this API.
