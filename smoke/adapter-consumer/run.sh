#!/usr/bin/env bash
# Consumer smoke test for @shardpdf/adapter-pdfkit.
#
# Packs the adapter, orchestrator, and core exactly as `npm publish` would,
# installs them into a standalone package the way an external backend does
# (Floor Inspector consumes `@shardpdf/core` from a `file:` tarball today), and
# then exercises the adapter through its real public interface:
#
#   run.ts         end-to-end generate() from outside the monorepo
#   rules.ts       every documented behavioural rule and error, asserted
#   types-check.ts every documented public type, compile-only
#
# KNOWN LIMITATION, found by this script: these packages ship TypeScript
# source, and Node refuses to type-strip inside node_modules
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). So an installed tarball is
# consumable from Bun but NOT from Node until the packages ship compiled JS.
# This affects @shardpdf/orchestrator identically and is pre-existing; the
# script asserts the current behaviour rather than pretending otherwise.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
tsc="$repo/node_modules/.bin/tsc"
work="$here/.work"

step() { printf '\n== %s\n' "$*"; }

step "toolchain"
echo "node $(node --version)"
echo "bun  $(bun --version)"
if command -v qpdf >/dev/null 2>&1; then qpdf --version | head -1; else echo "qpdf: not on PATH (structural checks skipped)"; fi

if ! ls "$repo"/crates/core/*.node >/dev/null 2>&1; then
  echo "error: no prebuilt .node in crates/core; run 'bun run build' there first" >&2
  exit 1
fi

step "pack the three packages"
rm -rf "$work"
mkdir -p "$work/vendor"
for pkg in crates/core packages/orchestrator packages/adapter-pdfkit; do
  (cd "$repo/$pkg" && npm pack --pack-destination "$work/vendor" >/dev/null 2>&1)
done
ls "$work/vendor" | sed 's/^/  /'

step "install as an external consumer would"
cd "$work"
cat > package.json <<'JSON'
{
  "name": "shardpdf-adapter-consumer-smoke",
  "private": true,
  "type": "module",
  "dependencies": { "pdfkit": "^0.19.1" },
  "devDependencies": { "@types/node": "^24", "@types/pdfkit": "^0.17.6" }
}
JSON
bun install 2>&1 | tail -2

# Unpack each tarball into node_modules by hand. `workspace:*` deps inside the
# published manifests cannot resolve outside the monorepo, so a plain
# `bun install` of the tarballs fails; unpacking is what proves the SHIPPED
# FILES are sufficient, which is the thing under test.
mkdir -p node_modules/@shardpdf
for name in core orchestrator adapter-pdfkit; do
  tarball="$(ls vendor/shardpdf-"$name"-*.tgz)"
  rm -rf "node_modules/@shardpdf/$name" "$work/unpack"
  mkdir -p "$work/unpack"
  tar xzf "$tarball" -C "$work/unpack"
  mv "$work/unpack/package" "node_modules/@shardpdf/$name"
done
rmdir "$work/unpack" 2>/dev/null || true
ls node_modules/@shardpdf | sed 's/^/  /'
ls node_modules/@shardpdf/core/*.node >/dev/null

cp "$here"/{my-adapter.ts,run.ts,rules.ts,types-check.ts} .
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["my-adapter.ts", "run.ts", "rules.ts", "types-check.ts"]
}
JSON

status=0
fail() { echo "FAIL: $*" >&2; status=1; }

step "Node: record the type-stripping limitation"
# Asserted, not skipped: if Node ever starts accepting this, the packages can
# drop the Bun-only caveat and this line is the trigger to revisit.
# The import must be AWAITED, or the rejection is never surfaced and this check
# silently passes on nothing.
node_probe="$(node --input-type=module -e \
  'try { await import("@shardpdf/adapter-pdfkit"); console.log("IMPORTED"); } catch (e) { console.log(e.code ?? e.message); }' 2>&1 || true)"
case "$node_probe" in
  *ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING*)
    echo "  as expected: Node cannot import TS source from node_modules" ;;
  *IMPORTED*)
    fail "Node now imports the package; drop the Bun-only caveat in the README" ;;
  *)
    fail "unexpected Node behaviour: $node_probe" ;;
esac

step "Bun: documented rules against the installed package"
bun run rules.ts || fail "rules.ts"

step "Bun: end-to-end generate() from outside the monorepo"
mkdir -p out
bun run run.ts || fail "run.ts"

step "verify the produced PDF"
if command -v qpdf >/dev/null 2>&1; then
  pages="$(qpdf --show-npages out/consumer.pdf)"
  images="$(qpdf --qdf --object-streams=disable out/consumer.pdf - 2>/dev/null | grep -c '/Subtype /Image' || true)"
  qpdf --check out/consumer.pdf >/dev/null || fail "qpdf --check"
  echo "  pages=$pages imageXObjects=$images bytes=$(wc -c < out/consumer.pdf | tr -d ' ')"
  [ "$pages" = "90" ] || fail "expected 90 pages, got $pages"
  # 5 distinct gauges x 3 shards = 15. Anything near 90 means the dedupe broke.
  [ "$images" -le 30 ] || fail "expected <= 30 image objects (5 per shard x 3), got $images"
  qpdf --json --json-key=outlines out/consumer.pdf 2>/dev/null | grep -q "Units 1-30" || fail "outline missing"
  echo "  outline present"
else
  echo "  skipped (no qpdf)"
fi

step "types: every documented public export compiles"
"$tsc" -p tsconfig.json || fail "tsc"

if [ "$status" -eq 0 ]; then
  printf '\n== all adapter consumer checks passed\n'
else
  printf '\n== adapter consumer checks FAILED\n'
fi
exit "$status"
