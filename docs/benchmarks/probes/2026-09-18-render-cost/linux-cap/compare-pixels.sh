#!/bin/sh
# Rasterize both arms and compare decoded pixels -- the only comparison that
# answers "does it look the same", independent of PDF object numbering.
set -e
MODE=naive node --expose-gc probe.mjs >/dev/null
MODE=cached node --expose-gc probe.mjs >/dev/null
ok=1
for page in 1 60 120; do
  pdftoppm -png -r 72 -f "$page" -l "$page" /probe/naive-120.pdf "/tmp/n"
  pdftoppm -png -r 72 -f "$page" -l "$page" /probe/cached-120.pdf "/tmp/c"
  nf=$(ls /tmp/n-*.png | head -1); cf=$(ls /tmp/c-*.png | head -1)
  if cmp -s "$nf" "$cf"; then echo "page $page: rendered pixels IDENTICAL"; else echo "page $page: PIXELS DIFFER"; ok=0; fi
  rm -f /tmp/n-*.png /tmp/c-*.png
done
[ "$ok" = 1 ] && echo "RESULT: identical on Linux" || echo "RESULT: DIFFERENCE"
