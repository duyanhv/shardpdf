# Should the render step move to Rust? A measured answer

Date: 2026-09-18. Scope: the proposed `packages/adapter-pdfkit` and the broader
question of whether a Rust renderer would lower Floor Inspector's memory
ceiling and improve performance.

**Answer: no, not yet — and the measurements say the renderer is not where the
problem is.** The dominant cost in Floor's render child is not PDF
serialization. It is a redundant per-page `node-canvas` rasterization plus the
PDF XObject duplication it causes, both of which are removable in JavaScript.
**Both are now fixed in Floor** (`87c5535ef`), measured on its real unit
renderer at 120 units: **peak RSS −36% (351 → 223 MB), image XObjects −96%
(240 → 10), output −63%, wall −50%**, pixel-identical, with Floor's full unit
suite (2,173 tests) passing. A Rust renderer would not address
either cause, and would have to overcome an FFI cost that the same measurements
show is unfavorable for this workload.

**Scope caveat, important for planning.** A separate Floor-side benchmark run
the same day (`docs/audit/2026-09-18-shardpdf-t3small-memory-benchmark.md` in
the Floor repo) measured the whole export pipeline end to end and found the
**snapshot child**, not the render children, is the process ceiling:
1,197-1,323 MB uncapped versus ~500 MB for a render child. So this fix makes
render children meaningfully cheaper and their output much smaller, but it is
not by itself the fix for Floor's t3.small capacity problem. Read both
findings together.

All numbers below are reproducible with the probes in
`docs/benchmarks/probes/2026-09-18-render-cost/` (see its README). Host: Apple
Silicon (M-series), Node 24.14, pdfkit 0.20.2, `canvas` 3.2.3, Floor's real
`NotoSansKR` OTFs and cover assets. RSS is `/usr/bin/time -l` maximum resident
set size, plus in-process `process.memoryUsage.rss()` after a forced GC settle
at each stage. Timing figures are medians over repeated trials where noted.

---

## 1. How Floor Inspector uses PDFKit

Reviewed at `floor-inspector-backend` `apps/backend/src/domains/reporting/
reports/infrastructure/jobs/report-generation/`.

**Shape.** ~18.1k LOC across `pdf-renderer/`, five sections (`project`, `type`,
`point`, `block`, `unit`) plus a cover. `report-pdf.generator.ts` owns document
setup, font registration, a `pageAdded`-driven page counter, and a section-index
recorder. Rendering is **single-pass**: `bufferPages: false`, streaming to a
`createWriteStream`, with page numbers recorded as pages are emitted. There is
no whole-document measure pass.

**API surface actually used** (census over `pdf-renderer/`):

| Call | Count | Call | Count |
| --- | --- | --- | --- |
| `doc.font` | 227 | `doc.widthOfString` | 52 |
| `doc.text` | 186 | `doc.addPage` | 17 |
| `doc.save` / `restore` | 110 / 110 | `doc.rect` | 13 |
| `doc.heightOfString` | 56 | `doc.image` | 12 |
| `doc.roundedRect` | 53 | `doc.circle` | 12 |

Plus `lineWidth`, `dash`/`undash`, `path`, `moveTo`/`lineTo`, `fillColor`,
`fillOpacity`, `linearGradient`, `clip`, `translate`, `currentLineHeight`.
This is a **wide but shallow** surface: basic vector drawing, text, and images.
No forms, no tagging, no transparency groups, no blend modes.

**Critically, layout is interleaved with drawing.** `heightOfString` and
`widthOfString` (108 static call sites, but see §4 for the dynamic count) are
called *between* draw calls, and the next draw position depends on the result.
Card heights, chip wrapping, and text fitting (`fitTextToWidth`) are all
computed this way. There is no separate layout phase that could be batched
across an FFI boundary.

**Chunking.** `report-pdf-chunking.ts` splits a report into a head chunk
(cover + project/type/point) then windows `block` (8/chunk) and `unit`
(60/chunk). Each chunk renders in a disposable child process
(`report-pdf.child.ts`) under an in-process RSS watchdog
(`REPORT_PDF_CHILD_RSS_LIMIT_MB=700`), and chunks are assembled by
`qpdf` or, now, `@shardpdf/core` `merge()` (`shardpdf.assembler.ts`).

**No links or named destinations.** Confirmed by grep: zero `.link()`,
`addNamedDestination`, or `.outline` calls in the renderer subtree. Bookmarks
come afterwards from the section-index sidecar. So pdfkit's annotation and
destination-tree accumulation — the linear growth term identified in
`docs/benchmarks/2026-08-07-baseline.md` — **does not apply to Floor at all.**

