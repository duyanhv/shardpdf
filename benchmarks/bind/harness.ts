import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { SCALES, type ScaleName } from "../workload/data.ts";
import { prepareBindFixture } from "./fixture.ts";
import type {
  BindEngine,
  BindFixtureManifest,
  BindMode,
  BindOutlineEntry,
  BindRunnerReport,
} from "./types.ts";

const execFileP = promisify(execFile);
const BENCH_DIR = path.resolve(import.meta.dirname, "..");
const ENGINES: BindEngine[] = ["qpdf", "shardpdf"];
const MODES: BindMode[] = ["merge", "outline"];

type Check = "pass" | "fail" | "skipped";
type Outcome = "ok" | "crash" | "wrong-output";

interface BindResult {
  iteration: number;
  engine: BindEngine;
  mode: BindMode;
  fixture: string;
  scale: ScaleName | null;
  outcome: Outcome;
  /** Peak aggregate RSS of the runner and every descendant subprocess. */
  peakProcessTreeRssBytes: number | null;
  wallTimeMs: number;
  outputBytes: number | null;
  pageCountReported: number | null;
  pageCountActual: number | null;
  qpdfCheck: Check;
  linkCheck: Check;
  outlineCheck: Check;
  exit: { code: number | null; signal: string | null };
  machine: {
    tag: string;
    node: string;
    platform: string;
    arch: string;
  };
  versions: { qpdf: string; shardpdf: string };
  timestamp: string;
  notes: string[];
}

interface BindResultSet {
  engine: BindEngine;
  mode: BindMode;
  fixture: string;
  scale: ScaleName | null;
  iterations: number;
  median: {
    peakProcessTreeRssBytes: number | null;
    wallTimeMs: number;
    outputBytes: number | null;
  };
  samples: BindResult[];
}

const { values } = parseArgs({
  options: {
    runner: { type: "string", default: "all" },
    mode: { type: "string", default: "all" },
    scale: { type: "string" },
    fixture: { type: "string" },
    tag: { type: "string", default: "local-bind" },
    keep: { type: "boolean", default: false },
    iterations: { type: "string", default: "3" },
  },
});

if ((values.scale === undefined) === (values.fixture === undefined)) {
  console.error("pass exactly one of --scale or --fixture");
  process.exit(2);
}
if (values.scale !== undefined && !(values.scale in SCALES)) {
  console.error(`--scale must be one of: ${Object.keys(SCALES).join(", ")}`);
  process.exit(2);
}
const engines =
  values.runner === "all"
    ? ENGINES
    : ENGINES.filter((engine) => engine === values.runner);
const modes =
  values.mode === "all" ? MODES : MODES.filter((mode) => mode === values.mode);
if (engines.length === 0) {
  console.error(`--runner must be one of: ${ENGINES.join(", ")}, all`);
  process.exit(2);
}
if (modes.length === 0) {
  console.error(`--mode must be one of: ${MODES.join(", ")}, all`);
  process.exit(2);
}
const iterations = Number.parseInt(values.iterations, 10);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) {
  console.error("--iterations must be an integer from 1 to 20");
  process.exit(2);
}

const generatedScale = values.scale as ScaleName | undefined;
const generatedFixtureDir =
  generatedScale === undefined
    ? undefined
    : path.join(BENCH_DIR, "out", `bind-fixture-${generatedScale}`);
const manifestPath =
  generatedScale === undefined
    ? path.resolve(values.fixture as string)
    : await prepareGeneratedFixture(
        generatedScale,
        generatedFixtureDir as string,
      );
const fixture = await readAndValidateFixture(manifestPath);
console.log(
  `Using fixture ${fixture.name}: ${fixture.shards.length} shard(s), ${fixture.totalPages} pages, ${fixture.outline.length} outlines.`,
);

try {
  for (const mode of modes) {
    for (const engine of engines) {
      const samples: BindResult[] = [];
      for (let iteration = 1; iteration <= iterations; iteration++) {
        samples.push(
          await runOne(
            engine,
            mode,
            fixture,
            manifestPath,
            values.tag,
            values.keep,
            iteration,
            iterations,
          ),
        );
      }
      await writeResultSet(engine, mode, fixture, values.tag, samples);
    }
  }
} finally {
  if (!values.keep && generatedFixtureDir !== undefined) {
    await rm(generatedFixtureDir, { recursive: true, force: true });
  }
}

