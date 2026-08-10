# Engineering standards for shardpdf — derived from the ecosystem, with gap analysis and plan

**Date:** 2026-08-10
**Status:** Adopted reference. Publishing is frozen until the library is declared done;
every item here is about internal quality, not release.

**Sources studied** (real files fetched, not memory): napi-rs official docs;
resvg-js; LightningCSS; swc; oxc; rolldown; nodejs-polars; sharp;
better-sqlite3; execa; undici. Three research reports, 2026-08-10.

## The standard

Conventions that recur across the studied libraries, deduplicated. Each cites its
strongest exemplar.

### Rust / boundary

- **S1. Separate binding crate.** The napi layer is its own crate
  (`crate-type = ["cdylib", "lib"]`), thin, conversion-only; the core is a pure-Rust
  `rlib` with no napi dependency. Universal across swc (`bindings/*`), oxc (`napi/*`),
  rolldown (`rolldown_binding`), LightningCSS (`napi/` + `node/` shell); nodejs-polars
  achieves the same isolation via a separate repo. Feature-gating inside one crate
  (our current shape) appears only in the smallest library studied (resvg-js).
- **S2. `AsyncTask` for heavy operations, with owned inputs.** CPU-bound native work
  runs on the libuv pool via the `Task` trait; the task *owns* its inputs (Buffer
  field, `mem::take`, clone) so nothing borrows across the await. `AbortSignal` wired
  with `AsyncTask::with_signal`. tokio only when the core itself is async (rolldown —
  and it pays with a custom-tuned runtime). oxc documents when async is a *loss*
  (main-thread deserialization dominates) — the policy must be argued, not assumed.
- **S3. Sync-default naming.** The unmarked name is sync; the promise variant carries
  an `Async` suffix (resvg-js `render`/`renderAsync`, LightningCSS
  `bundle`/`bundleAsync`) — or the high-level wrapper API is async-only and says so
  (sharp). Either way the blocking behavior of every call is documented
  (better-sqlite3 argues its sync-only stance from the runtime model; that's the bar).
- **S4. Explicit panic policy.** Never implicit. Either `panic = "abort"` and the core
  is trusted (LightningCSS), or `catch_unwind`/`#[napi(catch_unwind)]` at the boundary
  with a dedicated panic test file (resvg-js `index-panic.spec.ts`, polars per-method,
  swc `try_with`). For untrusted-input parsers, the catch route.
- **S5. One `thiserror` enum in the core**, `#[error(transparent)]` for upstream
  errors, domain variants with actionable messages, one `From<CoreError>` conversion
  at the boundary (resvg-js `src/error.rs`).
- **S6. Errors carry structure, not just prose.** Stable machine-readable codes plus
  context *properties* on the JS error (LightningCSS attaches `fileName`, `line`,
  `column`; undici attaches `statusCode`, `headers`, `cause`). For recoverable
  multi-item outcomes, errors-as-data in the result (oxc `errors: OxcError[]`,
  LightningCSS `warnings`).
- **S7. Buffer-friendly inputs, accounted outputs.** `Either<String, Buffer>` where a
  path is natural (resvg-js), `Buffer` outputs zero-copy, and
  `env.adjust_external_memory` + `ObjectFinalize` when native objects hold large
  allocations across calls.
- **S8. Allocator is a binding-crate concern** — mimalloc/jemalloc cfg'd per target,
  behind a release-only feature (oxc, rolldown, swc, LightningCSS).
- **S9. Committed toolchain discipline**: `rustfmt.toml` + `rust-toolchain.toml` +
  warnings-as-errors in CI; narrowly-scoped inline `#[allow]` with justification.

### TypeScript / API

- **S10. Hand-written wrapper over generated bindings — always.** None of the studied
  libraries ship generated code as the public surface. Wrapper owns: binding loading
  (with env-var override and fallbacks), idiomatic API shaping, option normalization,
  lazy experimental paths. (We conform.)
- **S11. One root error class, `name` + `captureStackTrace` + stable `code`**,
  namespaced codes (undici `UND_ERR_*`, better-sqlite3 SQLite codes), plus boolean
  discriminators where callers branch often (execa `timedOut`, `isCanceled`).
- **S12. Formulaic validation errors at every option boundary** — sharp's
  `Expected X for name but received Y of type Z` factory; caller mistakes throw
  sync (`TypeError`/`RangeError`), operation failures reject with domain errors.
- **S13. Options object; every option documented with type + default adjacent**
  (execa/undici doc style); `AbortSignal` always as a `signal` option, never
  positional, with a dedicated cancellation discriminator.
- **S14. Safety-first defaults with named escape hatches** — sharp's
  `limitInputPixels` on by default. For a PDF parser: input-size/object-count/
  recursion limits, documented.
- **S15. Memory behavior documented as API, with numbers** — sharp `cache()`
  (50MB/20 files), `concurrency()` incl. allocator caveats. Our RSS formulas belong
  in API docs, not only benchmark write-ups.
- **S16. One markdown doc per concern**, cross-linked from the API reference
  (better-sqlite3 `performance.md`/`threads.md`/`integer.md`; execa topic guides).
- **S17. `engines` floor + a published support window** (undici's LTS table is the
  strongest form).
- **S18. Types are tested artifacts** — compile-time type tests (tsd / checked
  `.d.ts` consumers) in CI. (We conform via `api-types.ts`.)
- **S19. Test the built artifact where it runs** — JS integration suites carry the
  correctness burden, executed per shipped platform (musl in Alpine Docker, arm64,
  ≥2 Node LTS, Bun where claimed); Rust tests cover the core. Leak discipline for
  native cores: valgrind harness with suppressions (sharp) or long-loop RSS tests.
- **S20. Reproducible benchmarks in-repo, cited with a runnable harness**
  (better-sqlite3). (We conform strongly.)

*(Publishing-related conventions — per-platform packages under `optionalDependencies`,
`napi prepublish` pipeline, provenance — are recorded in the reports and deferred:
no publishing until the library is done.)*

## Gap analysis — shardpdf today

**Conforms already:** S10 (wrapper), S11 (ShardPdfError + codes; boolean
discriminators partial), S12 (TypeError/RangeError vs coded domain errors), S13
(options + signal), S18 (api-types.ts), S20 (benchmark corpus + harness), most of
S19's spirit (Node + Bun suites, qpdf oracle; fuzz target exceeds several studied
libraries). Sync policy is at least documented in the README (S3, partial).

