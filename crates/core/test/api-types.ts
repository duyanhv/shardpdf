import {
  type AssembleOptions,
  type AssembleResult,
  Assembly,
  assemble,
  type ExtractOptions,
  Extractor,
  type ExtractResult,
  extract,
  extractPages,
  pageCount,
  ShardPdfError,
  type ShardPdfErrorCode,
  validate,
} from "../index.js";

const extracted: number = extractPages("report.pdf", 10, 20, "slice.pdf");
void extracted;

const extractOptions: ExtractOptions = {
  input: "report.pdf",
  ranges: [{ startPage: 1, endPage: 2, output: "slice.pdf" }],
  signal: new AbortController().signal,
};
const extractResult: Promise<ExtractResult> = extract(extractOptions);
void extractResult;

const count: number = pageCount("report.pdf");
void count;
const report = validate("report.pdf");
const dests: number = report.namedDestinations;
void dests;

const extractor = new Extractor("report.pdf");
const sliceCount: number = extractor.extractRange(1, 2, "slice.pdf");
void sliceCount;

const someError = new Error("x");
if (someError instanceof ShardPdfError) {
  const code: ShardPdfErrorCode = someError.code;
  void code;
}

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
