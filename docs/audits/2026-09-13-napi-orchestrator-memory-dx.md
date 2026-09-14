# Audit: napi boundary, orchestrator, memory, developer UX

**Date:** 2026-09-13
**Scope:** `crates/core` (Rust + napi + JS wrapper), `packages/orchestrator`,
memory model, build/test/CI ergonomics. Every finding below was reproduced
locally before being classified, and every fix was validated with qpdf 12.4.1
as the oracle (installed for this audit; see §7). Items marked **fixed** landed in commits
`d7fee2e`, `a990aea`, `39a19f7`, `bbfaaba`, and the name-tree commit after.

## Summary

The core design is sound: the one-shard working set is real (5 MB peak
delta per 500-page append under an external sampler, release build), the fuzz harness and the
`mutated_shards_never_panic` test cover the parser boundary, and the atomic
partial-then-rename discipline is correct. The audit found two output
correctness bugs in the assembler that no existing test exercised, a napi
layer that could abort the host process on a Rust panic, and an orchestrator
that duplicated (and subtly diverged from) the core's assembly path.

| Area | Found | Fixed | Deferred |
| --- | --- | --- | --- |
| Rust core correctness | 3 | 3 | 0 |
| napi boundary | 5 | 5 | 0 |
| JS wrapper | 2 | 2 | 0 |
| Orchestrator | 7 | 6 | 1 |
| Memory | 0 bugs, 1 measurement error corrected | n/a | 1 |
| Developer UX | 4 | 4 | 0 |

## 1. Rust core

### 1.1 Object generation numbers were not normalized (fixed, high)

`renumber_objects_with` keeps each object's source generation. A shard that
went through incremental updates (any object with `N G obj` where G > 0)
produced output where the header says `5 2 obj`, references say `5 2 R`, but
the fresh xref table claims generation `00000`. Strict readers reject that;
lenient ones repair it silently. Reproduced with a hand-built shard; the
regression test `non_zero_generations_are_normalized` fails on the old code.

Fix: `normalize_generations()` collapses every id and reference to gen 0 after
renumbering. Numbers are already unique, so this cannot collide.

### 1.2 ObjStm / XRef containers were copied into the output (fixed, high)

lopdf unpacks `/Type /ObjStm` containers and `/Type /XRef` streams but leaves
the containers in `Document.objects`. The assembler copied them verbatim, so
for any producer that packs objects (qpdf `--object-streams=generate`, pdf-lib
with `useObjectStreams`, most PDF/A and Acrobat output) every packed object
appeared twice: once unpacked, once as dead bytes inside an orphan blob.

Scope correction after measurement: pdfkit 0.19 (this project's primary
renderer) does **not** emit object streams (0 `ObjStm` in a 200-page shard),
so the Floor Inspector pipeline was not hit by this. It matters for shards
from other tools and for `extractPages` on third-party PDFs. A stray xref stream was also emitted as a
regular object. Output still parsed, but was up to 2x larger than necessary
and contained a structure readers are not supposed to find mid-file.

Fix: `is_structural_only()` strips ObjStm, XRef, and `/Linearized` before
renumbering. Regression test `object_stream_containers_are_not_copied`.

### 1.3 Observations (no change)

- `resolve()` bounds reference chains at 32 and `push_down_inherited` detects
  `/Parent` cycles. Good.
- `walk_name_tree` had no cycle guard. A `/Kids` array referencing its own
  node recursed until stack overflow. Fixed with a `visited` set and a
  `cyclic_name_tree_is_rejected` test (low likelihood, but the parent-chain
  walk already had the same guard, so this was an inconsistency).
- `finalize()` writes the xref with `for offset in self.offsets.values()`
  relying on `BTreeMap` iteration order matching `1..size`. The preceding gap
  check guarantees this. Correct, but the coupling is implicit; a comment
  would help the next reader.
- `extract_pages` drops `/Annots` wholesale. Documented as v1 scope. Note this
  also drops widget annotations (form fields), not just links.

## 2. napi boundary (`node.rs`)

### 2.1 Panics aborted the process (fixed, high)

None of the bindings used `catch_unwind`. napi-rs's default is to let a Rust
panic unwind across the FFI boundary, which is UB and in practice aborts Node.
The core is written defensively, but `outline.rs` has two `expect()` calls and
lopdf itself is a large dependency. All bindings now carry
`#[napi(catch_unwind)]`; an *unwinding* panic becomes a JS exception.
`catch_unwind` cannot intercept process-aborting failures (stack overflow,
allocator OOM abort, `process::abort`, or a build with `panic = "abort"`);
those still terminate the host, and the README says so.