async function prepareGeneratedFixture(
  scale: ScaleName,
  fixtureDir: string,
): Promise<string> {
  console.log(`Preparing shared ${scale} bind fixture (not measured)...`);
  return prepareBindFixture(scale, fixtureDir);
}

async function readAndValidateFixture(
  manifestPath: string,
): Promise<BindFixtureManifest> {
  const fixture = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as BindFixtureManifest;
  if (fixture.version !== 1) {
    throw new Error(
      `unsupported bind fixture version ${String(fixture.version)}`,
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(fixture.name)) {
    throw new Error(
      `fixture name must be filename-safe lowercase text, got ${JSON.stringify(fixture.name)}`,
    );
  }
  if (!Number.isInteger(fixture.totalPages) || fixture.totalPages < 1) {
    throw new Error(
      `fixture totalPages must be positive, got ${fixture.totalPages}`,
    );
  }
  if (!Array.isArray(fixture.shards) || fixture.shards.length === 0) {
    throw new Error("fixture must contain at least one shard");
  }

  const fixtureDir = await realpath(path.dirname(manifestPath));
  let actualPages = 0;
  for (const shard of fixture.shards) {
    if (path.isAbsolute(shard)) {
      throw new Error(`fixture shard path must be relative: ${shard}`);
    }
    const shardPath = await realpath(path.resolve(fixtureDir, shard));
    if (
      shardPath !== fixtureDir &&
      !shardPath.startsWith(`${fixtureDir}${path.sep}`)
    ) {
      throw new Error(`fixture shard escapes its directory: ${shard}`);
    }
    const { stdout } = await execFileP("qpdf", ["--show-npages", shardPath]);
    const pages = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(pages) || pages < 1) {
      throw new Error(`could not read page count for fixture shard ${shard}`);
    }
    actualPages += pages;
  }
  if (actualPages !== fixture.totalPages) {
    throw new Error(
      `fixture page mismatch: manifest=${fixture.totalPages} shards=${actualPages}`,
    );
  }

  let previousLevel = 0;
  fixture.outline.forEach((entry, index) => {
    if (
      !Number.isInteger(entry.pageIndex) ||
      entry.pageIndex < 0 ||
      entry.pageIndex >= fixture.totalPages
    ) {
      throw new Error(
        `fixture outline ${index} has invalid page ${entry.pageIndex}`,
      );
    }
    if (
      !Number.isInteger(entry.level) ||
      entry.level < 0 ||
      (index === 0 && entry.level !== 0) ||
      entry.level > previousLevel + 1
    ) {
      throw new Error(
        `fixture outline ${index} has invalid level ${entry.level}`,
      );
    }
    previousLevel = entry.level;
  });
  return fixture;
}

