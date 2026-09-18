# Render-cost probes (2026-09-18)

Evidence for [`docs/audits/2026-09-18-render-in-rust-evaluation.md`](../../../audits/2026-09-18-render-in-rust-evaluation.md):
should Floor Inspector's PDF *rendering* move from PDFKit to Rust?

These are measurement probes, not tests. They are not wired into `bun run test`
and they need a host application to measure.

## Setup

The probes deliberately load `pdfkit` and `canvas` from the **host
application**, and use its real Korean OTFs and cover assets, because the
question is about that application's costs and dependency versions. Nothing is
vendored here.

```bash
export FLOOR_ROOT=~/works/floor-inspector-backend
```

Override asset locations with `PROBE_FONT_DIR` / `PROBE_COVER_DIR`, and the
scratch directory with `PROBE_OUT_DIR` (defaults under the OS temp dir). Any
app with `pdfkit` + `canvas` and a `NotoSansKR-{Regular,Bold}.otf` pair works.

`--expose-gc` is required wherever RSS is reported: each stage settles the GC
before sampling so the deltas are attributable.

## The headline result

```bash
# 386 MB / 45 s  ->  114 MB / 3.6 s, pixel-identical
for s in naive memo memo-path openimage; do
  /usr/bin/time -l node --expose-gc dedupe-probe.mjs 400 $s
done

# proves the fix changes no pixels, and collapses 800 image objects to 12
node verify-dedupe.mjs 120
```

`dedupe-probe.mjs` is the load-bearing probe. Floor's per-page gauge is a pure
function of `(grade, profile)` — at most 12 distinct images — but it
rasterizes one per page and passes a `Buffer`, which misses pdfkit's
path-keyed `_imageRegistry` and embeds a fresh XObject every page.

## The rest

| Probe | Question |
| --- | --- |
| `probe.mjs <stage> [pages]` | Stagewise RSS: node, pdfkit module, Korean OTF parse, cover embed, per-page slope. Stages: `baseline`, `fonts`, `cover`, `pages`, `pages-images`. |
| `font-probe.mjs [glyphs]` | Does font cost scale with glyphs or pages? (Glyphs.) |
| `format-probe.mjs <pages> <png\|jpeg>` | Is the per-page chart format a memory slope? (320 vs 204 MB at 300 pages — but see the caveat below: this shape does not match Floor, and the conclusion drawn from it was withdrawn.) |
| `canvas-probe.mjs <pages> <canvas\|embed>` | Splits canvas rasterization from pdfkit embedding. |
| `callcount.mjs` | Per-page pdfkit call census: 713 calls, 452 blocking measurement queries. |
| `measure-cost.mjs [trials]` | Median cost of pdfkit's `widthOfString`/`heightOfString`. |
| `ffi-bench.mjs [trials]` | Median cost of a `widthOfString`-shaped napi round trip. Needs the addon built. |
| `timing.mjs` | Per-page wall-clock split: measurement vs draw/serialize vs canvas PNG. |
| `draw-split.mjs`, `draw-why.mjs` | What inside "draw" costs: Korean vs ASCII text, vectors, zlib. |

The FFI addon is a standalone crate, excluded from the workspace in the root
`Cargo.toml`:

```bash
cargo build --release --manifest-path ffi-bench/Cargo.toml
node ffi-bench.mjs
```

## Reading the numbers

- Run timing probes several times. `measure-cost.mjs` and `ffi-bench.mjs`
  report medians because single runs vary about 2x with GC timing and
  glyph-cache warmth; `timing.mjs` and the `dedupe-probe.mjs` wall clocks do
  not, so compare their *ratios* rather than absolute values.
- RSS figures are Apple Silicon and uncapped. Floor's own docs note the
  per-page slope runs ~1.5x higher on macOS than on their Linux box while the
  floor is platform-stable, so re-measure on the target instance before
  quoting absolutes.
- The "Floor-shaped page" in these probes is synthetic (6 cards, 8 table rows,
  footer, Korean labels, one gauge). It reproduces the measured call census but
  is not a real report. The dedupe finding does not depend on that shaping: it
  follows from `renderAverageGauge`'s 12-value output space and pdfkit's
  path-only image registry, both read from source, and it was later confirmed
  on Floor's real renderer.
- **`format-probe.mjs` embeds a distinct image on every page, and that shape
  misled me.** It is a fair measurement of *that* workload, but Floor passes
  charts as file paths, which pdfkit dedupes, and has roughly one chart per
  block/type rather than one per page. The "convert charts to JPEG"
  recommendation drawn from this probe was measured against the real pipeline
  and **withdrawn** (audit §5 step 2): the cost is per distinct chart, not per
  page, and JPEG makes flat-colour chart line art ~13x larger. Treat this probe
  as answering "what does a distinct alpha PNG per page cost", not "what should
  Floor's chart format be".
