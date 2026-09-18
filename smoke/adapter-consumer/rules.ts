/**
 * Checks the README's load-bearing behavioural claims against the installed
 * package, not the source tree.
 */
import assert from "node:assert/strict";
import type { PdfDocument } from "@shardpdf/adapter-pdfkit";
import {
  createPdfkitAdapter,
  ImageCache,
  InvalidPageCountError,
  UnknownSectionKindError,
} from "@shardpdf/adapter-pdfkit";
import PDFDocument from "pdfkit";

const doc = new PDFDocument({
  size: "A4",
  bufferPages: false,
}) as unknown as PdfDocument;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

// Rule: memoizes on the key -- rasterize runs once.
let calls = 0;
const cache = new ImageCache(doc);
const a = cache.get("k", () => {
  calls++;
  return png;
});
const b = cache.get("k", () => {
  calls++;
  return png;
});
assert.equal(calls, 1, "rasterize must run once per key");
assert.equal(a, b, "same key must return the same handle");
assert.deepEqual(cache.stats(), { distinct: 1, hits: 1, misses: 1 });
console.log("PASS memoizes on key; stats accurate");

// Rule: distinct keys are distinct images.
cache.get("k2", () => png);
assert.equal(cache.stats().distinct, 2);
console.log("PASS distinct keys -> distinct images");

// Documented validation: bad key.
for (const bad of ["", null, 7]) {
  assert.throws(
    () => cache.get(bad as string, () => png),
    TypeError,
    `key ${String(bad)} must throw`,
  );
}
console.log("PASS empty/non-string keys throw TypeError");

// Documented validation: bad rasterize result.
assert.throws(
  () => cache.get("bad", () => "nope" as unknown as Buffer),
  TypeError,
);
console.log("PASS non-Buffer rasterize result throws TypeError");

// Documented validation: adapter options.
assert.throws(() => createPdfkitAdapter({} as never), TypeError);
assert.throws(
  () => createPdfkitAdapter({ createDocument: () => doc } as never),
  TypeError,
);
assert.throws(
  () =>
    createPdfkitAdapter({
      createDocument: () => doc,
      kindOf: () => "a",
    } as never),
  TypeError,
);
console.log("PASS adapter option validation throws TypeError");

// Documented errors are real classes with codes.
const e1 = new UnknownSectionKindError("k", "s", ["a"]);
assert.equal(e1.name, "UnknownSectionKindError");
assert.equal(e1.code, "ADAPTER_UNKNOWN_SECTION_KIND");
const e2 = new InvalidPageCountError("s", 0);
assert.equal(e2.name, "InvalidPageCountError");
assert.equal(e2.code, "ADAPTER_INVALID_PAGE_COUNT");
console.log("PASS error names and codes as documented");

// Documented: pages() must be a positive integer; anchors must be in range.
const adapter = createPdfkitAdapter<{ kind: string; n?: number }>({
  createDocument: () => doc,
  kindOf: (d) => d.kind,
  templates: {
    bad: { pages: (d) => d.n ?? 0, draw: () => {} },
    anchorOob: {
      pages: () => 2,
      anchors: () => [{ name: "x", pageIndexInSection: 5 }],
      draw: () => {},
    },
  },
});
assert.throws(
  () =>
    adapter.measure(
      { index: 0, sections: [{ id: "s", data: { kind: "bad", n: 0 } }] },
      { shardIndex: 0 },
    ),
  (e: Error) => e.name === "InvalidPageCountError",
);
console.log("PASS pages() <= 0 rejected");
assert.throws(
  () =>
    adapter.measure(
      { index: 0, sections: [{ id: "s", data: { kind: "anchorOob" } }] },
      { shardIndex: 0 },
    ),
  RangeError,
);
console.log("PASS out-of-range anchor rejected with RangeError");
assert.throws(
  () =>
    adapter.measure(
      { index: 0, sections: [{ id: "s", data: { kind: "missing" } }] },
      { shardIndex: 0 },
    ),
  (e: Error) => e.name === "UnknownSectionKindError",
);
console.log("PASS unknown kind rejected");

// Documented: measure() reports cumulative counts and shard-relative anchors.
const multi = createPdfkitAdapter<{ kind: "s"; n: number }>({
  createDocument: () => doc,
  kindOf: () => "s",
  templates: {
    s: {
      pages: (d) => d.n,
      anchors: (_d, id) => [{ name: `a:${id}` }],
      draw: () => {},
    },
  },
});
const m = multi.measure(
  {
    index: 0,
    sections: [
      { id: "x", data: { kind: "s", n: 3 } },
      { id: "y", data: { kind: "s", n: 2 } },
    ],
  },
  { shardIndex: 0 },
);
assert.deepEqual(m, {
  pageCount: 5,
  anchors: [
    { name: "a:x", pageIndexInShard: 0 },
    { name: "a:y", pageIndexInShard: 3 },
  ],
});
console.log("PASS measure() page counts and anchor offsets");

console.log("\nALL DOCUMENTED RULES VERIFIED against the installed package");
