const { randomUUID } = require("node:crypto");
const { rename, rm, stat } = require("node:fs/promises");
const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
const { fileURLToPath } = require("node:url");
const nativeBinding = require("./native.js");

/**
 * @typedef {object} AssembleOptions
 * @property {string[]} shards
 * @property {string} outputPath
 * @property {{title: string, pageIndex: number, level?: number}[]} [outline]
 * @property {AbortSignal} [signal]
 * @property {(info: {index: number, path: string, pageCount: number, totalPages: number}) => void} [onShard]
 * @property {number} [maxDecompressedBytes] Bound on per-stream inflation while parsing shards.
 */

/**
 * Assemble already-rendered PDF shards through the streaming native core.
 *
 * Cancellation is observed before each shard and before finalization. Each
 * append is synchronous and atomic from JavaScript's perspective, so a signal
 * cannot interrupt a shard while the native parser is processing it.
 *
 * `onShard` fires after each successful append with that shard's page count;
 * throwing from it aborts the assembly (used by callers that verify counts
 * against a prior measurement).
 *
 * @param {AssembleOptions} input
 * @returns {Promise<{pageCount: number}>}
 */
async function assemble(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("assemble input must be an object");
  }
  const { shards, outputPath, outline, signal, onShard, maxDecompressedBytes } =
    input;
  if (!Array.isArray(shards) || shards.length === 0) {
    throw new RangeError("assemble requires at least one shard");
  }
  if (shards.some((shard) => typeof shard !== "string" || shard.length === 0)) {
    throw new TypeError("every shard path must be a non-empty string");
  }
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new TypeError("outputPath must be a non-empty string");
  }
  if (outline !== undefined && !Array.isArray(outline)) {
    throw new TypeError("outline must be an array when provided");
  }
  if (onShard !== undefined && typeof onShard !== "function") {
    throw new TypeError("onShard must be a function when provided");
  }

  signal?.throwIfAborted();
  const partialPath = `${outputPath}.partial-${process.pid}-${randomUUID()}`;
  let assembly;
  let pageCount = 0;

  try {
    assembly = new nativeBinding.Assembly(
      partialPath,
      maxDecompressedBytes === undefined ? undefined : { maxDecompressedBytes },
    );
    for (let index = 0; index < shards.length; index++) {
      signal?.throwIfAborted();
      const shardPages = assembly.appendShard(shards[index]);
      pageCount += shardPages;
      onShard?.({
        index,
        path: shards[index],
        pageCount: shardPages,
        totalPages: pageCount,
      });

      // Give timers and abort handlers a chance to run between native calls.
      if (index + 1 < shards.length) await yieldToEventLoop();
    }
    signal?.throwIfAborted();
    assembly.finalize(
      outline?.map((entry) => ({
        title: entry.title,
        pageIndex: entry.pageIndex,
        level: entry.level ?? 0,
      })),
    );
    signal?.throwIfAborted();
    await rename(partialPath, outputPath);
    return { pageCount };
  } finally {
    // A failed append leaves the Rust writer open. Consume it before unlinking
    // so cleanup is deterministic on Windows as well as POSIX systems.
    // abort() is idempotent, so this is safe after a successful finalize.
    assembly?.abort();
    await rm(partialPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Public operation facade: merge / extract / getPageCount.
//
// Built on the off-thread natives `pageCountAsync`, `extractSelectionAsync`,
// and `Assembly#appendShardAsync`/`appendShardBytesAsync`/`finalizeAsync`,
// which run the parse and write on the libuv threadpool so the event loop
// stays live during each call. Byte inputs are copied into the native task;
// nothing is spooled to disk. The synchronous natives remain exported for
// hosts that already run in a dedicated child process.
// ---------------------------------------------------------------------------

/**
 * @typedef {string | URL | Uint8Array} PDFSource
 * @typedef {string | URL} PDFFile
 * @typedef {{title: string, pageIndex: number, children?: readonly PDFOutlineEntry[]}} PDFOutlineEntry
 * @typedef {{operation: "merge" | "extract", completed: number, total: number, pageCount: number}} PDFProgress
 * @typedef {{signal?: AbortSignal, maxDecompressedBytes?: number}} PDFOptions
 * @typedef {PDFOptions & {onProgress?: (event: PDFProgress) => void}} PDFWriteOptions
 * @typedef {{pageCount: number, byteLength: number}} PDFResult
 * @typedef {PDFResult & {inputs: readonly {pageCount: number, startPageIndex: number}[]}} PDFMergeResult
 * @typedef {PDFWriteOptions & {outline?: readonly PDFOutlineEntry[]}} PDFMergeOptions
 * @typedef {readonly number[] | {start: number, end: number}} PDFPageSelection
 * @typedef {PDFWriteOptions & {pages: PDFPageSelection, annotations: "drop"}} PDFExtractOptions
 */

/**
 * Normalize a `PDFFile` (string path or `file:` URL) to a filesystem path.
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function toFilePath(value, name) {
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      throw new TypeError(
        `${name} must be a file: URL, got ${value.protocol} (download remote content in the host first)`,
      );
    }
    return fileURLToPath(value);
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `${name} must be a non-empty path string or a file: URL, got ${describe(value)}`,
    );
  }
  return value;
}

/**
 * Normalize a `PDFSource` to either a path or a byte view.
 * @param {unknown} value
 * @param {string} name
 * @returns {{path: string, bytes?: undefined} | {path?: undefined, bytes: Uint8Array}}
 */
function toSource(value, name) {
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0) {
      throw new RangeError(`${name} must not be an empty byte array`);
    }
    return { bytes: value };
  }
  if (value instanceof URL || typeof value === "string") {
    return { path: toFilePath(value, name) };
  }
  throw new TypeError(
    `${name} must be a path string, a file: URL, or a Uint8Array, got ${describe(value)}`,
  );
}