---

## 2. Where the render memory actually goes

Cumulative RSS, Floor's real assets:

| Stage | RSS | Delta |
| --- | --- | --- |
| Node 24 baseline | 46 MB | — |
| + `require("pdfkit")` | 72 MB | +26 MB |
| + register 2 Korean OTFs (lazy, unused) | 72 MB | +0 MB |
| + first glyphs drawn (fontkit parse) | 103 MB | **+31 MB** |
| + subset written at finalize | 119 MB | +16 MB |

Font cost scales with distinct glyphs, not pages:

| Distinct glyphs | Peak RSS |
| --- | --- |
| 50 | 128 MB |
| 500 | 156 MB |
| 2,000 | 209 MB |

Images, per Floor's own JPEG fix: embedding the 802 KB JPEG cover costs
**+1 MB**; the 654 KB alpha PNG banner costs **+3 MB**. That fix was correct
and is already landed.

**pdfkit's own per-page cost is small and sublinear.** Text-heavy Floor-shaped
pages, no images:

| Pages | Peak RSS | MB/page (marginal) |
| --- | --- | --- |
| 100 | 143 MB | — |
| 400 | 170 MB | 0.09 |
| 800 | 190 MB | 0.05 |
| 1,600 | 231 MB | 0.05 |
| 3,200 | 296 MB | 0.04 |

0.04-0.09 MB/page and falling, against Floor's documented **0.85 MB/page**.
So roughly **90% of Floor's per-page slope is not pdfkit serialization.**
The RSS sawtooth in the samples (e.g. 300→123 MB at 400 pages) is V8 GC
reclaiming the content-stream garbage, confirming the streaming writer works.

---

## 3. The actual bug: a per-page canvas that renders 1 of 12 possible images

`analysis-unit.ts:535` calls `renderAverageGauge(grade, profile)` **inside the
per-unit page loop**, and passes the returned `Buffer` to `doc.image()`.

```ts
const gaugeImage = renderAverageGauge(grade, profile);
doc.image(gaugeImage, x + 18, y + 38, { fit: [w - 36, 78], ... });
```

`renderAverageGauge` is a **pure function of a 6-valued grade and a 2-valued
profile** (`NoiseGradeProfile = "FINISHED_FLOOR" | "BARE_SLAB"`, grade 1-5 or
null). Its entire output space is **12 images**. Each call does
`createCanvas(430, 180)` and `canvas.toBuffer("image/png")`.

Two independent costs follow:

1. **Rasterization**: N canvases and N PNG encodes instead of ≤12.
2. **XObject duplication**: pdfkit's `_imageRegistry` (pdfkit.js:4928) is keyed
   **by string path only** — `image(src)` only consults the registry when
   `typeof src === "string"`. A `Buffer` always misses, so every page embeds a
   *fresh* image XObject. Verified: 400 pages produced **800 `/Subtype /Image`
   objects**; deduped, **12**.

The gauge PNGs are also RGBA from `toBuffer("image/png")`, which is the
alpha-PNG case Floor's `export-engine-infra.md` warns about. That turned out to
be a red herring for *charts* (see §5 step 2: the format costs a few MB of
transient RSS per distinct chart, and JPEG would make these flat-colour images
13x **larger**). The cost that mattered was the duplication, not the format.

### Measured, 400 pages, 6 distinct grades

| Strategy | Canvases | PDF bytes | Peak RSS | Wall |
| --- | --- | --- | --- | --- |
| `naive` (what Floor does now) | 400 | 6,828,688 | **345-386 MB** | **38-45 s** |
| `memo` (memoize the Buffer) | 6 | 6,828,688 | 323 MB | 21 s |
| `memo-path` (memoize to a temp file) | 6 | 277,400 | **114 MB** | 2.6 s |
| `openimage` (memoize `doc.openImage()`) | 6 | 277,400 | **109-114 MB** | **3.1-3.6 s** |

### Confirmed on Floor's real renderer (2026-09-18, same day)

The table above is synthetic. It has since been reproduced against **Floor's
own `renderUnitAnalysisPages`**, its own `renderAverageGauge`, and its real
`NotoSansKR` OTFs, with a deterministic in-process unit fixture (no DB, Redis,
or Nest needed: the unit renderer takes a plain snapshot object). Harness:
`apps/backend/scripts/bench/unit-gauge-dedupe/` in the Floor repo.