async function runOne(
  engine: BindEngine,
  mode: BindMode,
  fixture: BindFixtureManifest,
  manifestPath: string,
  tag: string,
  keepOutput: boolean,
  iteration: number,
  iterations: number,
): Promise<BindResult> {
  const outDir = path.join(BENCH_DIR, "out");
  const outputPath = path.join(
    outDir,
    `bind-${fixture.name}-${engine}-${mode}-run-${iteration}.pdf`,
  );
  await mkdir(outDir, { recursive: true });
  await rm(outputPath, { force: true });

  console.log(
    `\n▶ bind ${engine} / ${mode} @ ${fixture.name} (${iteration}/${iterations})`,
  );
  const child = spawn(
    process.execPath,
    [
      path.join(import.meta.dirname, "runner.ts"),
      engine,
      mode,
      manifestPath,
      outputPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.includes("READY\n")) markReady?.();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });

  let peakRss: number | null = null;
  const sample = async (): Promise<void> => {
    if (child.pid === undefined) return;
    const rss = await sampleProcessTreeRss(child.pid);
    if (rss !== null && (peakRss === null || rss > peakRss)) peakRss = rss;
  };
  await ready;
  await sample();
  const startedAt = Date.now();
  const sampler = setInterval(() => void sample(), 25);
  child.stdin.write("\n");
  const exit = await new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearInterval(sampler);
  const wallTimeMs = Date.now() - startedAt;

  const notes: string[] = [];
  if (stderr.trim().length > 0) notes.push(stderr.trim());
  let pageCountReported: number | null = null;
  const reportLine = stdout.trim().split("\n").at(-1);
  if (reportLine?.startsWith("{")) {
    try {
      pageCountReported = (JSON.parse(reportLine) as BindRunnerReport)
        .pageCount;
    } catch {
      notes.push("runner stdout did not contain a valid final report");
    }
  }

  let outcome: Outcome = exit.code === 0 ? "ok" : "crash";
  let outputBytes: number | null = null;
  let pageCountActual: number | null = null;
  let qpdfCheck: Check = "skipped";
  let linkCheck: Check = "skipped";
  let outlineCheck: Check = "skipped";

  if (outcome === "ok") {
    outputBytes = (await stat(outputPath)).size;
    try {
      await execFileP("qpdf", ["--check", outputPath]);
      qpdfCheck = "pass";
    } catch {
      qpdfCheck = "fail";
      notes.push("qpdf --check failed");
    }
    try {
      const { stdout: pages } = await execFileP("qpdf", [
        "--show-npages",
        outputPath,
      ]);
      pageCountActual = Number(pages.trim());
    } catch {
      notes.push("qpdf --show-npages failed");
    }
    try {
      const links = await checkLinkIntegrity(outputPath);
      linkCheck = links.missing.length === 0 ? "pass" : "fail";
      if (links.missing.length > 0) {
        notes.push(
          `${links.missing.length}/${links.referenced} named link destinations are undefined`,
        );
      }
    } catch (error) {
      notes.push(
        `link integrity check failed to run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (mode === "outline") {
      try {
        const outlines = await readQpdfOutlines(outputPath);
        const mismatch = compareOutlines(fixture.outline, outlines);
        outlineCheck = mismatch === null ? "pass" : "fail";
        if (mismatch !== null) notes.push(mismatch);
      } catch (error) {
        notes.push(
          `outline validation failed to run: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const pageMismatch =
      pageCountReported !== fixture.totalPages ||
      pageCountActual !== fixture.totalPages;
    if (pageMismatch) {
      notes.push(
        `page mismatch: expected=${fixture.totalPages} reported=${pageCountReported} actual=${pageCountActual}`,
      );
    }
    if (
      pageMismatch ||
      qpdfCheck === "fail" ||
      linkCheck === "fail" ||
      outlineCheck === "fail"
    ) {
      outcome = "wrong-output";
    }
  }

  const result: BindResult = {
    iteration,
    engine,
    mode,
    fixture: fixture.name,
    scale: fixture.scale ?? null,
    outcome,
    peakProcessTreeRssBytes: peakRss,
    wallTimeMs,
    outputBytes,
    pageCountReported,
    pageCountActual,
    qpdfCheck,
    linkCheck,
    outlineCheck,
    exit,
    machine: {
      tag,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    versions: {
      qpdf: await qpdfVersion(),
      shardpdf: await shardpdfVersion(),
    },
    timestamp: new Date().toISOString(),
    notes,
  };

  if (!keepOutput) await rm(outputPath, { force: true });
  const rssMb = peakRss === null ? "?" : (peakRss / 1024 / 1024).toFixed(0);
  console.log(
    `  ${outcome.toUpperCase()}  treePeakRSS=${rssMb}MB  wall=${(wallTimeMs / 1000).toFixed(2)}s  pages=${pageCountActual ?? pageCountReported ?? "?"}  links=${linkCheck}  outlines=${outlineCheck}`,
  );
  return result;
}

async function writeResultSet(
  engine: BindEngine,
  mode: BindMode,
  fixture: BindFixtureManifest,
  tag: string,
  samples: BindResult[],
): Promise<void> {
  const peakSamples = samples
    .map((sample) => sample.peakProcessTreeRssBytes)
    .filter((value): value is number => value !== null);
  const outputSamples = samples
    .map((sample) => sample.outputBytes)
    .filter((value): value is number => value !== null);
  const resultSet: BindResultSet = {
    engine,
    mode,
    fixture: fixture.name,
    scale: fixture.scale ?? null,
    iterations: samples.length,
    median: {
      peakProcessTreeRssBytes:
        peakSamples.length > 0 ? median(peakSamples) : null,
      wallTimeMs: median(samples.map((sample) => sample.wallTimeMs)),
      outputBytes: outputSamples.length > 0 ? median(outputSamples) : null,
    },
    samples,
  };
  const resultsDir = path.join(BENCH_DIR, "results");
  await mkdir(resultsDir, { recursive: true });
  await writeFile(
    path.join(resultsDir, `${tag}-${fixture.name}-bind-${engine}-${mode}.json`),
    `${JSON.stringify(resultSet, null, 2)}\n`,
  );

  const rss = resultSet.median.peakProcessTreeRssBytes;
  const rssMb = rss === null ? "?" : (rss / 1024 / 1024).toFixed(0);
  console.log(
    `  MEDIAN (${samples.length})  treePeakRSS=${rssMb}MB  wall=${(resultSet.median.wallTimeMs / 1000).toFixed(2)}s`,
  );
}

function median(values: number[]): number {
  if (values.length === 0) throw new Error("median requires values");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const value = sorted[middle];
    if (value === undefined) throw new Error("median index missing");
    return value;
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) {
    throw new Error("median indices missing");
  }
  return (left + right) / 2;
}

async function sampleProcessTreeRss(rootPid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileP("ps", ["-axo", "pid=,ppid=,rss="]);
    const rows = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(
        (row): row is [number, number, number] =>
          row.length === 3 && row.every(Number.isFinite),
      );
    const children = new Map<number, number[]>();
    const rss = new Map<number, number>();
    for (const [pid, ppid, rssKb] of rows) {
      rss.set(pid, rssKb);
      const siblings = children.get(ppid) ?? [];
      siblings.push(pid);
      children.set(ppid, siblings);
    }
    const pending = [rootPid];
    const seen = new Set<number>();
    let totalKb = 0;
    while (pending.length > 0) {
      const pid = pending.pop();
      if (pid === undefined || seen.has(pid)) continue;
      seen.add(pid);
      totalKb += rss.get(pid) ?? 0;
      pending.push(...(children.get(pid) ?? []));
    }
    return totalKb > 0 ? totalKb * 1024 : null;
  } catch {
    return null;
  }
}

