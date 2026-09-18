# Linux verification under a real memory cap

The audit's numbers are macOS and uncapped. Floor runs on a Debian EC2 host
under a per-child RSS budget, so the question that actually matters is whether
the gauge-dedupe conclusion survives glibc, a different allocator, and a real
cgroup limit. It does, and more sharply than on macOS.

## Result

`node:24-bookworm-slim` (glibc, matching Floor's host, not Alpine/musl), Node
24.21, pdfkit 0.20.2, canvas 3.2.3, 120 pages drawing from 6 distinct gauges.
One mode per container. Run on **both** architectures: arm64 native, and x86_64
(Floor's EC2 architecture) through Rosetta.

### x86_64 — Floor's production architecture

Process RSS, median of 3 runs. **Use `rssPeak`, not `cgroupPeak`**: the cgroup
counter also charges page cache for the written PDF and the `qpdf` subprocess,
so it is noisy run to run (observed 80-200 MB for the *same* cached workload)
while process RSS is stable to ~1 MB. An earlier version of this table quoted
single `cgroupPeak` samples and carried two outliers because of it.

| cap | naive | cached |
| --- | --- | --- |
| 300 MB | RSS peak **195 MB**, Δ90 MB, 3,216 ms | RSS peak **120 MB**, Δ15 MB, 485 ms |
| 200 MB | **OOM-killed (exit 137)** | completes, RSS peak **~120 MB** |
| 150 MB | **OOM-killed (exit 137)** | completes |
| 120 MB | **OOM-killed (exit 137)** | completes |
| 100 MB | **OOM-killed (exit 137)** | completes, cgroup peak 83 MB |

### arm64

| cap | naive | cached |
| --- | --- | --- |
| 300 MB | cgroup peak **300 MB** (at the cap), RSS Δ96 MB, 1,565 ms | cgroup peak **54 MB**, RSS Δ14 MB, 149 ms |
| 200 MB | cgroup peak **200 MB** (at the cap), RSS Δ55 MB, 1,648 ms | cgroup peak **82 MB**, RSS Δ15 MB, 139 ms |
| 150 MB | **OOM-killed (exit 137)** | cgroup peak **45 MB**, 161 ms |
| 120 MB | **OOM-killed (exit 137)** | cgroup peak **45 MB**, 121 ms |

Identical on both: image XObjects **240 → 12**, rasterizations **120 → 6**,
output **2,305,712 → 166,465 B**, and ~7-10x on wall clock.

**On x86_64 the naive path is OOM-killed at a 200 MB cap; the cached path
completes at every cap down to 100 MB.** The pre-fix path fails *earlier* on x86_64
than on arm64 (200 MB vs 150 MB), so the arm64 figures were the optimistic
case, not the pessimistic one. This is a qualitative difference the macOS
measurements could not show, because nothing enforced a limit there.

Rendering is **pixel-identical** on both architectures: pages 1, 60 and 120
rasterized with `pdftoppm` are byte-identical between the two arms.

## Running it

```bash
docker build -t gauge-linux-verify .
# and on Floor's production architecture:
docker build --platform linux/amd64 -t gauge-linux-amd64 .

# one mode per container: running both in one process lets the second arm
# inherit the heap the first grew, which made its RSS delta read as ~0
docker run --rm --memory=300m --memory-swap=300m --cpus=2 -e MODE=naive  gauge-linux-verify
docker run --rm --memory=300m --memory-swap=300m --cpus=2 -e MODE=cached gauge-linux-verify

# the OOM threshold
docker run --rm --memory=150m --memory-swap=150m -e MODE=naive gauge-linux-verify; echo "exit=$?"

# pixel comparison (needs poppler in the image)
docker build -t gauge-linux-cmp -f - . <<'DOCKERFILE'
FROM gauge-linux-verify
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
docker run --rm -v "$PWD/compare-pixels.sh:/probe/compare-pixels.sh" \
  gauge-linux-cmp sh /probe/compare-pixels.sh
```

`--memory-swap` equal to `--memory` disables swap, so the OOM killer fires like
a memory-starved instance instead of thrashing.

## Caveats

- **x86_64 here is Rosetta, not bare metal.** The binaries, glibc, V8 build and
  page size (4 KB) are genuinely x86_64, which is what drives the allocator and
  GC behaviour being measured; the CPU is emulated, which inflates wall clock
  (3.2 s vs 1.6 s for the same work) but does not change memory accounting.
  Treat the memory figures as representative and the timings as arm64's.
- **Reproduces the two code paths rather than importing Floor.** Floor's
  renderer needs its snapshot types and Korean fonts; the probe matches the
  gauge geometry, canvas size (430x180, `BLOCK_AVG_BAR_CHART`) and grade
  cardinality, and uses standard-14 fonts. Font cost is identical in both arms
  so it cancels from the comparison. The end-to-end figures against Floor's
  real `renderUnitAnalysisPages` are in
  `apps/backend/scripts/bench/unit-gauge-dedupe/` in the Floor repo.
- The absolute RSS deltas move a few MB between runs. `cgroupPeak` moves much
  more (it includes page cache and the qpdf subprocess), so quote `rssPeak`.
  The XObject counts, the OOM threshold, and the output sizes are stable across
  every run.
