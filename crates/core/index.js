const { randomUUID } = require("node:crypto");
const { rename, rm } = require("node:fs/promises");
const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
const nativeBinding = require("./native.js");

/**
 * Typed error surface. Native errors carry a `[CODE] message` prefix; the
 * wrapper turns them into ShardPdfError with a stable `code`. Branch on
 * `error.code`, never on message text.
 */
class ShardPdfError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{cause?: unknown}} [options]
   */
  constructor(message, code, options) {
    super(message, options);
    this.name = "ShardPdfError";
    this.code = code;
  }
}

const NATIVE_ERROR_PATTERN = /^\[([A-Z_]+)\] ([\s\S]*)$/;

/** @param {unknown} error @returns {never} */
function rethrowTranslated(error) {
  if (error instanceof Error) {
    const match = NATIVE_ERROR_PATTERN.exec(error.message);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      throw new ShardPdfError(match[2], match[1], { cause: error });
    }
  }
  throw error;
}

/** @template T @param {() => T} fn @returns {T} */
function translating(fn) {
  try {
    return fn();
  } catch (error) {
    rethrowTranslated(error);
  }
}

/** Streaming multi-shard assembly (low-level; prefer `assemble`). */
class Assembly {
  /** @type {import("./native.js").Assembly} */
  #inner;

  /** @param {string} outputPath */
  constructor(outputPath) {
    this.#inner = translating(() => new nativeBinding.Assembly(outputPath));
  }

  /** @param {string} shardPath @returns {number} appended page count */
  appendShard(shardPath) {
    return translating(() => this.#inner.appendShard(shardPath));
  }

  /** @returns {number} total pages appended so far */
  get pageCount() {
    return translating(() => this.#inner.pageCount);
  }

  /** Closes the partial output without finalizing it. Consumed. */
  abort() {
    translating(() => this.#inner.abort());
  }

  /**
   * Writes the assembled document, with optional bookmarks. Consumed.
   * @param {import("./index.js").AssembleOutlineEntry[]} [outline]
   */
  finalize(outline) {
    translating(() =>
      this.#inner.finalize(
        outline?.map((entry) => ({
          title: entry.title,
          pageIndex: entry.pageIndex,
          level: entry.level ?? 0,
        })),
      ),
    );
  }
}

/** Parses a source once; serves many page-range extractions (low-level). */
class Extractor {
  /** @type {import("./native.js").Extractor} */
  #inner;

  /** @param {string} inputPath */
  constructor(inputPath) {
    this.#inner = translating(() => new nativeBinding.Extractor(inputPath));
  }

  /** @returns {number} total pages in the source */
  get pageCount() {
    return translating(() => this.#inner.pageCount);
  }

  /**
   * @param {number} startPage 1-based inclusive
   * @param {number} endPage 1-based inclusive
   * @param {string} outputPath
   * @returns {number} extracted page count
   */
  extractRange(startPage, endPage, outputPath) {
    return translating(() =>
      this.#inner.extractRange(startPage, endPage, outputPath),
    );
  }
}

/**
 * @typedef {object} AssembleOptions
 * @property {string[]} shards
 * @property {string} outputPath
 * @property {{title: string, pageIndex: number, level?: number}[]} [outline]
 * @property {AbortSignal} [signal]
 */

/**
 * Assemble already-rendered PDF shards through the streaming native core.
 *
 * Cancellation is observed before each shard and before finalization. Each
 * append is synchronous and atomic from JavaScript's perspective, so a signal
 * cannot interrupt a shard while the native parser is processing it.
 *
 * @param {AssembleOptions} input
 * @returns {Promise<{pageCount: number}>}
 */
async function assemble(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("assemble input must be an object");
  }
  const { shards, outputPath, outline, signal } = input;
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

  signal?.throwIfAborted();
  const partialPath = `${outputPath}.partial-${process.pid}-${randomUUID()}`;
  let assembly;
  let pageCountTotal = 0;

  try {
    assembly = new Assembly(partialPath);
    for (let index = 0; index < shards.length; index++) {
      signal?.throwIfAborted();
      pageCountTotal += assembly.appendShard(shards[index]);

      // Give timers and abort handlers a chance to run between native calls.
      if (index + 1 < shards.length) await yieldToEventLoop();
    }
    signal?.throwIfAborted();
    assembly.finalize(outline);
    signal?.throwIfAborted();
    await rename(partialPath, outputPath);
    return { pageCount: pageCountTotal };
  } finally {
    // A failed append leaves the native writer open. Consume it before
    // unlinking so cleanup is deterministic on Windows as well as POSIX.
    try {
      assembly?.abort();
    } catch {
      // Successful finalize already consumed the native assembly.
    }
    await rm(partialPath, { force: true });
  }
}

/**
 * @typedef {object} ExtractOptions
 * @property {string} input
 * @property {{startPage: number, endPage: number, output: string}[]} ranges
 * @property {AbortSignal} [signal]
 */

/**
 * Slice one or more inclusive, 1-based page ranges out of `input`, parsing
 * the source exactly once. On error or cancellation, every slice already
 * written by this call is removed — no partial result set survives.
 *
 * @param {ExtractOptions} options
 * @returns {Promise<{sourcePageCount: number, ranges: {output: string, pageCount: number}[]}>}
 */
async function extract(options) {
  if (options === null || typeof options !== "object") {
    throw new TypeError("extract options must be an object");
  }
  const { input, ranges, signal } = options;
  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError("input must be a non-empty string");
  }
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new RangeError("extract requires at least one range");
  }
  for (const range of ranges) {
    if (
      range === null ||
      typeof range !== "object" ||
      !Number.isInteger(range.startPage) ||
      !Number.isInteger(range.endPage) ||
      typeof range.output !== "string" ||
      range.output.length === 0
    ) {
      throw new TypeError(
        "every range needs integer startPage/endPage and a non-empty output path",
      );
    }
  }

