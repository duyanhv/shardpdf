/** Breaks the determinism contract on purpose: measure over-reports by one
 * page. generate() must fail with DeterminismError, never ship the output. */

import type { RendererAdapter } from "../../src/types.ts";
import { adapter as honest, type TestSection } from "./test-adapter.ts";

export const adapter: RendererAdapter<TestSection> = {
  async measure(shard, ctx) {
    const result = await honest.measure(shard, ctx);
    return { ...result, pageCount: result.pageCount + 1 };
  },
  render: (shard, ctx) => honest.render(shard, ctx),
};
