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
  `bun run --cwd crates/core build`)
- `harness/` — spawns runners under Node, samples peak RSS, validates with qpdf,
  writes JSON into `results/`
- `results/` — committed evidence; `out/` — generated PDFs, gitignored

## Running

Runners execute under **Node** (V8), never Bun — Bun is package manager only.
qpdf is a dev-only validation oracle (`brew install qpdf` / `apt install qpdf`).

Local, uncapped (development + RSS curves):

```bash
node benchmarks/harness/run.ts --runner all --scale smoke
```

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
