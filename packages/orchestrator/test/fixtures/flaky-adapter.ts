/** Crashes each render's FIRST attempt, succeeds on retry — exercises the
 * pool's retry path and the "retry" progress event. A marker file beside the
 * output records that the first attempt happened. */

import { existsSync, writeFileSync } from "node:fs";
import { defineAdapter } from "../../src/adapter.ts";
import { adapter as honest, type TestSection } from "./test-adapter.ts";

export const adapter = defineAdapter<TestSection>({
  measure: (shard, ctx) => honest.measure(shard, ctx),
  async render(shard, ctx) {
    const marker = `${ctx.outputPath}.first-attempt`;
    if (!existsSync(marker)) {
      writeFileSync(marker, "");
      throw new Error("synthetic first-attempt crash");
    }
    await honest.render(shard, ctx);
  },
});