**Gaps, ranked by leverage:**

| # | Gap | Standard | Today |
| --- | --- | --- | --- |
| G1 | Binding layer lives inside the core crate behind a `node` feature | S1 | `crates/core` with `src/node.rs` + feature gate |
| G2 | No async native path; `assemble()`/`extract()` look async but block between yields | S2, S3 | All napi calls sync on calling thread |
| G3 | No explicit panic policy, no panic tests | S4 | Default unwind; fuzz shows no panics but nothing catches one at the boundary |
| G4 | Hand-rolled error enum plumbing | S5 | Manual `Display`/`From` impls |
| G5 | Errors lack structured properties (shard path, dest name live in message text) | S6 | Code + message only |
| G6 | Path-only inputs; no `Buffer` shard/source input | S7 | `appendShard(path)` only |
| G7 | No allocator selection | S8 | System allocator everywhere |
| G8 | No `rustfmt.toml` / `rust-toolchain.toml`; fmt not enforced locally | S9 | CI checks fmt; config uncommitted |
| G9 | No per-concern docs; memory numbers only in benchmark write-ups | S15, S16 | READMEs only |
| G10 | No `engines` field or support statement | S17 | Unstated |
| G11 | No parser input limits (object count, recursion depth beyond ref-chain cap) | S14 | Page ceiling exists at orchestrator level only |
| G12 | No core-level leak harness (orchestrator soak covers its own process only) | S19 | Soak test at TS level |

## Improvement plan (no publishing; API breaks are free until "done")

**Phase A — structure, behavior-preserving.**
Split `crates/core` into `crates/core` (pure Rust: assembler, serializer, outline,
extract, inspect; `thiserror` for the error enum — G4) and `crates/napi`
(`cdylib+lib`: today's `node.rs`, allocator selection per target — G7, `build.rs`);
fuzz target consumes the core directly, no more `--no-default-features` dance.
Commit `rustfmt.toml` + `rust-toolchain.toml` (G8). npm package files move with the
napi crate. CI paths updated. Exit: identical test results, identical `.d.ts`.

**Phase B — async + panic policy.**
`AsyncTask`-based native tasks for assemble-shaped and extract-shaped work (owned
inputs, `with_signal` for real native-side cancellation); JS `assemble()`/`extract()`
become genuinely non-blocking; sync low-level `Assembly`/`Extractor` remain, named
per S3 and documented per better-sqlite3's argued-policy bar (G2). Boundary
`catch_unwind` + a panic spec test with a deliberately panicking input (G3).
Exit: event-loop-latency test proves a 9k-page bind no longer blocks; abort mid-bind
cancels natively.

**Phase C — richer errors and inputs.**
Structured properties on `ShardPdfError` (`shardPath`, `destinationName`,
`pageIndex` where applicable) carried across the boundary as data, not prose (G5);
`Either<String, Buffer>` shard/source inputs with external-memory accounting where
buffers are held (G6); parser limits with safety-first defaults + escape hatch
(`limits` option — G11). Exit: error properties asserted in tests; buffer-input
parity tests against path inputs.

**Phase D — docs and guarantees.**
`docs/` per concern: `memory.md` (the RSS formulas + measured numbers as API-level
statements), `runtime.md` (sync/async table per call), `errors.md` (code catalog)
(G9); `engines` fields + support statement (G10); core-level long-loop RSS test and
an optional valgrind script (G12). Exit: every public call's blocking behavior and
memory bound is documented where a consumer will find it.

Order rationale: A is pure structure and unlocks clean placement for everything
after; B is the biggest behavioral upgrade and defines the surface names; C breaks
error/message contracts (free while unpublished); D freezes what A–C built into
documentation.
