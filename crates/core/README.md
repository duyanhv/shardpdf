# `@shardpdf/core`

Streaming native PDF assembly for Node and Bun. Existing PDFKit or renderer
pipelines can keep their current shard generation and bind the resulting PDFs
without loading the complete document into V8.

```ts
import { assemble } from "@shardpdf/core";

const result = await assemble({
  shards: ["./chunk-000.pdf", "./chunk-001.pdf"],
  outputPath: "./report.pdf",
  outline: [{ title: "Report", pageIndex: 0 }],
  signal: abortController.signal,
});

console.log(result.pageCount);
```

`assemble()` writes to a unique partial path in the output directory and only
atomically renames it to `outputPath` after native finalization succeeds. Errors
and cancellation close and remove the partial file. Cancellation is checked
between shard appends; a native append already in progress completes before the
signal is observed.

The low-level `Assembly` class remains available when callers need to append and
delete shards one at a time. Call `abort()` to close an unfinished assembly.

`extract({ input, ranges, signal? })` slices inclusive, 1-based page ranges
into new PDFs, parsing the source exactly once for any number of ranges and
removing every written slice on error or cancellation. Each slice copies only
objects its pages reach (a `qpdf --pages` replacement for selective
downloads). v1 drops link annotations, named destinations, and outlines from
slices — a qpdf slice also loses bookmarks, and keeps links only as silently
dangling targets. `extractPages(input, start, end, output)` remains as the
sync single-range convenience with the qpdf argument shape, and the low-level
`Extractor` class exposes the parse-once handle directly.

`pageCount(path)` and `validate(path)` inspect documents without a qpdf
binary — `validate` additionally verifies every named destination targets a
live page, the corruption `qpdf --check` accepts silently.

Errors from the native core are `ShardPdfError` with a stable `code`
(`PDF_PARSE`, `MALFORMED_SHARD`, `DUPLICATE_DESTINATION`, `INVALID_RANGE`,
`DANGLING_DESTINATION`, `ALREADY_FINALIZED`, `IO`). Branch on `error.code`,
never on message text. Input mistakes throw plain `TypeError`/`RangeError`;
cancellation surfaces as an `AbortError`.

All native calls are synchronous on the calling thread; `assemble` and
`extract` yield to the event loop between shards/ranges. Run heavy work in a
worker or child process if the caller also serves traffic.
