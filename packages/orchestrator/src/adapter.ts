import type { RendererAdapter } from "./types.ts";

/**
 * Identity helper that types and shape-checks an adapter at definition time.
 * Because adapters cross a process boundary as module references, TypeScript
 * cannot link a plan's section data type to the adapter on its own — author
 * adapters through this so the contract is checked where the code is written:
 *
 * ```ts
 * export const adapter = defineAdapter<MySectionData>({
 *   measure(shard) { ... },
 *   render(shard, ctx) { ... },
 * });
 * ```
 */
export function defineAdapter<TData>(
  adapter: RendererAdapter<TData>,
): RendererAdapter<TData> {
  if (
    adapter === null ||
    typeof adapter !== "object" ||
    typeof adapter.measure !== "function" ||
    typeof adapter.render !== "function"
  ) {
    throw new TypeError("adapter must implement measure() and render()");
  }
  return adapter;
}
