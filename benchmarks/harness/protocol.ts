/**
 * Runner contract: `node runners/<name>/run.ts <scale> <outputPath>`.
 * On success the runner's LAST stdout line is JSON: {"pageCount": number | null}
 * (null when the library gives no way to know). Exit code 0 = success.
 * The harness measures everything else from outside the process.
 */

import { SCALES, type ScaleName } from "../workload/data.ts";

export interface RunnerReport {
  pageCount: number | null;
}

export function runnerMain(
  render: (scale: ScaleName, outPath: string) => Promise<number | null>,
): void {
  const scale = process.argv[2];
  const outPath = process.argv[3];
  if (scale === undefined || outPath === undefined || !(scale in SCALES)) {
    console.error(
      `usage: node run.ts <${Object.keys(SCALES).join("|")}> <outputPath>`,
    );
    process.exit(2);
  }
  render(scale as ScaleName, outPath).then(
    (pageCount) => {
      const report: RunnerReport = { pageCount };
      console.log(JSON.stringify(report));
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
