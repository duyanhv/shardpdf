# shardpdf benchmarks

Reproduces the problem shardpdf exists to solve: giant-PDF generation in Node under a
t3.small-class resource cap (2 GiB / 2 vCPU). See [workload/spec.md](workload/spec.md)
for the canonical document every runner must produce, and the design spec in
`docs/specs/` for why.

## Layout

- `workload/` — deterministic data generator + reference layout (the manual two-pass)
- `runners/` — one per contestant: `pdf-lib`, `pdfkit`, `react-pdf`, `merge`
  (pdfkit shards + pdf-merger-js bind — the workaround teams use today), and
  `shardpdf` (same shards bound with `@shardpdf/core`; build it first with
  `bun run --cwd crates/core build:release`; a debug build is roughly 9x
  slower on the bind step and will misrepresent the comparison)
- `harness/` — spawns runners under Node, samples peak RSS, validates with qpdf,
  writes JSON into `results/`
- `bind/` — prepares one shared set of PDFKit shards, then measures qpdf and
  `@shardpdf/core` assembly in isolation (merge-only and merge-plus-outline)
- `results/` — committed evidence; `out/` — generated PDFs, gitignored

## Running

Runners execute under **Node** (V8), never Bun — Bun is package manager only.
qpdf is a dev-only validation oracle (`brew install qpdf` / `apt install qpdf`).

Local, uncapped (development + RSS curves):

```bash
node benchmarks/harness/run.ts --runner all --scale smoke
```

Bind-only comparison (fixture rendering is not measured):

```bash
node benchmarks/bind/harness.ts --runner all --mode all --scale full \
  --iterations 3 --tag local-bind
```

Production-shaped bind comparison (also excludes fixture rendering):

```bash
node benchmarks/bind/production-fixture.ts --profile full \
  --output benchmarks/out/production-full
node benchmarks/bind/harness.ts \
  --fixture benchmarks/out/production-full/manifest.json \
  --runner all --mode all --iterations 3 --tag local-production
```

The production-shaped corpus is deterministic and entirely synthetic; it does
not read Floor Inspector source, assets, or customer data. It adds embedded
Korean font subsets, JPEG covers, transparent PNG overlays, repeated resources,
annotations, cross-shard destinations, and a three-level outline tree. On
systems without a standard Korean font, set `SHARDPDF_BENCH_KOREAN_FONT` and,
for a TTC collection, `SHARDPDF_BENCH_KOREAN_FONT_FACE`.

The bind harness samples aggregate RSS for the runner and all descendant
processes. This matters for qpdf: measuring only the Node wrapper would omit the
native qpdf subprocess and produce a misleadingly low number. Both engines read
the exact same pre-rendered shards and receive the same outline entries. Results
store every raw trial plus medians; use at least three iterations for comparison
claims and more when the runtime difference is close.

Capped at t3.small resources (the headline numbers):

```bash
docker build -t shardpdf-bench -f benchmarks/harness/Dockerfile .
docker run --rm --memory=2g --memory-swap=2g --cpus=2 \
  -v "$PWD/benchmarks/results:/repo/benchmarks/results" \
  shardpdf-bench --runner all --scale full --tag local-docker
```

`--memory-swap=2g` (equal to `--memory`) disables swap so the OOM killer fires like a
real memory-starved instance instead of thrashing. Final numbers get confirmed once on
a real t3.small with `--tag t3.small`.

The bind-only harness uses the same resource-cap protocol. A Linux shardpdf
prebuild must be available in the image before running both bind engines there;
until then, local bind results are directional rather than the release headline.

## Runner contract

`node runners/<name>/run.ts <scale> <outputPath>`; last stdout line is
`{"pageCount": number | null}`; exit 0 on success. The harness measures everything else
from outside the process.

## Known content deviations

- `react-pdf`: TOC entries are links without page numbers — the library exposes no
  anchor→page API. Recorded as a finding, not a bug in the runner.

## Findings

See [docs/benchmarks/2026-08-07-baseline.md](../docs/benchmarks/2026-08-07-baseline.md)
for the baseline results and interpretation.
