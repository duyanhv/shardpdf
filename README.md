# shardpdf

Memory-bounded PDF assembly and giant-document generation for Node and Bun.
Rust core exposed through napi-rs, orchestrated from TypeScript.

- **`crates/core`** (`@shardpdf/core`): streaming shard assembler. Appends
  complete single-shard PDFs to one output with a working set of one shard,
  merging page trees and named destinations and writing an `/Outlines` tree.
  Also `extractPages()` for page-range slicing.
- **`packages/orchestrator`** (`@shardpdf/orchestrator`): two-pass
  measure/render scheduler with isolated worker processes, resume cache, and
  progress events on top of the core.
- **`benchmarks/`**: the memory problem this solves, measured against
  pdf-lib, pdfkit, react-pdf, and pdf-merger-js under a t3.small-class cap.
- **`docs/specs/`**: design and implementation plan.

## Prerequisites

| Tool  | Version                        | Notes                                          |
| ----- | ------------------------------ | ---------------------------------------------- |
| Rust  | stable (1.88+, see `rust-toolchain.toml`) | `rustup` picks it up automatically |
| Bun   | 1.3.x                          | package manager and script runner              |
| Node  | 24                             | runtime for tests and benchmarks               |
| qpdf  | any                            | optional validation oracle; tests skip without it |

## Quickstart

```bash
bun install
bun run --cwd crates/core build      # compiles the native binding for this host
bun run test                          # cargo test + JS tests for core and orchestrator
bun run lint && bun run typecheck
```

`bun run test` builds the binding first through turbo. To iterate on the Rust
core alone, `cargo test -p shardpdf-core` needs no Node toolchain.

## Using the core

```ts
import { assemble } from "@shardpdf/core";

const { pageCount } = await assemble({
  shards: ["./chunk-000.pdf", "./chunk-001.pdf"],
  outputPath: "./report.pdf",
  outline: [{ title: "Report", pageIndex: 0 }],
});
```

See [`crates/core/README.md`](crates/core/README.md) for the full API, error
codes, and the low-level `Assembly` class, and
[`packages/orchestrator/README.md`](packages/orchestrator/README.md) for
two-pass generation with adapters.

## Status

Proof of concept. The native core passes qpdf validation, fuzzing, and a
soak test showing orchestrator RSS follows shard size rather than document
size. Not yet published to npm; prebuilt binaries are produced by CI as
artifacts only.
