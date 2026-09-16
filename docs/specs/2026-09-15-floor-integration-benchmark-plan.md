# Floor Inspector integration and benchmark plan

Date: 2026-09-15. Status: ready for implementation; no new benchmark results
or production adoption are claimed by this plan.

## Objective and scope

Determine whether replacing Floor Inspector's PDF assembly and outline step
with `@shardpdf/core` improves the actual export workload without changing
document content, job behavior, or resource isolation.

Primary objective: more memory headroom on the shared small host. Secondary
objectives: faster finalization and simpler outline creation. Measure full
export time separately; assembly improvements do not imply that snapshot,
rendering, or S3 costs shrink.

First release scope is full-report assembly with bookmarks. PDFKit, section
planning, snapshot generation, BullMQ, Redis/S3 caches, uploads, and application
state transitions remain owned by Floor. Selective extraction is a separate
decision after assembly has passed its gates.

## Starting point verified from the repositories

- Floor backend: `4658e375d`, clean at inspection. Root:
  `/Users/duyanhvu/works/Meta/iot/floor-inspector-backend`.
- Shardpdf: `024503f` at inspection, with uncommitted public-facade work in
  `crates/core/index.js`, `index.d.ts`, package/lock files, and a new API test.
  Freeze a tested candidate before collecting release evidence. Do not package
  an evolving checkout or overwrite this work as part of the integration.
- Backend package metadata requests Bun `1.4.2` and Node `>=24.18.1 <25`;
  PM2 uses Bun. Record the effective deployed versions instead of assuming
  repository metadata proves the runtime.
- Full reports already render chunks sequentially in isolated children, then
  call `qpdfMerge`. `store()` adds outlines through qpdf structural JSON and
  falls back to the base PDF on outline failure.
- qpdf subprocesses receive the backend's configured memory limiter and
  cancellation polling. A synchronous napi call in the main backend process
  would remove that isolation and block its event loop.
- The bind harness accepts external fixture manifests and records release/debug
  profile, git revision, raw trials, wall time, output bytes, process-tree RSS,
  qpdf validity, named links, and outlines. Its shardpdf runner currently calls
  low-level `Assembly`, not the public facade or Floor's adapter.
- `benchmarks/harness/Dockerfile` currently copies only the benchmark workspace;
  it does not package/build the native core and selects the general harness as
  its entrypoint. It is not ready to run this integration comparison as-is.
- Floor's existing load harness exercises selective downloads and measurement
  traffic. Full-report production is an extension point, not implemented merely
  by selecting a scenario name. Content/order checks, persisted-sample counts,
  and restart probes have documented gaps.

## Phase 1 — Freeze and install a candidate

Deliverable: a reproducible installable package and consumer smoke test.

1. Finish and verify the public facade separately. Prefer `merge()` for the
   integration once the candidate contains it; do not import unpublished source
   files or reach into generated native bindings from Floor.
2. Build a release native binary for each measured platform. Record library git
   SHA, package version, tarball SHA-256, binary SHA-256, Cargo profile, lockfile,
   qpdf version, OS/architecture, Node/Bun versions, and backend SHA.
3. Install an immutable packed candidate into the backend through a pinned local
   tarball for development and a CI artifact/internal prerelease for staging.
   Do not rely on a symlink to the live shardpdf checkout.
4. Explicitly include the platform binary and JS/type entrypoints in the package.
   Test the installed artifact in a clean consumer directory without Rust. Verify
   both import styles and the deployment build's ability to find the `.node`
   file. Native artifacts must match the actual Linux architecture and libc.
5. Run the core's native/API/type checks and a release-profile assertion. Run the
   integration smoke under Floor's Bun version, with Node as a compatibility
   comparison. Do not attribute a Node-only result to the Bun deployment.

Exit gate: the same immutable candidate installs and merges a fixture on the
local test host and the target Linux image. No benchmarks using debug bindings.

## Phase 2 — Add a reversible backend assembly adapter

Deliverable: one backend PR, qpdf remains the default.

