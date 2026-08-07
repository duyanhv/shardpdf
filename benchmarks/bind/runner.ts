import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { injectQpdfOutlines } from "./qpdf-outline.ts";
import type {
  BindEngine,
  BindFixtureManifest,
  BindMode,
  BindRunnerReport,
} from "./types.ts";

const execFileP = promisify(execFile);

const engine = process.argv[2] as BindEngine | undefined;
const mode = process.argv[3] as BindMode | undefined;
const manifestPath = process.argv[4];
const outputPath = process.argv[5];

if (
  (engine !== "qpdf" && engine !== "shardpdf") ||
  (mode !== "merge" && mode !== "outline") ||
  manifestPath === undefined ||
  outputPath === undefined
) {
  console.error(
    "usage: node runner.ts <qpdf|shardpdf> <merge|outline> <manifest> <output>",
  );
  process.exit(2);
}

void main(engine, mode, manifestPath, outputPath).then(
  (pageCount) => {
    const report: BindRunnerReport = { pageCount };
    console.log(JSON.stringify(report));
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

async function main(
  selectedEngine: BindEngine,
  selectedMode: BindMode,
  fixtureManifestPath: string,
  outPath: string,
): Promise<number> {
  // Give the parent harness a stable point at which to take an initial RSS
  // sample. The timed bind begins only after the parent replies on stdin.
  console.log("READY");
  process.stdin.resume();
  await once(process.stdin, "data");
  process.stdin.pause();
  return run(selectedEngine, selectedMode, fixtureManifestPath, outPath);
}

async function run(
  selectedEngine: BindEngine,
  selectedMode: BindMode,
  fixtureManifestPath: string,
  outPath: string,
): Promise<number> {
  const fixture = JSON.parse(
    await readFile(fixtureManifestPath, "utf8"),
  ) as BindFixtureManifest;
  const fixtureDir = path.dirname(fixtureManifestPath);
  const shards = fixture.shards.map((shard) => path.join(fixtureDir, shard));

  if (selectedEngine === "qpdf") {
    return runQpdf(selectedMode, shards, fixture, outPath);
  }
  return runShardpdf(selectedMode, shards, fixture, outPath);
}

async function runQpdf(
  selectedMode: BindMode,
  shards: string[],
  fixture: BindFixtureManifest,
  outPath: string,
): Promise<number> {
  const mergePath =
    selectedMode === "outline" ? `${outPath}.merged.pdf` : outPath;
  try {
    await execFileP("qpdf", ["--empty", "--pages", ...shards, "--", mergePath]);
    if (selectedMode === "outline") {
      await injectQpdfOutlines(mergePath, outPath, fixture.outline);
    }
    return fixture.totalPages;
  } finally {
    if (mergePath !== outPath) await rm(mergePath, { force: true });
  }
}

async function runShardpdf(
  selectedMode: BindMode,
  shards: string[],
  fixture: BindFixtureManifest,
  outPath: string,
): Promise<number> {
  const { Assembly } = await import("@shardpdf/core");
  const assembly = new Assembly(outPath);
  let pageCount = 0;
  for (const shard of shards) pageCount += assembly.appendShard(shard);
  if (pageCount !== fixture.totalPages) {
    throw new Error(
      `shardpdf appended ${pageCount} pages, fixture expects ${fixture.totalPages}`,
    );
  }
  assembly.finalize(selectedMode === "outline" ? fixture.outline : undefined);
  return pageCount;
}
