import assert from "node:assert/strict";
import { test } from "node:test";
import { partition } from "../src/scheduler.ts";
import type { DocumentPlan } from "../src/types.ts";

const ADAPTER = { module: "/dev/null" };

function plan(estimates: (number | undefined)[]): DocumentPlan<null> {
  return {
    adapter: ADAPTER,
    sections: estimates.map((pageEstimate, i) => ({
      id: `s${i}`,
      data: null,
      ...(pageEstimate !== undefined && { pageEstimate }),
    })),
  };
}

test("packs sections greedily under the budget", () => {
  const shards = partition(plan([3, 3, 3, 3]), 6);
  assert.deepEqual(
    shards.map((s) => s.sections.map((x) => x.id)),
    [
      ["s0", "s1"],
      ["s2", "s3"],
    ],
  );
});

test("a section over budget still gets its own shard", () => {
  const shards = partition(plan([2, 99, 2]), 10);
  assert.deepEqual(
    shards.map((s) => s.sections.map((x) => x.id)),
    [["s0"], ["s1"], ["s2"]],
  );
});

test("missing estimates default to one page each", () => {
  const shards = partition(plan([undefined, undefined, undefined]), 2);
  assert.equal(shards.length, 2);
});

test("shard indices are sequential", () => {
  const shards = partition(plan([1, 1, 1, 1, 1]), 2);
  assert.deepEqual(
    shards.map((s) => s.index),
    [0, 1, 2],
  );
});

test("rejects a non-positive budget", () => {
  assert.throws(() => partition(plan([1]), 0), RangeError);
});