  signal?.throwIfAborted();
  const extractor = new Extractor(input);
  /** @type {{output: string, pageCount: number}[]} */
  const written = [];
  try {
    for (let index = 0; index < ranges.length; index++) {
      signal?.throwIfAborted();
      const range = ranges[index];
      const pageCountRange = extractor.extractRange(
        range.startPage,
        range.endPage,
        range.output,
      );
      written.push({ output: range.output, pageCount: pageCountRange });
      if (index + 1 < ranges.length) await yieldToEventLoop();
    }
    signal?.throwIfAborted();
    return { sourcePageCount: extractor.pageCount, ranges: written };
  } catch (error) {
    await Promise.all(
      written.map((slice) => rm(slice.output, { force: true })),
    );
    throw error;
  }
}

/**
 * Single-range convenience with the qpdf argument shape. Prefer `extract`
 * for multiple ranges — it parses the source once.
 * @param {string} inputPath @param {number} startPage
 * @param {number} endPage @param {string} outputPath
 * @returns {number}
 */
function extractPages(inputPath, startPage, endPage, outputPath) {
  return translating(() =>
    nativeBinding.extractPages(inputPath, startPage, endPage, outputPath),
  );
}

/** @param {string} inputPath @returns {number} */
function pageCount(inputPath) {
  return translating(() => nativeBinding.pageCount(inputPath));
}

/** @param {string} inputPath @returns {import("./native.js").ValidationReport} */
function validate(inputPath) {
  return translating(() => nativeBinding.validate(inputPath));
}

// Keep explicit assignments so Node's CommonJS lexer exposes named ESM imports.
module.exports.Assembly = Assembly;
module.exports.Extractor = Extractor;
module.exports.ShardPdfError = ShardPdfError;
module.exports.assemble = assemble;
module.exports.extract = extract;
module.exports.extractPages = extractPages;
module.exports.pageCount = pageCount;
module.exports.validate = validate;
