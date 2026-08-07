/**
 * Benchmark harness. Spawns a runner as a Node child process, samples its RSS,
 * classifies the outcome, validates the output with qpdf (dev-only oracle),
 * and writes a result JSON into results/.
 *
 *   node harness/run.ts --runner pdf-lib|pdfkit|react-pdf|merge|all \
 *                       --scale smoke|mid|full [--tag local] [--keep]
 *
 * The memory cap is NOT applied here — it comes from the container
 * (docker run --memory=2g --cpus=2, see Dockerfile). Locally, uncapped runs
 * still produce peak-RSS curves; capped runs are the headline numbers.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { SCALES, type ScaleName } from "../workload/data.ts";

const execFileP = promisify(execFile);

const BENCH_DIR = path.resolve(import.meta.dirname, "..");
const RUNNERS = [
  "pdf-lib",
  "pdfkit",
  "react-pdf",
  "merge",
  "shardpdf",
] as const;
type RunnerName = (typeof RUNNERS)[number];

const MEASURED_LIBS = [
  "pdf-lib",
  "pdfkit",
  "@react-pdf/renderer",
  "pdf-merger-js",
];

type Outcome = "ok" | "oom" | "crash" | "wrong-output";

interface BenchResult {
  runner: RunnerName;
  scale: ScaleName;
  outcome: Outcome;
  peakRssBytes: number | null;
  wallTimeMs: number;
  outputBytes: number | null;
  pageCountReported: number | null;
  pageCountActual: number | null;
  qpdf: "pass" | "fail" | "skipped";
  linkCheck: "pass" | "fail" | "skipped";
  exit: { code: number | null; signal: string | null };
  machine: { tag: string; node: string; platform: string };
  versions: Record<string, string>;
  timestamp: string;
  notes: string[];
}

async function sampleRssBytes(pid: number): Promise<number | null> {
  try {
    if (existsSync(`/proc/${pid}/status`)) {
      // VmHWM = true peak RSS so far; immune to sampling gaps between reads.
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = status.match(/VmHWM:\s+(\d+)\s+kB/);
      return match?.[1] !== undefined ? Number(match[1]) * 1024 : null;
    }
    const { stdout } = await execFileP("ps", ["-o", "rss=", "-p", String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch {
    return null; // process already gone
  }
}

/**
 * Named-destination integrity: qpdf --check accepts links whose /GoTo /D name
 * is never defined (exactly what merge tools silently produce), so verify that
 * every referenced destination name is defined in a name-tree object.
 */
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
        for (const m of chunk.matchAll(/\/D \(([^)]*)\)/g)) {
          if (m[1] !== undefined) referenced.add(m[1]);
        }
      }
      if (/\/(?:Names|Limits) \[/.test(chunk)) {
        for (const m of chunk.matchAll(/\(([^)]*)\)/g)) {
          if (m[1] !== undefined) defined.add(m[1]);
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

async function qpdfAvailable(): Promise<boolean> {
  try {
    await execFileP("qpdf", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function libraryVersions(): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const lib of MEASURED_LIBS) {
    try {
      const pkg = JSON.parse(
        await readFile(
          path.join(BENCH_DIR, "node_modules", lib, "package.json"),
          "utf8",
        ),
      ) as { version?: string };
      versions[lib] = pkg.version ?? "unknown";
    } catch {
      versions[lib] = "missing";
    }
  }
  return versions;
}

async function runOne(
  runner: RunnerName,
  scale: ScaleName,
  tag: string,
  keepOutput: boolean,
): Promise<BenchResult> {
  const outDir = path.join(BENCH_DIR, "out");
  await mkdir(outDir, { recursive: true });
  const outPdf = path.join(outDir, `${scale}-${runner}.pdf`);
  await rm(outPdf, { force: true });

  const notes: string[] = [];
  const runnerScript = path.join(BENCH_DIR, "runners", runner, "run.ts");

  console.log(`\n▶ ${runner} @ ${scale}`);
  const startedAt = Date.now();
  const child = spawn(process.execPath, [runnerScript, scale, outPdf], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });

  let peakRss: number | null = null;
  const takeSample = (): void => {
    if (child.pid === undefined) return;
    void sampleRssBytes(child.pid).then((rss) => {
      if (rss !== null && (peakRss === null || rss > peakRss)) peakRss = rss;
    });
  };
  takeSample(); // fast runners can finish inside the first interval
  const sampler = setInterval(takeSample, 100);

  const exit = await new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearInterval(sampler);
  const wallTimeMs = Date.now() - startedAt;

  let pageCountReported: number | null = null;
  const lastLine = stdout.trim().split("\n").at(-1);
  if (lastLine?.startsWith("{")) {
    try {
      pageCountReported = (JSON.parse(lastLine) as { pageCount: number | null })
        .pageCount;
    } catch {
      notes.push("runner stdout was not valid report JSON");
    }
  }

  let outcome: Outcome;
  let outputBytes: number | null = null;
  let pageCountActual: number | null = null;
  let qpdf: BenchResult["qpdf"] = "skipped";
  let linkCheck: BenchResult["linkCheck"] = "skipped";

  const v8HeapOom =
    stderr.includes("JavaScript heap out of memory") ||
    stderr.includes("Reached heap limit");
  if (exit.signal === "SIGKILL" || exit.code === 137) {
    outcome = "oom";
    notes.push(
      "killed by SIGKILL — OOM under container cap (or external kill)",
    );
  } else if (exit.code !== 0 && v8HeapOom) {
    outcome = "oom";
    notes.push(
      "V8 heap exhaustion (FATAL ERROR: JavaScript heap out of memory)",
    );
  } else if (exit.code !== 0) {
    outcome = "crash";
  } else {
    outputBytes = (await stat(outPdf)).size;
    if (await qpdfAvailable()) {
      try {
        await execFileP("qpdf", ["--check", outPdf], {
          maxBuffer: 64 * 1024 * 1024,
        });
        qpdf = "pass";
      } catch {
        qpdf = "fail";
        notes.push("qpdf --check failed");
      }
      try {
        const { stdout: npages } = await execFileP("qpdf", [
          "--show-npages",
          outPdf,
        ]);
        pageCountActual = Number(npages.trim());
      } catch {
        notes.push("qpdf --show-npages failed");
      }
      try {
        const links = await checkLinkIntegrity(outPdf);
        linkCheck = links.missing.length === 0 ? "pass" : "fail";
        if (links.missing.length > 0) {
          notes.push(
            `${links.missing.length}/${links.referenced} link destination names undefined (e.g. ${links.missing[0]}) — links are dead`,
          );
        }
      } catch {
        notes.push("link integrity check failed to run");
      }
    } else {
      notes.push("qpdf not installed — output validation skipped");
    }

    const pageMismatch =
      pageCountReported !== null &&
      pageCountActual !== null &&
      pageCountReported !== pageCountActual;
    if (pageMismatch)
      notes.push(
        `page count mismatch: reported ${pageCountReported}, actual ${pageCountActual}`,
      );
    outcome =
      qpdf === "fail" || linkCheck === "fail" || pageMismatch
        ? "wrong-output"
        : "ok";
  }

  if (!keepOutput) await rm(outPdf, { force: true });

  const result: BenchResult = {
    runner,
    scale,
    outcome,
    peakRssBytes: peakRss,
    wallTimeMs,
    outputBytes,
    pageCountReported,
    pageCountActual,
    qpdf,
    linkCheck,
    exit,
    machine: { tag, node: process.version, platform: process.platform },
    versions: await libraryVersions(),
    timestamp: new Date().toISOString(),
    notes,
  };

  const resultsDir = path.join(BENCH_DIR, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `${tag}-${scale}-${runner}.json`);
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  const rssMb = peakRss === null ? "?" : (peakRss / 1024 / 1024).toFixed(0);
  console.log(
    `  ${outcome.toUpperCase()}  peakRSS=${rssMb}MB  wall=${(wallTimeMs / 1000).toFixed(1)}s  pages=${pageCountActual ?? pageCountReported ?? "?"}  qpdf=${qpdf}  links=${linkCheck}`,
  );
  return result;
}

const { values } = parseArgs({
  options: {
    runner: { type: "string" },
    scale: { type: "string" },
    tag: { type: "string", default: "local" },
    keep: { type: "boolean", default: false },
  },
});

const scale = values.scale;
if (scale === undefined || !(scale in SCALES)) {
  console.error(`--scale must be one of: ${Object.keys(SCALES).join(", ")}`);
  process.exit(2);
}
const requested =
  values.runner === "all" || values.runner === undefined
    ? [...RUNNERS]
    : RUNNERS.filter((r) => r === values.runner);
if (requested.length === 0) {
  console.error(`--runner must be one of: ${RUNNERS.join(", ")}, all`);
  process.exit(2);
}

for (const runner of requested) {
  await runOne(runner, scale as ScaleName, values.tag, values.keep);
}
