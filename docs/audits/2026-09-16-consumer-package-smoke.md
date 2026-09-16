# 2026-09-16 Consumer package smoke test (`@shardpdf/core`)

Covers step 4 of the release sequence in
`docs/specs/2026-09-14-public-api-floor-inspector.md`: consuming the package
from a separate project under Node and Bun, in both module systems, with the
public types checked by `tsc`.

Run it with `bun run smoke:consumer` from the repo root (or
`smoke/consumer/run.sh`). It needs a built `crates/core` (`bun run build`
there) but no Rust toolchain of its own.

## What it does

1. `npm pack` on `crates/core`, exactly the tarball `npm publish` would upload.
2. Installs it into `smoke/consumer/` (a standalone package, not a workspace
   member) as `"@shardpdf/core": "file:./vendor/shardpdf-core.tgz"`. This is
   the closest local stand-in for a registry install: the platform `.node`
   binary must come out of the tarball into `node_modules/@shardpdf/core/`.
3. Runs `cjs.test.cjs` (`require`) and `esm.test.mjs` (named and namespace
   `import`) under `node` and under `bun`. Each generates two PDFKit files
   (3 + 2 pages, with link annotations), merges them with a three-level nested
   outline, checks `getPageCount` on every file, extracts `{start: 1, end: 4}`
   with `annotations: "drop"`, asserts counts and result metadata, confirms
   `extract` without the acknowledgement rejects with `TypeError`, and runs
   `qpdf --check` on both outputs when qpdf is on `PATH` (warns and skips
   otherwise).
4. Runs `tsc --noEmit` (`module`/`moduleResolution: nodenext`) over
   `types/esm/index.ts` (ESM via a `"type": "module"` package.json) and
   `types/cjs.cts` (`import core = require(...)`). Both exercise every exported
   public type and carry `@ts-expect-error` lines for a missing `annotations`
   option, `annotations: "keep"`, and a numeric input. The script then strips
   the directives and re-runs `tsc` to prove each one is load-bearing.

## Result on 2026-09-16

| Tool | Version |
| --- | --- |
| Node | v24.15.0 |
| Bun | 1.4.2 |
| TypeScript (`tsc`, root devDependency) | 7.0.2 |
| qpdf | 12.4.1 |
| Platform | darwin arm64 (`shardpdf-core.darwin-arm64.node`, debug profile) |

All checks pass: Node CJS, Node ESM, Bun CJS, Bun ESM, `tsc` positive cases,
and 8/8 negative cases produce errors when their directives are removed.

## `crates/core/package.json` changes

Before this work `npm pack` shipped `Cargo.toml`, `build.rs`, `src/**`,
`fuzz/**`, `examples/**`, and `test/**`; `bun pm pack` additionally shipped
`.turbo/*.log`. Neither harmed loading, but the tarball was 8 MB of mostly
irrelevant files and a consumer could accidentally import `test/`.

- `files`: `index.js`, `index.d.ts`, `native.js`, `native.d.ts`, `*.node`,
  `README.md`. The tarball now contains exactly those plus `package.json`.
  `*.node` is gitignored but must be packed; `files` overrides `.gitignore`
  for listed patterns, and the run verified the binary lands in
  `node_modules/@shardpdf/core/`.
- `exports`: `"."` maps `types` to `./index.d.ts` and `default` to
  `./index.js`, plus `./package.json`. Without it, Node still resolved `main`
  fine, but `exports` locks the surface so `@shardpdf/core/native.js` and
  `@shardpdf/core/test/...` are not reachable, and gives TypeScript's
  `nodenext` resolver an explicit types entry. No in-repo consumer imports a
  subpath, so this broke nothing (`bun run typecheck` is green).
- `engines.node: ">=24"`: matches the Floor backend's own engines field and
  the `@types/node@24` the package is typed against. Bun ignores `engines`.

`private: true` is left in place. It does not block `npm pack` or `bun pm
pack` (both produce the tarball; only `publish` refuses), so it is a useful
guard until the package is ready for a registry. Remove it at publish time.