### 2.2 No machine-readable error codes (fixed, medium; tightened after review)

Every error was `Error::from_reason(msg)` with `code: "GenericFailure"`.
Tests matched on `/pdf error/i` and `/malformed/i`. A custom `ErrorCode`
status type now yields `error.code` in
`SHARDPDF_PDF_PARSE | IO | MALFORMED | CONSUMED | INVALID_ARG`, exported as
`ShardPdfErrorCode` in `index.d.ts`.

External review found two gaps in the first version of this fix, both now
closed:

- A missing input file reported `SHARDPDF_PDF_PARSE`, because lopdf wraps
  the `io::Error` in its own type. `From<lopdf::Error>` now unwraps
  `lopdf::Error::IO` into `AssemblyError::Io`, so missing is `SHARDPDF_IO`
  and corrupt is `SHARDPDF_PDF_PARSE`.
- A wrong-typed argument (`extractPages(42, ...)`) surfaced napi's own
  `StringExpected` status, outside the advertised union. String and number
  parameters are now taken as `Unknown` and validated in Rust, so every
  argument failure is `SHARDPDF_INVALID_ARG` naming the parameter and the
  type received. `ts_args_type` keeps the generated `.d.ts` unchanged.

### 2.3 Silent integer truncation (fixed, medium)

`extractPages(path, 1.7, 1, out)` ran with `startPage = 1`.
`extractPages(path, -1, ...)` ran with `startPage = 4294967295` and produced
the confusing message `invalid page range 4294967295-1`. Parameters are now
`f64` and validated in Rust before the cast.

### 2.4 `abort()` threw after `finalize()` (fixed, low)

The JS wrapper's `finally` block had to wrap `abort()` in a try/catch. `abort`
is now idempotent and `Assembly.consumed` is exposed.

### 2.5 All calls are synchronous (documented, not changed)

`appendShard` runs on the JS thread. Measured: a 500-page pdfkit shard blocks
for ~57 ms in a debug build (200 tiny shards allowed only 3 timer ticks). This
is a design choice with real upside (no cross-thread `Assembly` ownership, no
`Send` bound on lopdf `Document`) and `assemble()` yields between shards. It is
now stated in the doc comments, the `.d.ts`, and the README. If a host needs
a fully non-blocking API, the path is `AsyncTask` with `Assembly` behind a
`Mutex`, which is a contained change.

## 3. JS wrapper (`index.js`, `index.d.ts`)

- `onShard(info)` callback added so the orchestrator can verify per-shard
  page counts without reimplementing the partial-file lifecycle.
- Input validation was already thorough. Added a check that `onShard` is a
  function.
- CJS with explicit `module.exports.X = ...` assignments for ESM named-import
  detection is correct and tested.

## 4. Orchestrator

### 4.1 Duplicated assembly path with a fixed partial name (fixed, high)

`generate.ts` built its own `new Assembly(`${outputPath}.partial`)` loop
instead of calling `assemble()`. Two consequences:

- Two concurrent `generate()` calls to the same `outputPath` (or a retry
  racing a hung previous run) would open the same partial file and corrupt
  each other. The core's `assemble()` uses `pid + UUID`.
- On error it called `rm(partialPath)` while the Rust `BufWriter` still held
  the file open. Works on POSIX, fails with `EBUSY` on Windows.

Now delegates to `assemble()` with the `onShard` hook enforcing
`DeterminismError`.

### 4.2 Outline validated after the render pass (fixed, medium)

An outline entry with a typo'd anchor name failed only after every shard had
been rendered. Validation now happens right after pass 1; the test asserts
zero `render` progress events on failure.

### 4.3 Cache key ignored adapter version (fixed, high for production)

Keys hashed `{module, export, sections, ctx}`. Editing the adapter's template
or bumping a font left the module path unchanged, so a resumed run reused
stale shards. The design spec explicitly lists "renderer/adapter version,
template version, font version" as required key inputs. `AdapterRef.version`
is now an opt-in string folded into every key, with a test that bumping it
re-renders all shards.

### 4.4 Abort listener leaked per call (fixed, medium)

`WorkerPool` added an `abort` listener to the caller's signal and never
removed it. A long-lived signal (one per server process, say) accumulated one
listener per `generate()` call. `dispose()` is now called in a `finally`, and
the test checks `getEventListeners(signal, "abort").length` is unchanged.

### 4.5 Semaphore handoff race (fixed, low)

