#!/usr/bin/env bash
# Consumer smoke test for @shardpdf/core.
#
# Packs crates/core exactly as `npm publish` would, installs the tarball into
# this standalone package as a `file:` dependency, then runs the CJS and ESM
# tests under Node and Bun and the compile-only type tests under tsc.
# Exits non-zero on the first failure.
#
# Prerequisites: crates/core must already be built (`bun run build` or
# `build:release` in crates/core) so the platform .node binary exists.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
core="$repo/crates/core"
tsc="$repo/node_modules/.bin/tsc"

step() { printf '\n== %s\n' "$*"; }

step "toolchain"
echo "node $(node --version)"
echo "bun  $(bun --version)"
echo "tsc  $("$tsc" --version)"
if command -v qpdf >/dev/null 2>&1; then qpdf --version | head -1; else echo "qpdf: not on PATH (structural checks will be skipped)"; fi

if ! ls "$core"/*.node >/dev/null 2>&1; then
  echo "error: no prebuilt .node in $core; run 'bun run build' there first" >&2
  exit 1
fi

step "pack crates/core"
mkdir -p "$here/vendor"
rm -f "$here"/vendor/*.tgz
tarball="$(cd "$core" && npm pack --pack-destination "$here/vendor" 2>/dev/null | tail -1)"
mv "$here/vendor/$tarball" "$here/vendor/shardpdf-core.tgz"
echo "packed $tarball -> vendor/shardpdf-core.tgz"
tar tzf "$here/vendor/shardpdf-core.tgz" | sed 's/^/  /'

step "install into smoke/consumer"
cd "$here"
# Drop any stale lock/tarball record so the freshly packed tarball is what gets installed.
rm -rf node_modules/@shardpdf bun.lock
bun install 2>&1 | tail -3
# Installing from a tarball: the platform binary must be inside node_modules,
# not resolved through the workspace.
ls node_modules/@shardpdf/core/*.node

status=0
run() {
  local label="$1"; shift
  if "$@"; then echo "PASS $label"; else echo "FAIL $label"; status=1; fi
}

step "runtime tests"
run "node cjs" node cjs.test.cjs
run "node esm" node esm.test.mjs
run "bun cjs"  bun cjs.test.cjs
run "bun esm"  bun esm.test.mjs

step "Floor Inspector acceptance (spec mapping vs qpdf oracle)"
if command -v qpdf >/dev/null 2>&1; then
  # The script itself skips (exit 0) when no CJK font is available.
  run "node floor-acceptance" node floor-acceptance.cjs
  run "bun floor-acceptance"  bun floor-acceptance.cjs
else
  echo "SKIP floor-acceptance: needs qpdf on PATH"
fi

step "type tests (tsc --noEmit, nodenext, .ts as ESM + .cts as CJS)"
run "tsc" "$tsc" -p tsconfig.json
# Floor Inspector compiles with module esnext + moduleResolution bundler.
run "tsc (bundler resolution, Floor's tsconfig shape)" "$tsc" -p tsconfig.bundler.json
# Prove the @ts-expect-error lines are load-bearing: strip them and require
# at least one error per stripped directive.
expected="$(grep -c '@ts-expect-error' types/esm/index.ts types/cjs.cts | awk -F: '{s+=$2} END {print s}')"
trap 'rm -rf "$here/types/_neg"' EXIT
mkdir -p types/_neg/esm
cp types/esm/package.json types/_neg/esm/
sed 's#// @ts-expect-error.*##' types/esm/index.ts > types/_neg/esm/index.ts
sed 's#// @ts-expect-error.*##' types/cjs.cts > types/_neg/cjs.cts
actual="$("$tsc" -p tsconfig.json 2>&1 | grep -c 'error TS' || true)"
rm -rf types/_neg
if [ "$actual" -ge "$expected" ]; then
  echo "PASS negative type cases ($actual errors from $expected stripped directives)"
else
  echo "FAIL negative type cases: expected >= $expected errors, got $actual"; status=1
fi

step "result"
if [ "$status" -eq 0 ]; then echo "all consumer smoke tests passed"; else echo "consumer smoke tests FAILED"; fi
exit "$status"
