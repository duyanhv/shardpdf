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
