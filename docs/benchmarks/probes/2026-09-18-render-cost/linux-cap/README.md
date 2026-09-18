# Linux verification under a real memory cap

The audit's numbers are macOS and uncapped. Floor runs on a Debian EC2 host
under a per-child RSS budget, so the question that actually matters is whether
the gauge-dedupe conclusion survives glibc, a different allocator, and a real
cgroup limit. It does, and more sharply than on macOS.

## Result

`node:24-bookworm-slim` (glibc, matching Floor's host, not Alpine/musl),
linux/arm64, Node 24.21, pdfkit 0.20.2, canvas 3.2.3, 120 pages drawing from 6
distinct gauges. One mode per container.

| cap | naive | cached |
| --- | --- | --- |
| 300 MB | cgroup peak **300 MB** (at the cap), RSS Δ96 MB, 1,565 ms | cgroup peak **54 MB**, RSS Δ14 MB, 149 ms |
| 200 MB | cgroup peak **200 MB** (at the cap), RSS Δ55 MB, 1,648 ms | cgroup peak **82 MB**, RSS Δ15 MB, 139 ms |
| 150 MB | **OOM-killed (exit 137)** | cgroup peak **45 MB**, 161 ms |
| 120 MB | **OOM-killed (exit 137)** | cgroup peak **45 MB**, 121 ms |

Also constant across every run: image XObjects **240 → 12**, rasterizations
**120 → 6**, output **2,305,712 → 166,465 B**, and ~10x on wall clock.

**The naive path is OOM-killed by the kernel at a 150 MB cap; the cached path
completes at 120 MB using 45 MB.** That is a qualitative difference the macOS
measurements could not show, because nothing enforced a limit there.

Rendering is **pixel-identical** on Linux too: pages 1, 60 and 120 rasterized
with `pdftoppm` are byte-identical between the two arms.

## Running it

```bash
docker build -t gauge-linux-verify .

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

- **arm64, not x86_64.** Floor's EC2 host is x86_64; this is Apple Silicon
  Docker. Allocator behaviour is close but not identical, so treat the OOM
  threshold as indicative rather than an exact production number.
- **Reproduces the two code paths rather than importing Floor.** Floor's
  renderer needs its snapshot types and Korean fonts; the probe matches the
  gauge geometry, canvas size (430x180, `BLOCK_AVG_BAR_CHART`) and grade
  cardinality, and uses standard-14 fonts. Font cost is identical in both arms
  so it cancels from the comparison. The end-to-end figures against Floor's
  real `renderUnitAnalysisPages` are in
  `apps/backend/scripts/bench/unit-gauge-dedupe/` in the Floor repo.
- The absolute RSS deltas move a few MB between runs; the XObject counts, the
  OOM threshold, and the output sizes are stable.
