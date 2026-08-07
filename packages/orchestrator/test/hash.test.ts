import assert from "node:assert/strict";
import { test } from "node:test";
import { contentHash, stableStringify } from "../src/hash.ts";

test("key order does not change the hash", () => {
  assert.equal(
    contentHash({ a: 1, b: { d: [1, 2], c: "x" } }),
    contentHash({ b: { c: "x", d: [1, 2] }, a: 1 }),
  );
});

test("different values change the hash", () => {
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
});

test("array order matters", () => {
  assert.notEqual(contentHash([1, 2]), contentHash([2, 1]));
});

test("undefined-valued keys are dropped from the canonical form", () => {
  assert.equal(
    stableStringify({ a: 1, b: undefined }),
    stableStringify({ a: 1 }),
  );
});