`release()` did `running--` then woke a waiter, who then did `running++`.
Between those two steps a fresh `acquire()` could see `running < concurrency`
and slip in, briefly exceeding the cap. Slots are now handed directly to the
waiter with `running` held constant.

### 4.6 One process per task (deferred, design)

`fork()` per measure and per render is the documented isolation choice and it
delivers the memory promise. Measured cost: 103 ms per task for fork + Node
startup + pdfkit adapter load + a trivial measure (sequential, N=10, Apple
Silicon). For a 30-shard document that is 60 process spawns.
A warm pool with a max-tasks-per-worker recycle would keep isolation for
crashes while amortizing startup; the spec's `ResourcePolicy.maxWorkerRssMb`
would be the natural trigger. Not changed: it is a tuning decision the
benchmark should drive.

### 4.7 Concurrent `generate()` calls sharing a cache (fixed after external review, high)

My first pass claimed the manifest's unique temp names made last-writer-wins
safe. External review of the report showed that claim was false on two
counts, both reproduced:

- **Temp-name collision.** Names were `<manifest>.<pid>.<counter>`. Two
  `ShardCache` instances in one process (two `generate()` calls on the same
  output, hence the same default cache dir) both start the counter at 0, so
  their first persists targeted the same temp file and one `rename` failed
  with `ENOENT`. Reproduced in 3/3 trials.
- **Ordering.** Unique names do not preserve write order. An instance whose
  in-memory snapshot was stale and renamed last erased entries a newer
  snapshot had written. Reproduced: keys `[first, second]` became `[second]`.

Fix: persists to one manifest path are serialized process-wide through a
shared promise chain; every persist re-reads the on-disk manifest and merges
before writing; temp names carry a UUID. Rendered shards now go to a unique
temp path and are promoted with `rename` on completion, so only complete
files ever sit at the cache path. That also closes the truncated-shard
resume issue below. Cross-process writers are still unlocked: a lost race
costs one redundant re-render, never a wrong document. Tests:
`manifest.test.ts` plus two concurrent-`generate()` and truncated-cache
scenarios in `generate.test.ts` (10/10 external trials clean).

### 4.8 Observations

- ~~`ShardCache.getRender` checks `access(file)` but not completeness~~
  Addressed by the temp-then-rename render path in 4.7.
- `worker.ts` treats a specifier starting with `.` as pre-resolved, but
  `generate()` always absolutizes, so that branch is dead. Harmless.

## 5. Memory

No bugs found. One earlier claim in this section was not supported by its
own evidence and is corrected here.

**Measurement validity.** My first numbers came from an in-process
`setInterval` sampler (and the soak test used the same technique). That
sampler cannot fire while `appendShard` holds the event loop, so it only
observes the troughs between appends and misses the peak inside the native
parse. External review caught this. The soak test now spawns a separate
sampler process that polls `ps` every 2 ms, and all figures below were
re-measured that way.

**What "one shard" costs.** External sampler, 3 distinct pdfkit shards per
size appended back to back, delta = peak RSS during appends minus idle
baseline:

| Shard | Bytes | Debug peak delta | Release peak delta | Release multiplier |
| --- | --- | --- | --- | --- |
| 100 pages | 0.05 MB | 3.9 MB | 2.0 MB | 42x |
| 500 pages | 0.24 MB | 7.3 MB | 5.1 MB | 21x |
| 2,000 pages | 0.96 MB | 19.3 MB | 17.6 MB | 18x |

The multiplier is large and falls with shard size, which says the cost is
dominated by lopdf's per-object overhead (a `BTreeMap<ObjectId, Object>`
with heap-allocated dictionaries, names, and content `Vec`s) rather than by
the raw bytes. The earlier "3x to 5x" figure was a guess from the trough
sampler and is withdrawn. "O(largest shard)" in the spec holds, with a
constant of roughly 18x to 20x file bytes for text-heavy pdfkit output at
release; image-heavy shards with large already-compressed streams will show
a smaller multiplier because their bytes are mostly opaque blobs.

**Boundedness.** Soak with the external sampler: 1,000 pages 89 MB peak,
3,000 pages 91 MB peak (71 and 120 samples). The invariant the spec promises
holds when measured properly.

**Decompression bombs.** lopdf 0.44 exposes
`LoadOptions.max_decompressed_size` and the assembler does not set it. For
the intended use (shards the host rendered itself) this is fine. If
`extractPages` or `appendShard` ever take user-uploaded PDFs, a 1 MB shard
with a 4 GB inflate is a trivial DoS. Recommend surfacing this as an option
before that use case exists.