/** @param {unknown} value */
function describe(value) {
  if (value === null) return "null";
  if (typeof value === "string")
    return value === "" ? "empty string" : "string";
  if (typeof value === "object") return value.constructor?.name ?? "object";
  return typeof value;
}

/**
 * Validate the common option bag shared by the facade functions.
 * @param {unknown} options
 * @param {string} fnName
 * @returns {{signal?: AbortSignal, maxDecompressedBytes?: number, onProgress?: (event: PDFProgress) => void, outline?: unknown, pages?: unknown, annotations?: unknown}}
 */
function normalizeOptions(options, fnName) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object") {
    throw new TypeError(`${fnName} options must be an object when provided`);
  }
  const { signal, maxDecompressedBytes, onProgress } =
    /** @type {Record<string, unknown>} */ (options);
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError(`${fnName} options.signal must be an AbortSignal`);
  }
  if (
    maxDecompressedBytes !== undefined &&
    (typeof maxDecompressedBytes !== "number" ||
      !Number.isInteger(maxDecompressedBytes) ||
      maxDecompressedBytes <= 0)
  ) {
    throw new RangeError(
      `${fnName} options.maxDecompressedBytes must be a positive integer`,
    );
  }
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new TypeError(`${fnName} options.onProgress must be a function`);
  }
  return /** @type {any} */ (options);
}

/** @param {number | undefined} maxDecompressedBytes */
function loadOptions(maxDecompressedBytes) {
  return maxDecompressedBytes === undefined
    ? undefined
    : { maxDecompressedBytes };
}

/** @param {string} outputPath */
function partialPathFor(outputPath) {
  return `${outputPath}.partial-${process.pid}-${randomUUID()}`;
}

/**
 * Flatten nested outline entries into the native preorder list.
 * @param {unknown} outline
 * @returns {{title: string, pageIndex: number, level: number}[] | undefined}
 */