**The fix has since shipped** (Floor `87c5535ef`): `drawNoiseGradeCard` now
memoizes the gauge per document on `(grade, profile)` and passes PDFKit an
`openImage()` handle instead of a `Buffer`. Both columns below come from that
tree, where `--naive-sim` reconstructs the old path:

| Floor's real unit renderer, 120 units | pre-fix | shipped | change |
| --- | --- | --- | --- |
| peak RSS | 351 MB | 223 MB | **−36%** |
| wall | 16.2 s | 8.1 s | **−50%** |
| output | 2,760,488 B | 1,020,047 B | **−63%** |
| image XObjects | **240** | **10** | **−96%** |
| Buffer-valued `doc.image` calls | 120 | **0** | — |

An earlier run, before the fix existed, measured the naive path at 370 MB and
19.0 s for the same shape, and 274 → 229 MB at the 60-unit chunk size; the
wall-clock numbers move a few seconds run to run, so the ratios are the result.

Output equivalence was verified on decoded pixels rather than file bytes: pages
1, 60, and 120 of the 120-unit documents are **pixel-identical** (matching
IHDR, 2,004,802 identical pixel bytes each), and both PDFs are `qpdf --check`
clean. Floor's **full unit suite passes with the fix in place: 2,173 tests
across 261 suites.**

The real-renderer gain on memory is smaller than the synthetic 3.2x because
Floor's unit pages carry far more non-image content (tables, charts, Korean
text) than the synthetic page did, so the image cost is a smaller share of the
total. The XObject collapse and output-size win reproduce almost exactly.
**−36% peak RSS at 120 units is the figure to quote.**

Note that `memo` alone (caching the Buffer) recovers the rasterization but
*not* the XObject duplication — the PDF is still 6.8 MB and RSS still 323 MB.
The fix must also let pdfkit dedupe, via `doc.openImage()` (no temp files) or a
file path.

**Output is pixel-identical.** `verify-dedupe.mjs` renders both variants and
asserts it: equal page counts, and rasterized pages compared on decoded pixels
rather than file bytes (PNG encoder metadata differs). At 120 pages it reports
pages 1, 60, and 120 all identical at 2,004,802 pixel bytes with matching
IHDR, while image XObjects collapse 240 → 12. Both PDFs are `qpdf --check`
clean — which is exactly why validity alone proves nothing here.

**The slope becomes flat.** With `openimage` at 1,200 pages: 121 MB peak, and
the per-100-page samples rise 95→121 MB, i.e. ~0.02 MB/page, versus 0.4 MB/page
naive.

**At Floor's real chunk size (60 units):** 167 MB → 107 MB peak. That is a
60 MB saving per chunk against a documented ~350 MB of free RAM on the
t3.small, and it moves the per-chunk figure well under the budget.

### Time breakdown, 200 Floor-shaped pages with the gauge

| | per page |
| --- | --- |
| Text measurement (`widthOfString`/`heightOfString`) | 2.6-2.9 ms |
| Draw + serialize (pdfkit) | 16.5-25.0 ms |
| **Canvas PNG generation** | **35.9-43.7 ms** |
| Wall clock | 104-125 ms |

With memoization the same run drops from 24.9 s to 8.1 s, and canvas falls
43.7 → 12.9 ms/page. **The single largest per-page time cost in Floor's
renderer is redundant chart rasterization, not PDF generation.** (The wall
clock exceeds the sum of the parts because of GC and stream backpressure
between the instrumented spans.)

---

## 4. Why Rust would not help here

### 4.1 The FFI cost exceeds the work per call

Floor's layout interleaves measurement with drawing, so each query is a
blocking round trip. Instrumenting one Floor-shaped unit page (6 cards, 8 table
rows each, footer) counts **713 pdfkit calls per page, 452 of them text
measurements**.

A purpose-built napi addon (release, LTO) prices the floor cost of a
`widthOfString`-shaped call — string in, `f64` out, trivial body. Medians of
9 trials x 500k iterations, since single runs vary about 2x:

| Call | Median | Range |
| --- | --- | --- |
| plain JS function call | 5 ns | 1-20 |
| napi `noop(f64) -> f64` | 351 ns | 191-671 |
| napi `widthOf(String) -> f64` | **885 ns** | 605-1,192 |
| napi `widthOf(JsString) -> f64` | 1,429 ns | 752-1,789 |

pdfkit's real `widthOfString` in JS, warm, on Korean text: **3,056 ns** median
(946-4,674). `heightOfString` with wrapping: **18,824 ns** (14,190-21,879).

