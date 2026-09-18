/**
 * Process-tree RSS sampler, run as its own process.
 *
 * Two reasons this is a separate process rather than an in-test interval:
 *
 *  - An in-process `setInterval` cannot fire while a synchronous native call
 *    (`appendShard`) holds the event loop, so it samples the troughs between
 *    appends and misses exactly the peaks a soak test exists to bound.
 *  - The adapter renders inside forked workers. A sampler that watched only
 *    the parent PID would be blind to a per-page leak in adapter code, which
 *    is the main regression this is here to catch. Verified by mutation:
 *    retaining a 64 KB buffer per page does not move a parent-only
 *    measurement, and does move this one.
 *
 * It is a real file rather than a `node -e` string because escaping a regex
 * and a template literal through two levels of quoting silently produced a
 * `SyntaxError`, which surfaced only as "Unexpected end of JSON input" from
 * the parent.
 *
 * usage: node tree-rss-sampler.mjs <rootPid>
 * Prints `{"peak","samples"}` to stdout when stdin closes.
 */

import { execFileSync } from "node:child_process";

const root = Number(process.argv[2]);
if (!Number.isFinite(root)) {
  console.error("usage: node tree-rss-sampler.mjs <rootPid>");
  process.exit(2);
}

let peak = 0;
let samples = 0;

/** Sum RSS over `root` and every transitive child, from one `ps` call. */
function tick() {
  let rows;
  try {
    rows = execFileSync("ps", ["-o", "rss=,pid=,ppid=", "-ax"], {
      encoding: "utf8",
    });
  } catch {
    return; // ps can fail transiently while processes exit; skip the sample
  }

  const rssByPid = new Map();
  const childrenByPid = new Map();
  for (const row of rows.trim().split("\n")) {
    const parts = row.trim().split(/\s+/);
    const rss = Number(parts[0]);
    const pid = Number(parts[1]);
    const ppid = Number(parts[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rssByPid.set(pid, rss * 1024);
    const siblings = childrenByPid.get(ppid);
    if (siblings === undefined) childrenByPid.set(ppid, [pid]);
    else siblings.push(pid);
  }

  let total = 0;
  const stack = [root];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rssByPid.get(pid) ?? 0;
    for (const child of childrenByPid.get(pid) ?? []) stack.push(child);
  }

  if (total > peak) peak = total;
  samples++;
}

const interval = setInterval(tick, 5);
process.stdin.on("end", () => {
  clearInterval(interval);
  tick();
  process.stdout.write(JSON.stringify({ peak, samples }));
  process.exit(0);
});
process.stdin.resume();