function flattenOutline(outline) {
  if (outline === undefined) return undefined;
  if (!Array.isArray(outline)) {
    throw new TypeError("merge options.outline must be an array when provided");
  }
  /** @type {{title: string, pageIndex: number, level: number}[]} */
  const flat = [];
  /**
   * @param {readonly unknown[]} entries
   * @param {number} level
   * @param {string} location
   */
  const visit = (entries, level, location) => {
    entries.forEach((entry, index) => {
      const where = `${location}[${index}]`;
      if (entry === null || typeof entry !== "object") {
        throw new TypeError(`${where} must be an object`);
      }
      const { title, pageIndex, children } =
        /** @type {Record<string, unknown>} */ (entry);
      if (typeof title !== "string") {
        throw new TypeError(`${where}.title must be a string`);
      }
      if (
        typeof pageIndex !== "number" ||
        !Number.isInteger(pageIndex) ||
        pageIndex < 0
      ) {
        throw new RangeError(
          `${where}.pageIndex must be a non-negative integer, got ${String(pageIndex)}`,
        );
      }
      flat.push({ title, pageIndex, level });
      if (children !== undefined) {
        if (!Array.isArray(children)) {
          throw new TypeError(`${where}.children must be an array`);
        }
        visit(children, level + 1, `${where}.children`);
      }
    });
  };
  visit(outline, 0, "outline");
  return flat;
}

/**
 * Merge complete PDF documents, in order, into one output file.
 *
 * @param {readonly PDFSource[]} inputs
 * @param {PDFFile} output
 * @param {PDFMergeOptions} [options]
 * @returns {Promise<PDFMergeResult>}
 */
async function merge(inputs, output, options) {
  if (!Array.isArray(inputs)) {
    throw new TypeError("merge inputs must be an array of PDF sources");
  }
  if (inputs.length === 0) {
    throw new RangeError("merge requires at least one input");
  }
  const sources = inputs.map((input, index) =>
    toSource(input, `inputs[${index}]`),
  );
  const outputPath = toFilePath(output, "output");
  const { signal, maxDecompressedBytes, onProgress, outline } =
    normalizeOptions(options, "merge");
  const flatOutline = flattenOutline(outline);

  signal?.throwIfAborted();
  const partialPath = partialPathFor(outputPath);
  /** @type {import("./native.js").Assembly | undefined} */
  let assembly;
  /** @type {{pageCount: number, startPageIndex: number}[]} */
  const inputResults = [];
  let pageCount = 0;

  try {
    assembly = new nativeBinding.Assembly(
      partialPath,
      loadOptions(maxDecompressedBytes),
    );
    for (let index = 0; index < sources.length; index++) {
      signal?.throwIfAborted();
      const source = sources[index];
      const startPageIndex = pageCount;
      const inputPages =
        source.bytes !== undefined
          ? await assembly.appendShardBytesAsync(source.bytes)
          : await assembly.appendShardAsync(source.path);
      pageCount += inputPages;
      inputResults.push({ pageCount: inputPages, startPageIndex });
      onProgress?.({
        operation: "merge",
        completed: index + 1,
        total: sources.length,
        pageCount,
      });
    }
    signal?.throwIfAborted();
    await assembly.finalizeAsync(flatOutline);
    signal?.throwIfAborted();
    await rename(partialPath, outputPath);
    const { size } = await stat(outputPath);
    return { pageCount, byteLength: size, inputs: inputResults };
  } finally {
    assembly?.abort();
    await rm(partialPath, { force: true });
  }
}

/**
 * Resolve a page selection against a known source page count. Returns the
 * zero-based indices in output order.
 * @param {unknown} pages
 * @param {number} sourcePageCount
 * @returns {number[]}
 */
function resolveSelection(pages, sourcePageCount) {
  if (Array.isArray(pages)) {
    if (pages.length === 0) {
      throw new RangeError(
        "extract options.pages must select at least one page",
      );
    }
    const seen = new Set();
    return pages.map((page, index) => {
      if (typeof page !== "number" || !Number.isInteger(page)) {
        throw new TypeError(
          `extract options.pages[${index}] must be an integer, got ${String(page)}`,
        );
      }
      if (page < 0 || page >= sourcePageCount) {
        throw new RangeError(
          `extract options.pages[${index}] is ${page}; the source has ${sourcePageCount} page(s) (indices 0..${sourcePageCount - 1})`,
        );
      }
      if (seen.has(page)) {
        throw new RangeError(
          `extract options.pages[${index}] repeats page ${page}; repeated pages are not supported yet`,
        );
      }
      seen.add(page);
      return page;
    });
  }
  if (pages !== null && typeof pages === "object") {
    const { start, end } = /** @type {Record<string, unknown>} */ (pages);
    if (typeof start !== "number" || !Number.isInteger(start)) {
      throw new TypeError(
        `extract options.pages.start must be an integer, got ${String(start)}`,
      );
    }
    if (typeof end !== "number" || !Number.isInteger(end)) {
      throw new TypeError(
        `extract options.pages.end must be an integer, got ${String(end)}`,
      );
    }
    if (start < 0 || end > sourcePageCount || start >= end) {
      throw new RangeError(
        `extract options.pages must satisfy 0 <= start < end <= ${sourcePageCount}, got start=${start} end=${end}`,
      );
    }
    return Array.from({ length: end - start }, (_, i) => start + i);
  }
  throw new TypeError(
    "extract options.pages must be an array of zero-based page indices or a {start, end} range",
  );
}