So a Rust text shaper would spend **~885 ns on the boundary alone** to replace
a ~3,056 ns operation — roughly **29% of the cost it is trying to eliminate,
before doing any shaping work at all.** Even an infinitely fast Rust shaper
caps the measurement win at about **3.5x on ~2.1 ms/page, i.e. ~1.5 ms/page.**
Meanwhile the JS-only canvas fix already recovers **~23-31 ms/page**, more than
an order of magnitude more, at a fraction of the effort and risk.

This is the structural point: **the API is chatty and latency-bound, not
throughput-bound.** FFI overhead is paid per call and cannot be amortized,
because the next draw position depends on the previous measurement. A
batched or retained-mode Rust API would avoid the round trips, but that means
rewriting all 18.1k LOC of layout, not writing an adapter.

### 4.2 The memory ceiling is not set by the renderer

The child's floor decomposes as: ~46 MB Node runtime + 26 MB pdfkit module +
~31-47 MB fontkit/Korean OTF parse + snapshot payload. A Rust renderer removes
at most the 26 MB pdfkit module and *some* of the font cost, while **adding**
a native module's own footprint. It cannot remove the Node runtime (the child
is a Node process by construction) nor the snapshot data. Against a ~700 MB
watchdog and ~180 MB measured floor, that is single-digit-percent movement.

By contrast pdfkit's marginal per-page cost is already **0.04 MB/page** —
there is nearly nothing left to win. The 0.85 MB/page Floor documented is
dominated by the canvas/XObject issue above.

### 4.3 The Rust ecosystem does not cover this surface

The renderer needs Korean OpenType shaping with subsetting, `fit`/`align`
image placement, word wrap with `heightOfString`-compatible metrics, rounded
rects, dashes, clipping, gradients, and fill opacity — and must reproduce
pdfkit's layout **exactly**, or every one of Floor's hand-tuned 18.1k LOC of
coordinates shifts. Candidates (`printpdf`, `lopdf` + `rustybuzz`/`swash`,
`pdf-writer`) provide the primitives, but none provides pdfkit-compatible text
metrics. Layout equivalence would be the entire project, and its failure mode
is silent visual drift across a 12,000-page Korean report.

### 4.4 Where Rust already pays off, and why that is different

`@shardpdf/core` `merge()` is the right use of Rust: **87 MB peak and 0.16 s on
11,164 pages**, versus qpdf's 193-201 MB and 0.43-1.34 s. That works because
assembly is **one coarse call** over a whole file — the FFI cost is amortized
across thousands of pages, and the work is genuinely memory-bound parsing.
Rendering is the opposite: hundreds of fine-grained, latency-sensitive calls
per page. Same language, opposite economics.

---

## 5. Recommendation

**Do this first (JS only, hours of work, pixel-identical).** Steps 1 and 3
have since shipped; step 2 has not.

1. ~~**Memoize the per-page gauge by `(grade, profile)` and hand pdfkit a
   dedupable handle.**~~ **Done** in Floor `87c5535ef`: a per-document cache
   returns a `doc.openImage()` handle rather than a `Buffer`. Measured at 120
   units: 351 → 223 MB peak, 240 → 10 image XObjects, 2.76 → 1.02 MB output,
   16.2 → 8.1 s, pixel-identical, full unit suite green. A six-case regression
   guard asserts the embedded-image count tracks distinct charts.
2. ~~**Emit chart images as JPEG where the chart is opaque.**~~
   **Withdrawn — measured against Floor's real chart pipeline and it does not
   apply.** The 300-page synthetic comparison (PNG 320 MB peak vs JPEG 204 MB)
   embedded a *distinct* alpha PNG on every page. Floor's charts are not shaped
   that way, and the difference is decisive:

   - Charts are written to disk and passed to `doc.image()` as **file paths**
     (`chart-renderer.service.ts` `renderChartToFile`). PDFKit's
     `_imageRegistry` *is* keyed by path, so each distinct chart is parsed and
     embedded exactly once no matter how many pages draw it. Measured: 120
     draws of one path produce **1-2 image XObjects**, and going from 1 page to
     120 pages costs **+2 MB and +53 KB**, not 120x anything.
   - There are ~13 project-level charts plus roughly one per block / type, not
     one per page.

   So the cost is per *distinct* chart, and measured at Floor's largest chart
   size (1040x480) one RGBA embed costs **4 MB transient**. Across a few dozen
   charts that is real but modest, and it is **transient, not retained**.
   Meanwhile JPEG makes these charts *larger*: the same image was 3,169 B as an
   RGBA PNG and 41,034 B as JPEG (13x bigger), because charts are flat-colour
   line art, which PNG compresses far better than JPEG. Converting would trade
   a few MB of transient RSS for a much larger file and visible artefacts on
   text and thin lines.

   The cover rule in Floor's `export-engine-infra.md` still stands and is still
   correctly applied: it is about **full-bleed photographic backgrounds**
   (a 2133x3018 RGBA cover cost ~290 MB), which is a different kind of image.
   Generalizing it to charts was my error, from a probe whose per-page shape
   did not match the code.

   Probe: `apps/backend/scripts/bench/unit-gauge-dedupe/chart-format.ts`.