async function checkLinkIntegrity(
  pdfPath: string,
): Promise<{ referenced: number; missing: string[] }> {
  const { stdout } = await execFileP(
    "qpdf",
    [
      pdfPath,
      "--json-output=2",
      "--json-stream-data=none",
      "--json-key=qpdf",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const json = JSON.parse(stdout) as unknown;
  const referenced = new Set<string>();
  const defined = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const value of node) visit(value);
      return;
    }
    if (node === null || typeof node !== "object") return;

    const dictionary = node as Record<string, unknown>;
    if (dictionary["/S"] === "/GoTo" && typeof dictionary["/D"] === "string") {
      referenced.add(dictionary["/D"]);
    }
    const names = dictionary["/Names"];
    if (Array.isArray(names)) {
      for (let index = 0; index < names.length; index += 2) {
        const name = names[index];
        if (typeof name === "string") defined.add(name);
      }
    }
    for (const value of Object.values(dictionary)) visit(value);
  };
  visit(json);

  return {
    referenced: referenced.size,
    missing: [...referenced].filter((name) => !defined.has(name)),
  };
}

interface QpdfOutline {
  title: string;
  destpageposfrom1: number | null;
  kids: QpdfOutline[];
}

async function readQpdfOutlines(pdfPath: string): Promise<BindOutlineEntry[]> {
  const { stdout } = await execFileP(
    "qpdf",
    [
      pdfPath,
      "--json-output=2",
      "--json-stream-data=none",
      "--json-key=outlines",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const json = JSON.parse(stdout) as { outlines?: QpdfOutline[] };
  const flattened: BindOutlineEntry[] = [];
  const visit = (entries: QpdfOutline[], level: number): void => {
    for (const entry of entries) {
      flattened.push({
        title: entry.title,
        pageIndex: (entry.destpageposfrom1 ?? 0) - 1,
        level,
      });
      visit(entry.kids ?? [], level + 1);
    }
  };
  visit(json.outlines ?? [], 0);
  return flattened;
}

function compareOutlines(
  expected: BindOutlineEntry[],
  actual: BindOutlineEntry[],
): string | null {
  if (actual.length !== expected.length) {
    return `outline count mismatch: expected=${expected.length} actual=${actual.length}`;
  }
  for (let index = 0; index < expected.length; index++) {
    const want = expected[index];
    const got = actual[index];
    if (
      want === undefined ||
      got === undefined ||
      want.title !== got.title ||
      want.pageIndex !== got.pageIndex ||
      want.level !== got.level
    ) {
      return `outline ${index} mismatch: expected=${JSON.stringify(want)} actual=${JSON.stringify(got)}`;
    }
  }
  return null;
}

async function qpdfVersion(): Promise<string> {
  try {
    const { stdout } = await execFileP("qpdf", ["--version"]);
    return stdout.trim().split("\n")[0] ?? "unknown";
  } catch {
    return "missing";
  }
}

async function shardpdfVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(
        path.resolve(BENCH_DIR, "..", "crates/core/package.json"),
        "utf8",
      ),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "missing";
  }
}
