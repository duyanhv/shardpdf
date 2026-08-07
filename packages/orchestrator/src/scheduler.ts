import type { DocumentPlan, SectionSpec, Shard } from "./types.ts";

/**
 * Greedy partition of sections into shards under a page-estimate budget.
 * Estimates only steer packing — real page counts come from pass 1. A single
 * section over budget still gets its own shard (sections are atomic).
 */
export function partition<TData>(
  plan: DocumentPlan<TData>,
  maxPagesPerShard: number,
): Shard<TData>[] {
  if (maxPagesPerShard < 1) {
    throw new RangeError("maxPagesPerShard must be >= 1");
  }
  const shards: Shard<TData>[] = [];
  let current: SectionSpec<TData>[] = [];
  let currentEstimate = 0;

  const flush = (): void => {
    if (current.length > 0) {
      shards.push({ index: shards.length, sections: current });
      current = [];
      currentEstimate = 0;
    }
  };

  for (const section of plan.sections) {
    const estimate = Math.max(1, section.pageEstimate ?? 1);
    if (current.length > 0 && currentEstimate + estimate > maxPagesPerShard) {
      flush();
    }
    current.push(section);
    currentEstimate += estimate;
  }
  flush();
  return shards;
}
