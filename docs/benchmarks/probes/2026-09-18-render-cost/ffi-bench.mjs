/**
 * Prices the FFI round trip a Rust text renderer would pay per measurement
 * query, against pdfkit's JS cost for the same operation (measure-cost.mjs).
 *
 * This is the crux of the "should rendering move to Rust?" question. Floor's
 * layout is latency-bound, not throughput-bound: 452 blocking measurement
 * queries per page (callcount.mjs), each one feeding the next draw position,
 * so the boundary cost is paid per call and cannot be amortized.
 *
 * Build the addon first:
 *   cargo build --release --manifest-path ffi-bench/Cargo.toml
 *
 * usage: node ffi-bench.mjs [trials]
 */
import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, "ffi-bench/target/release/libffi_bench.dylib");
const builtSo = path.join(here, "ffi-bench/target/release/libffi_bench.so");
const addonPath = path.join(here, "ffi-bench/ffi.node");

const source = existsSync(built)
  ? built
  : existsSync(builtSo)
    ? builtSo
    : undefined;
if (!source) {
  console.error(
    "ffi-bench addon not built. Run:\n" +
      "  cargo build --release --manifest-path ffi-bench/Cargo.toml",
  );
  process.exit(2);
}
// napi addons must be loaded through a .node extension.
copyFileSync(source, addonPath);

const require = createRequire(import.meta.url);
const n = require(addonPath);

const trials = Number(process.argv[2] ?? 7);
const N = 500_000;
const STRINGS = [
  "가동 101호",
  "나동 1502호",
  "45.3dB",
  "3등급",
  "측정 위치",
  "바닥 충격음 측정 결과 요약",
];

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function bench(label, fn) {
  const runs = [];
  for (let t = 0; t < trials; t++) {
    let acc = 0;
    for (let i = 0; i < 1000; i++) acc += fn(i);
    const start = process.hrtime.bigint();
    for (let i = 0; i < N; i++) acc += fn(i);
    runs.push(Number(process.hrtime.bigint() - start) / N);
    if (!(acc > 0)) throw new Error("benchmark optimized away");
  }
  const m = median(runs);
  console.log(
    `${label.padEnd(26)} ${m.toFixed(0).padStart(6)} ns  ` +
      `(min ${Math.min(...runs).toFixed(0)}, max ${Math.max(...runs).toFixed(0)})`,
  );
  return m;
}

console.log(`trials=${trials} iterations=${N}\n`);
const plain = bench("plain JS call", (i) => i + 1);
bench("napi noop(f64)->f64", () => n.noop(1));
const owned = bench("napi widthOf(String)", (i) =>
  n.widthOf(STRINGS[i % STRINGS.length]),
);
const borrowed = bench("napi widthOf(JsString)", (i) =>
  n.widthOfRef(STRINGS[i % STRINGS.length]),
);

console.log(
  `\nCheapest string-in/number-out FFI round trip: ${Math.min(owned, borrowed).toFixed(0)} ns` +
    ` (${(Math.min(owned, borrowed) / plain).toFixed(0)}x a plain JS call).`,
);
console.log(
  "Compare against pdfkit's real widthOfString from measure-cost.mjs: a Rust\n" +
    "shaper spends this much on the boundary alone, before doing any shaping.",
);