/**
 * @param {{path?: string, bytes?: Uint8Array}} source
 * @param {number | undefined} maxDecompressedBytes
 * @returns {Promise<number>}
 */
function countPages(source, maxDecompressedBytes) {
  return nativeBinding.pageCountAsync(
    /** @type {string | Uint8Array} */ (source.bytes ?? source.path),
    loadOptions(maxDecompressedBytes),
  );
}

/**
 * Report the number of pages in a PDF.
 *
 * @param {PDFSource} input
 * @param {PDFOptions} [options]
 * @returns {Promise<number>}
 */
async function getPageCount(input, options) {
  const source = toSource(input, "input");
  const { signal, maxDecompressedBytes } = normalizeOptions(
    options,
    "getPageCount",
  );
  signal?.throwIfAborted();
  return await countPages(source, maxDecompressedBytes);
}

/**
 * Extract a selection of pages from one PDF into a new file.
 *
 * @param {PDFSource} input
 * @param {PDFFile} output
 * @param {PDFExtractOptions} options
 * @returns {Promise<PDFResult>}
 */
async function extract(input, output, options) {
  const source = toSource(input, "input");
  const outputPath = toFilePath(output, "output");
  if (options === null || typeof options !== "object") {
    throw new TypeError(
      'extract requires an options object with `pages` and `annotations: "drop"`',
    );
  }
  const { signal, maxDecompressedBytes, onProgress, pages, annotations } =
    normalizeOptions(options, "extract");
  if (annotations !== "drop") {
    throw new TypeError(
      'extract requires `annotations: "drop"`: this release removes ALL annotations (links, form widgets, every /Annots entry), named destinations, and outlines from the extracted pages. Pass the option to acknowledge that limitation.',
    );
  }
  if (pages === undefined) {
    throw new TypeError(
      "extract requires options.pages (an array of zero-based indices or a {start, end} range)",
    );
  }

  signal?.throwIfAborted();
  const sourcePageCount = await countPages(source, maxDecompressedBytes);
  const selection = resolveSelection(pages, sourcePageCount);

  signal?.throwIfAborted();
  const partialPath = partialPathFor(outputPath);
  try {
    const extracted = await nativeBinding.extractSelectionAsync(
      /** @type {string | Uint8Array} */ (source.bytes ?? source.path),
      selection,
      partialPath,
      loadOptions(maxDecompressedBytes),
    );
    if (extracted !== selection.length) {
      throw new Error(
        `extract produced ${extracted} page(s) for a ${selection.length}-page selection`,
      );
    }
    onProgress?.({
      operation: "extract",
      completed: selection.length,
      total: selection.length,
      pageCount: extracted,
    });
    signal?.throwIfAborted();
    await rename(partialPath, outputPath);
    const { size } = await stat(outputPath);
    return { pageCount: extracted, byteLength: size };
  } finally {
    await rm(partialPath, { force: true });
  }
}

Object.assign(module.exports, nativeBinding);
// Keep explicit assignments so Node's CommonJS lexer exposes named ESM imports.
module.exports.Assembly = nativeBinding.Assembly;
module.exports.extractPages = nativeBinding.extractPages;
module.exports.extractSelection = nativeBinding.extractSelection;
module.exports.extractSelectionAsync = nativeBinding.extractSelectionAsync;
module.exports.pageCount = nativeBinding.pageCount;
module.exports.pageCountAsync = nativeBinding.pageCountAsync;
module.exports.buildInfo = nativeBinding.buildInfo;
module.exports.assemble = assemble;
module.exports.merge = merge;
module.exports.extract = extract;
module.exports.getPageCount = getPageCount;