| Location in Floor | Change |
| --- | --- |
| `apps/backend/src/core/config/env.validation.ts` and typed config accessor | Add proposed `REPORT_PDF_ASSEMBLER=qpdf|shardpdf`, default `qpdf`; carry it through applicable deployment config. |
| Reporting infrastructure adapters and module registration | Add a backend-owned `PdfAssembler` contract and `QpdfAssembler` / `ShardPdfAssembler` implementations, injected through a Symbol token. |
| `report-generation.definition.ts`, `merge()` | Pass ordered paths, expected counts, outline data, output path, and the existing execution context to the adapter. Persist the chosen engine/version in run metadata so a run cannot switch midway. |
| `utils/pdf-outline.util.ts` | Separate the pure section-index-to-bookmark mapping from qpdf object-reference construction. Keep Korean labels and block/unit grouping in Floor. |
| `report-generation.definition.ts`, `store()` | Upload the adapter's selected artifact; remove duplicate outline work once the adapter owns it. Preserve explicit degraded-outline reporting. |
| New lightweight assembly child entry | Load the packaged library in a disposable process and exchange paths/options/result metadata via sidecar files. Never send whole PDFs through IPC. |
| `spawn-with-memory-cap.ts` caller | Run the child under the existing limiter, cap, and cancellation protocol. Do not create a second limiter policy inside the library. |

The adapter should return the artifact path, actual page count, whether the
requested outline was applied, and timing data. With shardpdf, compare actual
per-input counts to chunk sidecars where available, and verify the total before
upload. Translate Floor's one-based page numbers to the public API's zero-based
indices once, inside the mapping function.

The public facade is currently based on synchronous native calls. Running it in
a capped child preserves API-server responsiveness and allows the host to kill
an in-progress native operation. A Promise or `maxDecompressedBytes` alone is
not an RSS cap. Verify limiter operation on Linux; `limiter=none` does not prove
hard-cap behavior.

Fallback policy:

- Keep the explicit qpdf configuration as the rollback path.
- For classified outline validation/construction failures, preserve the current
  ability to upload a valid base PDF with a warning. The shardpdf adapter can
  retry assembly without the outline using a fresh partial output.
- Cancellation, disk failure, OOM, and unrelated parser failures remain failures.
  Do not automatically retry all shardpdf failures through qpdf and label the
  resulting run a shardpdf success.
- Retain qpdf for validation and selective-download operations throughout the
  first release. Feature selection is per run; rollback takes effect for new
  runs and does not change an active run's recorded engine.

Tests: config default/selection; section/bookmark targets and Korean nesting;
sidecar count mismatch; missing/corrupt input; existing-output preservation;
outline fallback; cancellation before/during assembly; capped-child failure;
temporary cleanup; upload receives the selected file and correct size.

Follow Floor's `AGENTS.md` and relevant engineering docs, load its applicable
local intent skills before edits, run focused backend specs, then `bun run lint`.

## Phase 3 — Capture one immutable compatibility corpus

Deliverable: small, typical, and heavy fixtures from the real Floor renderer.

1. Render seeded/sanitized Floor report snapshots once. Retain the ordered PDF
   chunks, their `*.idx.json` sidecars, the global section index, expected
   bookmarks, and final qpdf baseline output before work-directory cleanup.
2. Include a minimal report, a representative report, and a large report near
   observed workload size (approximately 6,000–9,000 pages if the seeded data
   produces that size). Include an image/font-heavy fixture separately; page
   count alone is not a measure of cost. Record actual counts and bytes.
3. Cover head chunks, block/unit continuation boundaries, empty sections,
   embedded Korean fonts, JPEG/PNG charts/covers, and three-level bookmarks.
   Keep a synthetic named-link fixture as a library check; do not present its
   qpdf link losses as a current Floor regression without corresponding links
   in Floor's actual input.
4. Produce `BindFixtureManifest` JSON with relative shard paths, total pages,
   and flattened output outlines. Add a companion manifest with file hashes,
   renderer/template/font versions, source revision, sidecar counts, and expected
   text/order checks. Preserve backend outline mapping semantics.
5. Keep real/sanitized fixture assets in approved private/local artifact storage.
   Only synthetic assets and non-sensitive measurement summaries go into public
   repository evidence. Capture does not require uploading customer PDFs.

