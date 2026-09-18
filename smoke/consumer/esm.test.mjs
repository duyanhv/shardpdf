// ESM consumption of @shardpdf/core from the installed tarball: named imports
// through Node's CJS named-export detection, plus a namespace import.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as core from "@shardpdf/core";
import { extract, getPageCount, merge } from "@shardpdf/core";

const require = createRequire(import.meta.url);
const { runScenario } = require("./fixtures.cjs");

const runtime = `${typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.versions.node}`} esm`;

assert.equal(typeof merge, "function", "named import merge");
assert.equal(typeof extract, "function", "named import extract");
assert.equal(typeof getPageCount, "function", "named import getPageCount");

assert.equal(typeof core.assemble, "function", "namespace: assemble");
assert.equal(typeof core.extractPages, "function", "namespace: extractPages");
assert.equal(typeof core.Assembly, "function", "namespace: Assembly");
assert.equal(typeof core.buildInfo, "function", "namespace: buildInfo");
assert.equal(core.merge, merge, "namespace and named import agree");

const info = core.buildInfo();
assert.equal(typeof info.version, "string");

try {
  await runScenario(runtime, { merge, extract, getPageCount });
} catch (err) {
  console.error(`FAIL ${runtime}:`, err);
  process.exit(1);
}
