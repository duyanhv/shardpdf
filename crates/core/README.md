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
delete shards one at a time. `appendShard(path)` reads from disk and
`appendShardBytes(bytes)` parses a `Uint8Array` (or `Buffer`) already in
memory; both return the shard's page count. Call `abort()` to close an
unfinished assembly; it is idempotent, so it is safe in a `finally` block
after `finalize()`.

All native calls are synchronous and run on the JavaScript thread. Appending a
500-page PDFKit shard blocks the event loop for roughly 50 ms in a debug build;
`assemble()` yields between shards so timers and abort handlers stay live.

### Untrusted input

Shards you rendered yourself need no limits. If a path or upload from outside
your process can reach `assemble()`, `appendShard()`, `appendShardBytes()`,
`extractPages()`, `extractSelection()`, or `pageCount()`,
pass `maxDecompressedBytes`: the parser inflates object streams eagerly on
load, and a small file can otherwise allocate gigabytes before the core sees
a page. Measured through `new Assembly()` + `appendShard()` in Node:

| File on disk | Inflates to | Unbounded | `maxDecompressedBytes: 1 MB` |
| ---: | ---: | --- | --- |
| 261 KB | 256 MB | 932 MB RSS, 3.3 s | 57 MB RSS, 5 ms, `SHARDPDF_MALFORMED` |
| 1.0 MB | 1 GB | 3.35 GB RSS, 13.3 s | 58 MB RSS, 3 ms, `SHARDPDF_MALFORMED` |

With a bound the oversized stream is skipped and the shard fails as
`SHARDPDF_MALFORMED` ("shard has no pages").

```ts
await assemble({ shards, outputPath, maxDecompressedBytes: 64 * 1024 * 1024 });
new Assembly(partialPath, { maxDecompressedBytes: 64 * 1024 * 1024 });
extractPages(input, 1, 10, output, { maxDecompressedBytes: 64 * 1024 * 1024 });
extractSelection(input, [0, 9], output, { maxDecompressedBytes: 64 * 1024 * 1024 });
pageCount(input, { maxDecompressedBytes: 64 * 1024 * 1024 });
```

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
| `SHARDPDF_INVALID_ARG`   | An argument had the wrong type, was an empty path, or was a negative, fractional, or non-finite number. Covers every `finalize()` outline field (`outline[i].pageIndex must be a non-negative integer, got 0.5`) and every `extractSelection()` page index (empty array, duplicate, or out of range). |
| `SHARDPDF_PANIC`         | The native core panicked. This is a shardpdf bug, not an input problem. The panic was caught at the binding boundary, the process is intact, and any in-progress `Assembly` should be aborted. |

Every error thrown by the native layer carries one of these codes; napi's own
conversion statuses (`StringExpected` and similar) are not exposed.

Unwinding panics inside the native core are caught at the boundary and surface
as `SHARDPDF_PANIC` errors. This does not cover process-aborting
failures such as stack overflow, `std::process::abort`, or an out-of-memory
abort in the allocator; those still terminate the host.

`extractPages(inputPath, startPage, endPage, outputPath)` slices an inclusive,
1-based page range into a new PDF, copying only objects the selected pages
reach (a `qpdf --pages` replacement for selective downloads). v1 drops all
annotations (links, form widgets, anything in `/Annots`), named destinations,
and outlines from the slice. A qpdf slice also loses bookmarks but keeps
annotations, with links to out-of-range pages left silently dangling.

`extractSelection(input, pages, outputPath)` is the zero-based form:
`input` is a path or a `Uint8Array` of PDF bytes, `pages` is an array of
zero-based indices emitted in the given order (`[4, 0, 2]` puts source page
5 first), and the source is parsed exactly once. It has the same object-copy
semantics and the same annotation, destination, and outline drops as
`extractPages`. An empty array, a duplicate, a non-integer, a negative, or an
out-of-range index is `SHARDPDF_INVALID_ARG`.

`pageCount(input)` parses a path or `Uint8Array` and returns its page count
without writing anything. Like every other native call it is synchronous:
the entire document is parsed on the JavaScript thread.