Both engines must consume the exact same immutable files for assembly tests.
Separately generating each engine's input would introduce a renderer variable.

## Phase 4 — Run the comparison in three layers

### A. Assembly-only comparison

Measure these cases independently:

| Case | qpdf baseline | shardpdf candidate |
| --- | --- | --- |
| Merge only | Existing ordered qpdf merge | Public `merge()` without outline |
| Merge plus bookmarks — primary decision | qpdf merge + the actual Floor outline path | Public merge with the same mapped bookmarks |
| Production adapter cost | Floor qpdf adapter including subprocess setup and cleanup | Floor shardpdf adapter including subprocess setup and cleanup |

Keep the current low-level bind runner for algorithm diagnostics, but add a
public-facade mode and a backend adapter driver. Comparisons that bypass the
packaged facade or omit subprocess startup cannot decide deployment benefit.
The generic `qpdf-outline.ts` helper is useful for diagnostics; decisive results
must also exercise Floor's real mapping and fallback path.

Existing command usable after preparing a fixture and release binding, from
`/Users/duyanhvu/works/shardpdf`:

```bash
bun run --cwd crates/core build:release
node benchmarks/bind/harness.ts \
  --fixture /private/tmp/floor-pdf-bench/heavy/manifest.json \
  --runner all --mode all --iterations 10 \
  --tag floor-heavy-local-20260915 --keep
```

This command currently measures the low-level runner. It is a diagnostic step,
not a claim that the proposed adapter driver already exists. Use fresh run tags
and output locations so historical result files are not overwritten.

Before decision runs, extend scheduling: one excluded warm-up per case, then at
least ten measured trials per engine/case, alternating A/B and B/A order.
The existing harness batches all trials for one engine first and includes the
first trial, so its default loop is not the final protocol. Label filesystem
cache state; avoid privileged host-wide cache flushing. Re-run noisy comparisons
instead of selecting the fastest sample. Report raw trials, median, range, and
paired relative changes; ten trials are not a reliable p95 capacity estimate.

### B. End-to-end full-report generation

Add a driver that invokes the real full-report export path for isolated test
reports using the same frozen domain data and template/assets. Measure snapshot,
rendering, assembly, outlines, upload, total processing, and queue waiting
separately. Reuse neither the same completed report nor an artifact cache hit as
evidence of generation performance. Separate warm asset-cache and fresh-run
results, and use test-owned output namespaces per engine/run.

The existing selective-download burst driver does not do this. Implement the
full-report producer before claiming end-to-end coverage. A presigned full-PDF
download also does not exercise PDF generation.

### C. Deployment-shaped resource test

1. Start locally for correctness and quick measurements.
2. Build a Linux benchmark image containing the frozen native package and Floor
   assembly child, qpdf, and measurement tools. Use a 2-vCPU / 2-GiB cap with swap
   disabled. Correct the current Dockerfile/entrypoint before claiming this run.
3. For whole-export tests, reproduce backend/frontend/Redis baseline usage or
   run the representative stack under the same total cap. Giving the binder
   alone 2 GiB is not equivalent to a shared 2-GiB application host.
4. Repeat representative tests on production-parity staging / a real t3.small.
   Record effective limits, OS/architecture, CPU-credit balance/mode, storage,
   background load, and deployment versions. Synthetic Docker limits do not
   reproduce burst credits or storage/network behavior.
5. Keep worker concurrency unchanged. Run a measurement-only baseline, then
   the full report alongside representative measurement traffic and the existing
   selective/prewarm queues. Use distinct jobs; assert that deduplication did not
   collapse the intended work. This migration does not authorize concurrency 2.

Staging execution needs an explicit target, test identities, fixture reports,
and resource/queue/DB access. Obtain those execution inputs before submitting
jobs. No production load is implied by this plan.

## Measurements and correctness gates

Collect:

- Per-stage and total wall time; subprocess startup and cleanup included in the
  adapter measurement. Use authoritative BullMQ timestamps for queue wait.
- Backend RSS, aggregate instantaneous RSS for each adapter's process tree, and
  whole-cgroup/host peak usage. Capture outside the measured JS process.
