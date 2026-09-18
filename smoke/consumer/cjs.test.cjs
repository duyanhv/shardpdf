// CommonJS consumption of @shardpdf/core from the installed tarball.
const assert = require("node:assert/strict");
const core = require("@shardpdf/core");
const { runScenario } = require("./fixtures.cjs");

const runtime = `${typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.versions.node}`} cjs`;

for (const name of [
  "merge",
  "extract",
  "getPageCount",
  "assemble",
  "extractPages",
  "buildInfo",
]) {
  assert.equal(
    typeof core[name],
    "function",
    `require(): ${name} is a function`,
  );
}
assert.equal(typeof core.Assembly, "function", "require(): Assembly class");
const info = core.buildInfo();
assert.equal(typeof info.version, "string");
assert.ok(info.profile === "release" || info.profile === "debug");

runScenario(runtime, core).catch((err) => {
  console.error(`FAIL ${runtime}:`, err);
  process.exit(1);
});
