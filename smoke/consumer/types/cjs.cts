// Compile-only check: CommonJS-style consumption (`import x = require()`) of
// every public type under moduleResolution nodenext.
import core = require("@shardpdf/core");

type PDFSource = core.PDFSource;
type PDFFile = core.PDFFile;
type PDFOutlineEntry = core.PDFOutlineEntry;
type PDFProgress = core.PDFProgress;
type PDFOptions = core.PDFOptions;
type PDFWriteOptions = core.PDFWriteOptions;
type PDFResult = core.PDFResult;
type PDFMergeResult = core.PDFMergeResult;
type PDFMergeOptions = core.PDFMergeOptions;
type PDFPageSelection = core.PDFPageSelection;
type PDFExtractOptions = core.PDFExtractOptions;
type ShardPdfErrorCode = core.ShardPdfErrorCode;
type ShardPdfError = core.ShardPdfError;

async function exerciseTypesCjs(): Promise<void> {
  const {
    merge,
    extract,
    getPageCount,
    assemble,
    extractPages,
    Assembly,
    buildInfo,
  } = core;

  const pathSource: PDFSource = "./a.pdf";
  const bytesSource: PDFSource = Buffer.alloc(4);
  const output: PDFFile = "./out.pdf";
  const outline: readonly PDFOutlineEntry[] = [
    { title: "Root", pageIndex: 0, children: [] },
  ];
  const onProgress = (event: PDFProgress): void => void event.completed;
  const base: PDFOptions = { maxDecompressedBytes: 1 };
  const write: PDFWriteOptions = { ...base, onProgress };
  const mergeOptions: PDFMergeOptions = { ...write, outline };

  const merged: PDFMergeResult = await merge(
    [pathSource, bytesSource],
    output,
    mergeOptions,
  );
  void merged.inputs[0].startPageIndex;

  const selection: PDFPageSelection = { start: 0, end: 1 };
  const extractOptions: PDFExtractOptions = {
    pages: selection,
    annotations: "drop",
  };
  const sliced: PDFResult = await extract(pathSource, output, extractOptions);
  void sliced.byteLength;
  const count: number = await getPageCount(pathSource);
  void count;

  void (await assemble({ shards: ["./a.pdf"], outputPath: "./o.pdf" }))
    .pageCount;
  void extractPages("./a.pdf", 1, 1, "./b.pdf");
  new Assembly("./p.pdf", { maxDecompressedBytes: 1 }).abort();
  void buildInfo().profile;

  const err = new Error("x") as ShardPdfError;
  const code: ShardPdfErrorCode = err.code;
  void code;

  // @ts-expect-error annotations acknowledgement is required
  await extract(pathSource, output, { pages: [0] });
  // @ts-expect-error only "drop" is accepted
  await extract(pathSource, output, { pages: [0], annotations: "keep" });
  // @ts-expect-error a number is not a PDFSource
  await getPageCount(42);
}

export = { exerciseTypesCjs };