- Sampling timestamps and interval/overhead. Fast operations can peak between
  samples; use fresh Linux cgroup peak counters where available and avoid
  claiming sampled RSS is an exact high-water mark. Do not add peaks that
  happened at different times. RSS sums may double-count shared pages; cgroup
  memory includes page cache and is a different metric. Report both with labels.
- CPU use/credits, temporary disk high-water, bytes read/written where measurable,
  final file size, cache status, OOM events, process restarts, cancellations,
  failures, and fallback outcomes.
- Runtime revision, package and fixture hashes, effective concurrency, and caps.

Fix the resource collector to follow descendants, rather than only regex-match
`qpdf` and existing child names: the new assembly child must be counted. Preserve
the current collector's sampler-overhead accounting.

Every successful output must pass page count, required page order/content,
bookmark title/hierarchy/target checks, and qpdf structural validation. Verify
links where the fixture actually contains them. Render representative pages and
all section/chunk boundaries with an independent renderer; include Korean glyphs,
images, and overlays. Compare rendered output rather than PDF byte equality,
since object IDs, timestamps, compression, and file structure may differ.

For the staging overlap test, fill the existing measurement reconciliation and
restart-probe gaps. Missing persisted-sample counts or `contentMatches=null`
cannot be reported as passing. No unexplained sample loss, backend restart, or
new user-facing failure is acceptable.

## Decision rule, chosen before the runs

Proposed adoption thresholds for this memory-constrained use case:

| Gate | Requirement |
| --- | --- |
| Correctness | All required fixture and integration checks pass; no unapproved feature loss. |
| Stability | No new crashes, OOMs, backend restarts, sample loss, or unexplained fallbacks in the tested scenarios. |
| Resource contract | Existing cap and cancellation behavior retained; no increase in worker concurrency. |
| Meaningful stage benefit | At least 20% lower median process-tree peak RSS OR at least 20% lower median assembly-plus-outline time on typical and heavy fixtures. |
| Tradeoff bound | The other primary stage metric does not regress by more than 10%; final output size does not increase by more than 5%. |
| Whole-job bound | Median full-export processing time does not regress by more than 5%, and whole-host peak usage does not materially regress beyond observed measurement noise. |

These are proposed engineering thresholds, not established production SLOs.
Record any agreed change before measuring. If variability crosses a threshold,
the outcome is inconclusive and needs more trials. If only assembly improves,
say exactly that; do not claim an equal end-to-end percentage improvement.

Possible decisions: adopt for full-report assembly; retain qpdf because the
benefit is too small; or keep an optional engine for a specific workload. The
experiment should be able to conclude that integration is not worthwhile.

## Phase 5 — Canary and separate extraction decision

After the preceding gates pass, enable shardpdf for selected staging reports,
then a bounded production canary through the engine selection. Compare job
failure/fallback rate, processing time, host headroom, and document complaints.
Keep qpdf installed and a one-setting rollback for at least one release cycle.
Promotion is an explicit deployment step after the measured report is reviewed.

Evaluate selective downloads independently: count pages, extract first/middle/
last and multi-range selections, merge cached sections, and compare a large
source's memory. Shardpdf extraction currently parses the entire source and
drops all annotations in its explicit drop mode. It cannot be assumed to have
merge's memory behavior or qpdf's feature behavior. A successful assembly canary
does not automatically replace `qpdfExtractPages` or `qpdfPageCount` in Floor.

## Concrete work order and deliverables

1. **Candidate package:** release artifact, hashes, consumer tests, frozen API.
2. **Backend integration PR:** adapter, capped child, engine flag, outline mapping,
   fallback policy, targeted tests; qpdf stays default.
3. **Benchmark PR:** real-renderer fixture capture, facade/adapter drivers,
   balanced trial scheduling, Linux image, full-report producer, complete
   resource/content/reconciliation probes.
4. **Evidence report:** raw JSON/NDJSON, fixture/package manifests, validation
   results, per-stage and whole-job comparisons, limitations, and an explicit
   adopt/retain/inconclusive verdict against the thresholds above.
5. **Canary change:** engine selection only after the evidence supports adoption.

No integration, deployment, or new benchmark execution was performed while
preparing this plan.
