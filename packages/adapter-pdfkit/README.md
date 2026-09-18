# @shardpdf/adapter-pdfkit

Renders orchestrator shards with [PDFKit](https://pdfkit.org). Sections become
templates with a cheap `pages()` measurement and a `draw()` per page, so the
two-pass protocol can print correct `Page X of Y` and TOC page numbers.

```ts
import PDFDocument from "pdfkit";
import { createPdfkitAdapter } from "@shardpdf/adapter-pdfkit";

export const adapter = createPdfkitAdapter<Section>({
  createDocument: () => {
    const doc = new PDFDocument({ size: "A4", bufferPages: false });
    doc.registerFont("Body", "./fonts/NotoSansKR-Regular.otf");
    return doc;
  },
  kindOf: (data) => data.kind,
  templates: {
    unit: {
      pages: (data) => data.units.length,
      anchors: (_data, id) => [{ name: `sec:${id}` }],
      draw(doc, data, page) {
        const unit = data.units[page.pageIndexInSection];
        doc.font("Body").fontSize(12).text(unit.name, 40, 40);
        doc.text(`Page ${page.absolutePageNumber} of ${page.totalPages}`, 40, 760);
      },
    },
  },
});
```

Then point a plan at the module — workers load it by specifier in a child
process, so it must be a real file, and section data must be plain JSON:

```ts
await generate(
  {
    adapter: { module: "/abs/path/my-adapter.ts", export: "adapter", version: "v1" },
    sections: [{ id: "u1", data: { kind: "unit", units }, pageEstimate: units.length }],
  },
  { outputPath: "out/report.pdf", maxPagesPerShard: 400 },
);
```

## The two passes

`pages()` runs in pass 1 and **must not draw**. It must also be deterministic:
the orchestrator re-checks the count in pass 2 and fails the run with
`DeterminismError` rather than shipping a document whose TOC disagrees with
itself. `draw()` runs in pass 2, once per page, with the page already created
(never call `addPage()` yourself).

`anchors()` names positions relative to the section's own first page. The
orchestrator resolves them to absolute pages, exposes the map to every
`draw()` as `page.anchorPages`, and targets `outline` entries at them.

## Images: use the cache

Every `draw()` receives `page.images`, a per-document cache:

```ts
const gauge = page.images.get(`gauge:${grade}:${profile}`, () =>
  renderGaugePng(grade, profile),
);
doc.image(gauge, 40, 80, { width: 200 });
```

This is not a convenience. The measured failure it prevents
([audit](../../docs/audits/2026-09-18-render-in-rust-evaluation.md)) needed two
mistakes at once:

1. Rasterizing per page when the chart was a pure function of a low-cardinality
   key — Floor Inspector's gauge has 12 possible outputs but ran once per unit.
2. Passing PDFKit a `Buffer`. Its `_imageRegistry` is keyed by string *path*
   only, so a `Buffer` always misses and embeds a **fresh image XObject per
   page**.

At 400 pages that measured 800 image objects instead of 12, 345-386 MB peak RSS
instead of 109-114 MB, and a 6.83 MB file instead of 0.28 MB — while
`qpdf --check` passed on both, which is why nobody noticed.

`get()` fixes both: it memoizes the rasterize callback, and it returns an
embedded *handle* rather than bytes, so there is no `Buffer` left for a caller
to pass repeatedly.

Two rules:

- **The key must capture every input.** A key that omits one silently draws the
  wrong picture. This is the one thing the cache cannot check for you.
- **Prefer JPEG for opaque images.** PDFKit byte-passes JPEG but fully decodes
  alpha PNGs: 204 MB vs 320 MB peak across 300 pages in the same audit.

The cache is per document, so each shard builds its own — PDFKit image handles
belong to the document that opened them and must never cross shards. Rasterize
cost is therefore `distinct images x shards`, not `pages`.

## Why PDFKit and not Rust

Measured, not assumed. PDFKit's marginal cost is already 0.04-0.09 MB/page and
falling (3,200 pages: 296 MB peak). The drawing API is latency-bound: a
Floor-shaped page makes 713 PDFKit calls, 452 of them text measurements whose
results feed the next draw position, so they cannot be batched. A napi round
trip costs 885 ns median against a 3,056 ns `widthOfString`, so a Rust shaper
would spend ~29% of the cost it is trying to eliminate on the boundary alone.

Rust earns its place in `@shardpdf/core`'s assembly, where one coarse call
amortizes across thousands of pages (87 MB and 0.16 s on 11,164 pages). Same
language, opposite economics. Full numbers and reproduction in the audit.

## Installing it (current constraint)

This package ships **TypeScript source**, like `@shardpdf/orchestrator`. Two
consequences, both measured by `smoke/adapter-consumer/run.sh`:

- **Bun consumes an installed tarball fine.** Verified end to end from outside
  the monorepo: 90 pages over 3 shards, 15 image XObjects, outline intact,
  `qpdf --check` clean.
- **Node cannot.** `import` of the installed package fails with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, because Node refuses to strip
  types inside `node_modules`. This affects the orchestrator identically and is
  pre-existing, not specific to this package. Until these packages ship
  compiled JS, a Node host must consume them from source (the workspace) rather
  than from a tarball.

`@shardpdf/orchestrator` and `pdfkit` are **peer** dependencies: an adapter is
a plugin, and the host must own both versions. Since neither shardpdf package
is published yet, an external consumer installs `file:` tarballs the way Floor
Inspector already does for `@shardpdf/core`.

**Authoring does not require the native core.** Defining templates and calling
`measure()` work with `@shardpdf/core` absent; only `generate()` (assembly)
needs the Rust binary. That holds because this package imports `defineAdapter`
from the deep `@shardpdf/orchestrator/adapter` path rather than the package
barrel, which re-exports `generate()` and therefore pulls in the `.node`
binary. The consumer smoke test asserts it by deleting `@shardpdf/core` and
authoring an adapter anyway.

## Errors

| Error | When |
| --- | --- |
| `UnknownSectionKindError` | `kindOf()` returned a kind with no template |
| `InvalidPageCountError` | `pages()` returned a non-positive or non-integer |
| `RangeError` | an anchor targets a page outside its section |
| `TypeError` | bad options, or a bad image-cache key / rasterize result |

These are thrown inside a worker, so `generate()` surfaces them as
`ShardRenderError` with the original on `.cause` (`name` and `code` survive the
process boundary).

## Tests

```bash
bun run --cwd packages/adapter-pdfkit test
```

Eight tests, run through the orchestrator's real `generate()` so the worker
boundary, two-pass scheduling, and Rust assembly are all exercised. The
load-bearing one asserts image XObjects track *distinct images* rather than
page count; `dedupe-control.test.ts` is its negative control, reproducing the
naive `Buffer` pattern to prove the guard still fails when the bug is present.
Verified by mutation: bypassing the cache in the fixture makes the guard report
120 rasterizes instead of 6.

qpdf is an optional oracle; structural assertions skip without it.

The packaged-consumption path is separate, and is what catches defects the
in-repo tests structurally cannot (a `workspace:*` dependency, a missing
subpath export, a native-binary requirement leaking into authoring):

```bash
bun run smoke:adapter
```
