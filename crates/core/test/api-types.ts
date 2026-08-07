import {
  type AssembleOptions,
  type AssembleResult,
  Assembly,
  assemble,
} from "../index.js";

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
