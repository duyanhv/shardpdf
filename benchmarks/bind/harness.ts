import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  scale: ScaleName;
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
  scale: ScaleName;
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
    tag: { type: "string", default: "local-bind" },
    keep: { type: "boolean", default: false },
    iterations: { type: "string", default: "3" },
  },
});

if (values.scale === undefined || !(values.scale in SCALES)) {
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

const scale = values.scale as ScaleName;
const fixtureDir = path.join(BENCH_DIR, "out", `bind-fixture-${scale}`);
console.log(`Preparing shared ${scale} bind fixture (not measured)...`);
const manifestPath = await prepareBindFixture(scale, fixtureDir);
const fixture = JSON.parse(
  await readFile(manifestPath, "utf8"),
) as BindFixtureManifest;
console.log(
  `Prepared ${fixture.shards.length} shard(s), ${fixture.totalPages} pages, ${fixture.outline.length} outlines.`,
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
      await writeResultSet(engine, mode, fixture.scale, values.tag, samples);
    }
  }
} finally {
  if (!values.keep) await rm(fixtureDir, { recursive: true, force: true });
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
    `bind-${fixture.scale}-${engine}-${mode}-run-${iteration}.pdf`,
  );
  await mkdir(outDir, { recursive: true });
  await rm(outputPath, { force: true });

  console.log(
    `\n▶ bind ${engine} / ${mode} @ ${fixture.scale} (${iteration}/${iterations})`,
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
    } catch {
      notes.push("link integrity check failed to run");
    }
    if (mode === "outline") {
      try {
        const outlines = await readQpdfOutlines(outputPath);
        const mismatch = compareOutlines(fixture.outline, outlines);
        outlineCheck = mismatch === null ? "pass" : "fail";
        if (mismatch !== null) notes.push(mismatch);
      } catch {
        notes.push("outline validation failed to run");
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
    scale: fixture.scale,
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
  scale: ScaleName,
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
    scale,
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
    path.join(resultsDir, `${tag}-${scale}-bind-${engine}-${mode}.json`),
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
  const qdfPath = `${pdfPath}.qdf`;
  try {
    await execFileP(
      "qpdf",
      ["--qdf", "--object-streams=disable", pdfPath, qdfPath],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const text = await readFile(qdfPath, "latin1");
    const referenced = new Set<string>();
    const defined = new Set<string>();
    for (const chunk of text.split("endobj")) {
      if (chunk.includes("/S /GoTo")) {
        for (const match of chunk.matchAll(/\/D \(([^)]*)\)/g)) {
          if (match[1] !== undefined) referenced.add(match[1]);
        }
      }
      if (/\/(?:Names|Limits) \[/.test(chunk)) {
        for (const match of chunk.matchAll(/\(([^)]*)\)/g)) {
          if (match[1] !== undefined) defined.add(match[1]);
        }
      }
    }
    return {
      referenced: referenced.size,
      missing: [...referenced].filter((name) => !defined.has(name)),
    };
  } finally {
    await rm(qdfPath, { force: true });
  }
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