## Things this run does not prove

- Other prebuilt platforms. Only `darwin-arm64` exists on this machine.
  `native.js` falls back to `@shardpdf/core-<platform>` optional dependencies
  which are not declared in `package.json`; a registry release needs either
  every `.node` in the main tarball or `napi prepublish`-generated
  `optionalDependencies`.
- The binary tested is a debug build (`buildInfo().profile === "debug"`).
  Behaviour is identical; only timings differ.

## Addendum 2026-09-16 (later): Linux path

`smoke/linux/` adds a Dockerfile that builds the binding from a clean copy of
the repo inside `node:24-bookworm` (host `.node` files are deleted first, and
the build asserts `profile === "release"`), then runs `smoke/consumer/run.sh`
including the Floor acceptance check with Noto Sans CJK. `smoke/linux/run.sh`
drives it for `linux/arm64` and `linux/amd64`; CI runs both in the
`linux-smoke` job on native runners.

Attempted locally on 2026-09-16: the Docker daemon on this macOS host was
reachable but never received a byte of `node:24-bookworm`, so the Linux
result comes from CI.

**Observed, CI run 35100920445 (2026-09-16, commit `941c9b6`):**

| Job | Toolchain | Result |
| --- | --- | --- |
| `linux-smoke` linux/amd64 | Node v24.21.0, Bun 1.4.2, qpdf 11.3.0, glibc 2.36, release binding built in-container | node/bun cjs+esm, floor-acceptance node+bun, tsc nodenext+bundler, negative types: all PASS |
| `linux-smoke` linux/arm64 | same, aarch64 | all PASS |
| `package` | six prebuilt bindings (darwin-arm64, darwin-x64, linux-arm64-gnu, linux-x64-gnu, win32-arm64-msvc, win32-x64-msvc) in one tarball | consumer smoke PASS on ubuntu x64 |
| `checks` (ubuntu, host build) | Node v24.20.0, Bun 1.3.14 | all PASS |

The multi-platform tarball works because `native.js` prefers a sibling
`shardpdf-core.<platform>.node` over the `@shardpdf/core-<platform>` optional
packages, and `files` includes `*.node`. The earlier "undeclared optional
deps" gap is therefore not blocking for a single bundled tarball; it only
matters if the package is ever split per platform.

### Floor's `rlimit` limiter (informational probe, same run)

Floor's `spawn-with-memory-cap.ts` "rlimit" mode wraps the child in
`ulimit -v <cap>; exec`. `EXPORT_MEMORY_CAP_MB` defaults to 768. The probe
runs a bare `-e 0` and a 2,200-page `merge()` under several caps:

| Cap | `node -e 0` | `bun -e 0` | node `merge()` | bun `merge()` |
| ---: | --- | --- | --- | --- |
| 768 MB, x86_64 | exit 133 (V8 init OOM) | ok | exit 133 | exit 134 |
| 768 MB, aarch64 | exit 133 | exit 134 | exit 133 | exit 134 |
| 2048 MB, x86_64 | ok | ok | ok | ok |
| 2048 MB, aarch64 | ok | ok | ok | exit 1 (once) |
| 4096 MB, both | ok | ok | ok | ok |

Node 24 cannot even start under a 768 MB address-space cap (V8 reserves its
sandbox and code range up front), so Floor's `rlimit` mode cannot host a
Node child at its default cap regardless of what the child does. Bun starts
at 768 MB on x86_64 but aborts during the merge. At 2 GB and above both
runtimes complete the merge, with one unexplained Bun exit 1 on aarch64 at
2 GB that did not reproduce at 4 GB. This is a property of the JS runtimes
under `RLIMIT_AS`, not of shardpdf: the same `merge()` measured 87 MB RSS on
11,164 pages. The practical consequence for Floor is that a shardpdf child
must run under the `cgroup` limiter (`MemoryMax`, which caps RSS not address
space), or in-process with `maxDecompressedBytes` as the untrusted-input
bound. The `rlimit` mode remains suitable for qpdf.
