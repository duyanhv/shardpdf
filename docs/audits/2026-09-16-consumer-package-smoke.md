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
