# Canonical benchmark workload

One document definition, implemented once per runner. Every runner MUST produce a PDF with
the same logical content from the same generated data (`data.ts`, fixed seed). Comparisons
are only valid across runners implementing this spec faithfully.

## Document: "Annual Billing Report"

An invoice ledger grouped by customer — the shape of real server-side giant-PDF workloads
(billing exports, audit trails, statements).

Structure, in order:

1. **Cover page** — title, scale name, total customer/invoice counts.
2. **Table of contents** — one line per customer: name and the **page number** where that
   customer's section starts. Each TOC line MUST be an internal **link** to that page.
3. **Customer sections** — one per customer, in data order. Each section:
   - Section heading (customer name, id). MUST start on a fresh page.
   - Invoice tables: per invoice a header row (invoice id, date, total) and one row per
     line item (sku, description, qty, unit price, amount).
4. **Footer on every page** — `Page X of Y` where Y is the true total page count of the
   final document.

## Why these features

The workload is designed so every existing library fails on at least one axis:

- Sheer size → memory ceiling failures (pdf-lib, @react-pdf/renderer).
- `Page X of Y` + TOC page numbers → requires whole-document knowledge before rendering;
  streaming libraries (pdfkit) can only do this with a manual two-pass or buffering.
- TOC links → cross-document references survive (or don't) a shard-and-merge pipeline.

These are exactly shardpdf's two value claims: bounded memory and cross-shard references.

## Scales

| Scale | Invoices | Approx. pages (reference layout) |
| ----- | -------- | -------------------------------- |
| smoke | 300      | 72 (measured)                    |
| mid   | 5,000    | ~1,200                           |
| full  | 50,000   | ~12,000                          |

Page counts are emergent from layout, not fixed; the invoice count is the controlled
variable. `smoke` is for correctness during development. Only `mid` and `full` results
count as findings.

## Environment

- **Runtime: Node** (V8). Never Bun/JSC — the production claim under test is about Node
  servers. Bun is package manager and script runner only.
- **Resource cap: 2 GiB RAM, 2 vCPU** — a t3.small. Simulated locally via
  `docker run --memory=2g --cpus=2`; headline numbers confirmed once on a real t3.small.
- Node heap is NOT artificially restricted (`--max-old-space-size` left at default):
  the container limit is the boundary, as in production.

## Measurements (per run, emitted as JSON into `results/`)

- `outcome`: `ok` | `oom` | `crash` | `wrong-output`
- `peakRssBytes` (sampled), `wallTimeMs`, `outputBytes`, `pageCount`
- `machine`: tag (`local-docker` | `t3.small`), node version, library versions

## Output validation

A run only counts as `ok` if the PDF is valid and correct:

- `qpdf --check` passes (dev-only oracle, per the design spec).
- Page count matches the runner's own report.
- Spot check: footer on the last page reads `Page N of N`; a sampled TOC entry links to
  the correct page.

A fast, pretty, *wrong* PDF (bad TOC numbers, missing footers) is `wrong-output`, not a pass.
