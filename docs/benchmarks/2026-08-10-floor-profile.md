# Floor-profile scenario: production-shaped bind + extract under a 768 MB cap

**Date:** 2026-08-10
**Why this shape:** mirrors a real Korean IoT inspection backend running on a
t3.small whose PDF export child is capped at 768 MB: ~100-page render windows
(60-unit / 8-block chunks) accumulating to a ~9,000-page project-wide report,
A4, embedded Hangul font subsets, JPEG/PNG imagery, a named destination per
page, a 4,592-entry three-level Korean outline, and selective downloads served
by slicing page ranges out of the cached full report. Fixture:
`benchmarks/bind/production-fixture.ts --profile floor` (90 shards × 100 pages,
135 MB corpus). No application or customer data — shape only.

## Bind (docker `--memory=768m --cpus=2`, node linux-arm64, medians of 3)

| Engine / mode | Peak tree RSS | Wall | Links | Outlines |
| --- | --- | --- | --- | --- |
| qpdf merge | 491 MB (64% of cap) | 2.6s | **all 9,000 dead** | — |
| **shardpdf merge** | **91 MB (12% of cap)** | **0.6s** | pass | — |
| qpdf merge + JSON outline inject | 491 MB | 5.6s | **dead** | pass |
| **shardpdf outline** | **97 MB** | **0.7s** | pass | pass |

At this shape the incumbent burns nearly two thirds of the export child's
memory budget on the bind step alone and silently breaks every named
destination; shardpdf binds the same 9,000 pages in an eighth of the budget,
4–8× faster, with links and the full Korean outline intact.

## Extract (selective downloads: 2-page unit, 60-page block, 6,000-page span)

| Engine | Peak tree RSS (capped docker) | Wall | Correct |
| --- | --- | --- | --- |
| qpdf | 388 MB | 3.9s | pass |
| shardpdf | 497 MB | 1.3s | pass |

Honest split: shardpdf extraction is ~3× faster in the capped run but uses
more memory than qpdf's streaming page-slice (both fit the 768 MB cap; the
6,000-page span drives the peak). This is v1's documented `O(source parse)`
working set — a streaming extraction path is the known improvement if the
margin ever matters.

## Bun (the target backend's production runtime; local, uncapped, medians of 3)

All modes correct under Bun 1.3.14 end-to-end (Bun parent → Bun runner →
napi). Bind: shardpdf 68–78 MB vs qpdf 306–372 MB, links pass vs dead.
**Flag:** shardpdf extraction under Bun ran 6.8s vs 1.2s under node for the
same ranges (qpdf: 1.2s under Bun) — a Bun-specific `extractPages` slowdown
worth profiling before recommending the extract path on Bun.

## Reproduce

```bash
node benchmarks/bind/production-fixture.ts --profile floor
docker build -t shardpdf-bench -f benchmarks/harness/Dockerfile .   # needs a linux .node in crates/core
docker run --rm --memory=768m --memory-swap=768m --cpus=2 \
  -v "$PWD/benchmarks/out:/repo/benchmarks/out" \
  -v "$PWD/benchmarks/results:/repo/benchmarks/results" \
  --entrypoint node shardpdf-bench benchmarks/bind/harness.ts \
  --fixture benchmarks/out/production-floor/manifest.json --tag docker-768m
bun benchmarks/bind/harness.ts --fixture benchmarks/out/production-floor/manifest.json --tag bun-local
```

Raw JSON: `benchmarks/results/docker-768m-production-floor-*` and
`bun-local-production-floor-*`.
