import {
  type AssembleOptions,
  type AssembleResult,
  Assembly,
  assemble,
  extractPages,
  extractSelectionAsync,
  pageCountAsync,
} from "../index.js";

const extracted: number = extractPages("report.pdf", 10, 20, "slice.pdf");
void extracted;

const options: AssembleOptions = {
  shards: ["shard-0.pdf", "shard-1.pdf"],
  outputPath: "report.pdf",
  outline: [{ title: "Start", pageIndex: 0 }],
  signal: new AbortController().signal,
};
const result: Promise<AssembleResult> = assemble(options);
void result;

const lowLevel = new Assembly("report.partial.pdf");
lowLevel.abort();

const asyncCount: Promise<number> = pageCountAsync(new Uint8Array(4));
void asyncCount;
const asyncExtract: Promise<number> = extractSelectionAsync(
  "report.pdf",
  [0, 2],
  "slice.pdf",
);
void asyncExtract;
const appended: Promise<number> = lowLevel.appendShardAsync("shard-0.pdf");
void appended;
const finalized: Promise<void> = lowLevel.finalizeAsync();
void finalized;
const busy: boolean = lowLevel.busy;
void busy;
