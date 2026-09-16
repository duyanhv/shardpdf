// Compile-only check: ESM import of every public type under
// module/moduleResolution nodenext. The sibling package.json sets
// "type": "module" so this .ts is resolved as ESM, which is the path that
// depends on TypeScript reading the CJS-backed "exports" entry correctly.

import type {
  PDFExtractOptions,
  PDFFile,
  PDFMergeOptions,
  PDFMergeResult,
  PDFOptions,
  PDFOutlineEntry,
  PDFPageSelection,
  PDFProgress,
  PDFResult,
  PDFSource,
  PDFWriteOptions,
  ShardPdfError,
  ShardPdfErrorCode,
} from "@shardpdf/core";
import {
  Assembly,
  assemble,
  buildInfo,
  extract,
  extractPages,
  getPageCount,
  merge,
} from "@shardpdf/core";

export async function exerciseTypes(): Promise<void> {
  const pathSource: PDFSource = "./a.pdf";
  const urlSource: PDFSource = new URL("file:///tmp/a.pdf");
  const bytesSource: PDFSource = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const bufferSource: PDFSource = Buffer.from("%PDF");
  const output: PDFFile = new URL("file:///tmp/out.pdf");

  const outline: PDFOutlineEntry[] = [
    {
      title: "Root",
      pageIndex: 0,
      children: [{ title: "Child", pageIndex: 1 }],
    },
  ];
  const onProgress = (event: PDFProgress): void => {
    const op: "merge" | "extract" = event.operation;
    const n: number = event.completed + event.total + event.pageCount;
    void op;
    void n;
  };
  const base: PDFOptions = {
    signal: new AbortController().signal,
    maxDecompressedBytes: 1 << 20,
  };
  const write: PDFWriteOptions = { ...base, onProgress };
  const mergeOptions: PDFMergeOptions = { ...write, outline };

  const merged: PDFMergeResult = await merge(
    [pathSource, urlSource, bytesSource, bufferSource],
    output,
    mergeOptions,
  );
  const total: number = merged.pageCount + merged.byteLength;
  const start: number =
    merged.inputs[0].startPageIndex + merged.inputs[0].pageCount;
  void total;
  void start;

  const range: PDFPageSelection = { start: 0, end: 2 };
  const list: PDFPageSelection = [3, 1, 2];
  const extractOptions: PDFExtractOptions = {
    ...write,
    pages: range,
    annotations: "drop",
  };
  const sliced: PDFResult = await extract(
    pathSource,
    "./slice.pdf",
    extractOptions,
  );
  await extract(bytesSource, output, { pages: list, annotations: "drop" });
  void sliced.pageCount;

  const count: number = await getPageCount(urlSource, base);
  void count;

  // Legacy surface still typed.
  const legacy = await assemble({
    shards: ["./a.pdf"],
    outputPath: "./out.pdf",
    outline: [{ title: "t", pageIndex: 0, level: 1 }],
  });
  void legacy.pageCount;
  const pages: number = extractPages("./a.pdf", 1, 2, "./b.pdf", {
    maxDecompressedBytes: 1,
  });
  void pages;
  const asm = new Assembly("./partial.pdf");
  asm.abort();
  const info = buildInfo();
  const version: string = info.version;
  void version;

  // Error typing.
  try {
    await getPageCount("missing.pdf");
  } catch (err) {
    const e = err as ShardPdfError;
    const code: ShardPdfErrorCode = e.code;
    if (code === "SHARDPDF_IO" || code === "SHARDPDF_PDF_PARSE") void e.message;
  }

  // Negative cases: these must be compile errors.
  // @ts-expect-error annotations acknowledgement is required
  await extract(pathSource, output, { pages: [0] });
  // @ts-expect-error only "drop" is accepted
  await extract(pathSource, output, { pages: [0], annotations: "keep" });
  // @ts-expect-error a number is not a PDFSource
  await getPageCount(42);
  // @ts-expect-error a number is not a PDFSource inside merge inputs
  await merge([pathSource, 42], output);
  // @ts-expect-error unknown error code
  const bad: ShardPdfErrorCode = "SHARDPDF_NOPE";
  void bad;
}