3. ~~**Add a regression guard.**~~ **Done** alongside step 1
   (`test/unit/.../shared/unit-gauge.cache.spec.ts`). It asserts the count of
   images PDFKit actually embedded, not the cache's own `size` — re-`set`ting
   one Map key leaves the size unchanged while still embedding a copy per call,
   so the obvious assertion would have been vacuous. Two of its six cases fail
   if the cache is bypassed, verified by mutation. This is the check that would
   have caught the original issue: it is invisible to `qpdf --check`, which
   passes on both the 240-object and 10-object documents.

Then re-measure. My estimate is that the per-page slope lands near
**0.05-0.10 MB/page**, which makes the 12,000-page ceiling a wall-clock
question rather than a memory one, and may make the block/unit chunk windows
enlargeable (fewer children, less fixed floor paid per chunk).

**On `packages/adapter-pdfkit`:** still worth building, but as a
**pdfkit-hosting adapter** for the orchestrator's `measure`/`render` contract,
*not* as a Rust renderer. Its value for Floor is two-pass capability (correct
`Page X of Y` and TOC page literals at the source) and resume, not speed. Note
Floor does not currently need two-pass: it is single-pass by design and gets
outlines from sidecars, so keep this driven by demand.

**Revisit a Rust renderer only if** a future workload is (a) throughput-bound
rather than latency-bound, (b) able to use a batched/retained-mode API so FFI
is amortized, and (c) willing to accept new layout rather than pdfkit
equivalence. Absent all three, the measurements say the renderer should stay
in JavaScript and the Rust core should stay in assembly, where it is already
winning by 2.2x on memory and up to 8x on time.

---

## 6. Reproducing

Full instructions in
[`docs/benchmarks/probes/2026-09-18-render-cost/README.md`](../benchmarks/probes/2026-09-18-render-cost/README.md).

```bash
cd docs/benchmarks/probes/2026-09-18-render-cost
export FLOOR_ROOT=~/works/floor-inspector-backend   # supplies pdfkit, canvas, assets

# the headline: four strategies at 400 pages
for s in naive memo memo-path openimage; do
  /usr/bin/time -l node --expose-gc dedupe-probe.mjs 400 $s
done

# proves the fix changes no pixels and collapses the XObjects
node verify-dedupe.mjs 120

# per-stage memory decomposition (fonts, cover, per-page slope)
node --expose-gc probe.mjs baseline
node --expose-gc probe.mjs fonts
node --expose-gc probe.mjs cover
node --expose-gc probe.mjs pages 800

# chart image format
node --expose-gc format-probe.mjs 300 png
node --expose-gc format-probe.mjs 300 jpeg

# per-page call census, measurement cost, and time split
node callcount.mjs
node measure-cost.mjs 9
node timing.mjs

# FFI round-trip pricing
cargo build --release --manifest-path ffi-bench/Cargo.toml
node ffi-bench.mjs 9
```

## 7. Caveats

- Apple Silicon, uncapped. Floor's own docs note the per-page slope is ~1.5x
  higher on macOS than on their Linux box while the *floor* is platform-stable,
  so the ratios above should hold but the absolute MB/page should be
  re-measured on the t3.small before being quoted.
- The Floor-shaped page in these probes is synthetic: 6 cards, 8 table rows,
  a footer, Korean labels, one gauge. It reproduces the measured call census
  (713 calls/page, 452 measurements) but is not a real report. The canvas
  finding does not depend on that shaping — it is a property of
  `renderAverageGauge`'s 12-value output space and pdfkit's path-only
  `_imageRegistry`, both read directly from source.
- The 12.7x speedup at 400 pages partly reflects that the naive path also pays
  a large finalize cost for 800 XObjects; at Floor's 60-unit chunk size the
  wall-clock win is smaller than the RSS win.
- Confirm the gauge memoization against a real report before shipping: the
  claim "output space is 12 images" rests on `renderAverageGauge` taking only
  `(grade, profile)`, which is true at `average-gauge.renderer.ts:147` today
  but is an invariant a future signature change could break. The regression
  guard in step 3 is what keeps it honest.
