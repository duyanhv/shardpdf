const { randomUUID } = require("node:crypto");
const { rename, rm } = require("node:fs/promises");
const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
const nativeBinding = require("./native.js");

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
  let pageCount = 0;

  try {
    assembly = new nativeBinding.Assembly(partialPath);
    for (let index = 0; index < shards.length; index++) {
      signal?.throwIfAborted();
      pageCount += assembly.appendShard(shards[index]);

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
    try {
      assembly?.abort();
    } catch {
      // Successful finalize already consumed the native assembly.
    }
    await rm(partialPath, { force: true });
  }
}

Object.assign(module.exports, nativeBinding);
// Keep explicit assignments so Node's CommonJS lexer exposes named ESM imports.
module.exports.Assembly = nativeBinding.Assembly;
module.exports.assemble = assemble;