Timing (debug build, Apple Silicon):

| Operation | Time | Notes |
| --- | --- | --- |
| `appendShard`, 500-page pdfkit shard, 238 KB | 57 ms | blocks JS thread |
| 200 appends of a 2-page shard | 160 ms | 0.8 ms each |

## 6. Developer UX

### 6.1 Rust version floor was invisible (fixed)

lopdf 0.44 is edition 2024 and needs Rust 1.88. With an older default
toolchain, `cargo test` fails with "requires the Cargo feature called
`edition2024`", which reads like a lockfile problem. I hit this on first run.
`rust-toolchain.toml` now pins `stable` so rustup auto-selects, and
`rust-version = "1.88"` documents the floor.

### 6.2 No root README (fixed)

The repo had per-package READMEs and a spec but nothing at the root telling a
new contributor what to install and run. Added.

### 6.3 Test oracle was optional and silent (fixed)

Both test suites skip qpdf validation when it is not installed, so a green
local run was not necessarily a validated one. Worse, turbo cached the `test`
task, so after installing qpdf `bun run test` kept replaying the cached
"skipped" result. Both suites now print a one-line warning at start when
qpdf is absent, and the turbo `test` task is `cache: false`.

### 6.4 Publish path does not exist yet (deferred)

`package.json` has `"private": true`, no `optionalDependencies` for platform
packages, and `native.js` will throw "Failed to load native binding" on any
platform without a local build. CI uploads prebuilds as artifacts only. This
is appropriate for a PoC; when it is time to publish, `napi prepublish` plus
per-platform `@shardpdf/core-<triple>` packages is the standard route and
`native.js` is already generated to look for them.

### 6.5 Other

- Biome excludes the generated `native.js` / `native.d.ts`. Correct.
- `turbo.json` `test` depends on `build`, so `bun run test` at the root
  compiles the binding first. Good; documented in the README.
- `CARGO_INCREMENTAL=0` in CI and `lto = true` + `strip` in the release
  profile are the right defaults for a napi cdylib.

## 7. Verification after the fixes

### 7.1 Before/after on identical inputs

Pre-audit commit `eb73c08` was built in a separate worktree and driven with
the same inputs as the fixed core. "Old" and "new" are the same probe code
compiled against each.

| Finding | Input | Old (`eb73c08`) | New (`4f43ee1`+) |
| --- | --- | --- | --- |
| 1.1 generation mismatch | seed shard, one stream at gen 3 | `qpdf --check`: **file is damaged, expected n n obj** | clean |
| 1.2 ObjStm orphans | seed shard re-saved with object streams | 2,210 B, 1 ObjStm in output, qpdf clean | 1,336 B (−40%), 0 ObjStm, qpdf clean |
| 2.1 panic safety | temporary panicking free fn, method, and constructor | not testable on old (no binding) | all three: JS `Error` thrown, process exits 0, `Assembly` still usable after a method panic; identical under Bun |
| 4.1 fixed partial path | two `Assembly` writers on one `<out>.partial` (what two overlapping old `generate()` runs did) | `qpdf --check`: **damaged, expected n n obj** | two overlapping `assemble()` calls to one `outputPath`: clean, 0 leftover partials |
| 4.2 outline validated late | unknown anchor with `onProgress` | **1** render event before failure | 0 |
| 4.4 listener leak | 5 `generate()` calls, one signal | **5** abort listeners remain | 0 |

Note on 4.1: three trials of two real overlapping `generate()` calls on the
old code all produced a valid file. The race is real (demonstrated directly
on the shared partial path) but the window in practice requires the second
run to open the partial while the first is mid-append; with small test
shards the runs serialize on the worker pool and rarely overlap there.

### 7.2 Changed public outputs, exercised through the real entrypoint

A probe requiring `@shardpdf/core` from a consumer package, run under both
Node 24.15 and Bun 1.3.14, observed identical results:

| Public output | Observed |
| --- | --- |
| `error.code` = `SHARDPDF_PDF_PARSE` | thrown for missing input file |
| `error.code` = `SHARDPDF_MALFORMED` | thrown for inverted page range |
| `error.code` = `SHARDPDF_INVALID_ARG` | thrown for `1.5` and for `-1` |
| `error.code` = `SHARDPDF_CONSUMED` | thrown for `appendShard` after `abort` |
| `error.code` = `SHARDPDF_IO` | thrown for unwritable output directory |
| `Assembly.abort()` idempotent, `Assembly.consumed` | `false -> true`, second `abort()` no throw |
| `assemble({ onShard })` | fired `0:2/2`, `1:2/4` before duplicate-dest rejection; partial removed |
| `assemble()` output with nested outline | `qpdf --check` clean, 2 pages |
| `extractPages()` output | `qpdf --check` clean |
| `AdapterRef.version` | bumping re-rendered 3/3 cached shards (orchestrator suite) |
| `WorkerPool.dispose()` | listener count unchanged after `generate()` (orchestrator suite) |
| `ShardPdfErrorCode`, `ShardPdfError`, `AssembleShardInfo` types | consumer `tsc --strict` compiles an exhaustive switch over the code union; `@ts-expect-error` on a bad code and a non-function `onShard` both honored |
| pdfkit 0.19 shard through `assemble()` | 94,938 B in, 97,680 B out, qpdf clean (pdfkit emits no ObjStm; fix 1.2 is a no-op for it) |
| qpdf-packed shard through `assemble()` | 39,794 B in (5 ObjStm), 97,421 B out (0 ObjStm), qpdf clean |

### 7.3 Post-review pass

An external review of this report found four errors (concurrent cache use
unsafe, manifest ordering claim false, error codes imprecise, memory
sampler blind to native peaks) plus one wording issue (panic coverage). All
five are fixed in commits `0463f08` and `c76f687` and the sections above
are rewritten to match. Every claim in §4.7, §2.2 and §5 was re-measured
after the fix, and the suites below were rerun.

### 7.4 Final pass over the finished tree

The checks in 7.1 and 7.2 were developed incrementally while fixes landed.
After the last commit, the whole set was rerun once from a clean state
(`cargo clean -p shardpdf-core`, native binding deleted and rebuilt) against
HEAD `23457e0`:

| Check | Reported |
| --- | --- |
| `bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck` | no changes, 44 files clean, 3/3 tasks |
| `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings` | clean |
| `cargo test --workspace`; `--no-default-features` | 27 pass; 27 pass |
| Native rebuild, core JS suite | Node 24.15: 9/9; Bun 1.3.14: 9/9 |
| Orchestrator suite, qpdf 12.4.1 present | 19 pass, 1 skip (soak gate), link-integrity and outline checks live |
| `SOAK=1` | 1,000 pages 90 MB, 3,000 pages 93 MB, pass |
| Public-interface probe, 13 checks (5 error codes incl. NaN and post-finalize getter, abort idempotency, `onShard` + partial cleanup, qpdf on `assemble()` with non-ASCII nested outline, qpdf on `extractPages()`, ObjStm-packed shard) | 13/13 Node, 13/13 Bun, exit 0 both |
| Consumer `tsc --strict` on new type exports plus `AdapterRef.version` | compiles; 3 `@ts-expect-error` guards honored |

Working tree clean after the pass; no probe files remain.

### 7.5 Suite results


| Check | Result |
| --- | --- |
| `cargo clippy --workspace --all-targets -D warnings` | clean |
| `cargo test -p shardpdf-core` (default and `--no-default-features`) | 27 pass |
| Core JS suite, Node 24 and Bun 1.3.14 | 9 pass each |
| Orchestrator suite with qpdf present (`--force` to bypass turbo cache) | 19 pass, 1 skip (soak gate) |
| `qpdf --check` on output from an ObjStm-packed source with one object at generation 3 and an outline | "No syntax or stream encoding errors found", 0 `ObjStm` in output |
| `SOAK=1` memory-boundedness test | 1,000 pages 90 MB, 3,000 pages 93 MB, pass |

Turbo previously cached the `test` task and replayed "qpdf not installed"
skips after qpdf was installed; that is fixed (§6.3).

## What was not audited

- The `benchmarks/` harness and runners (measurement code, not shipped).
- The fuzz target beyond confirming it compiles against the
  `no-default-features` build.
- Windows behavior; all measurements are macOS. The `rm`-while-open fix in
  4.1 is reasoned, not tested on Windows.
- The bind benchmark (`benchmarks/bind`) was not rerun; output size for
  ObjStm-packed shards should now be smaller, which would only improve the
  recorded numbers.

## Suggested next steps, in order

1. Rerun the bind benchmark once against the fixed core to refresh
   `docs/benchmarks` (soak already reran: unchanged).
2. Decide whether `max_decompressed_size` should be an `Assembly` constructor
   option now or wait for an untrusted-input use case.
3. Cross-process manifest locking if two *processes* ever share a cache dir
   (4.7); today a race costs one redundant re-render.
