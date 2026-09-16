#!/usr/bin/env bash
# Build and run the Linux consumer smoke for one or both architectures.
# Requires Docker with registry access (pulls node:24-bookworm).
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
platforms="${*:-linux/arm64 linux/amd64}"
status=0
for platform in $platforms; do
  tag="shardpdf-linux-smoke-${platform//\//-}"
  echo "== $platform"
  if docker build --platform "$platform" -f "$repo/smoke/linux/Dockerfile" -t "$tag" "$repo" \
     && docker run --rm --platform "$platform" "$tag"; then
    echo "PASS $platform"
  else
    echo "FAIL $platform"; status=1
  fi
done
exit "$status"
