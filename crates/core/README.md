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
signal is observed. Pass `onShard` to observe each shard's page count as it is
appended; throwing from it aborts the assembly.

The low-level `Assembly` class remains available when callers need to append and
delete shards one at a time. Call `abort()` to close an unfinished assembly; it
is idempotent, so it is safe in a `finally` block after `finalize()`.

All native calls are synchronous and run on the JavaScript thread. Appending a
500-page PDFKit shard blocks the event loop for roughly 50 ms in a debug build;
`assemble()` yields between shards so timers and abort handlers stay live.

`buildInfo()` returns `{ profile: "release" | "debug", version }` for the
loaded binding. The benchmark harness refuses to record a debug build without
`--allow-debug`; check it whenever a timing looks off.

## Errors

Native errors carry a stable `code` (typed as `ShardPdfErrorCode`):

| `code`                   | Meaning                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `SHARDPDF_PDF_PARSE`     | The input exists but could not be parsed as a PDF.                  |
| `SHARDPDF_IO`            | Filesystem failure: input missing or unreadable, output unwritable. |
| `SHARDPDF_MALFORMED`     | Structural problem: no pages, cyclic parents, duplicate destination, bad outline, bad page range. |
| `SHARDPDF_CONSUMED`      | Method called on an `Assembly` already finalized or aborted.        |
| `SHARDPDF_INVALID_ARG`   | An argument had the wrong type, was an empty path, or was a negative, fractional, or non-finite number. Covers every `finalize()` outline field (`outline[i].pageIndex must be a non-negative integer, got 0.5`). |

Every error thrown by the native layer carries one of these codes; napi's own
conversion statuses (`StringExpected` and similar) are not exposed.

Unwinding panics inside the native core are caught at the boundary and surface
as ordinary JavaScript exceptions. This does not cover process-aborting
failures such as stack overflow, `std::process::abort`, or an out-of-memory
abort in the allocator; those still terminate the host.

`extractPages(inputPath, startPage, endPage, outputPath)` slices an inclusive,
1-based page range into a new PDF, copying only objects the selected pages
reach (a `qpdf --pages` replacement for selective downloads). v1 drops link
annotations, named destinations, and outlines from the slice — a qpdf slice
also loses bookmarks, and keeps links only as silently dangling targets.
