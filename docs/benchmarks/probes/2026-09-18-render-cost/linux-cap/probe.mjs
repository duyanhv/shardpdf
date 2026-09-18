/**
 * Linux verification of the gauge-dedupe result, under a real cgroup memory
 * cap. The macOS figures in the audit are uncapped and on a different libc and
 * allocator; this checks whether the conclusion survives the environment that
 * actually matters (Floor runs on a Debian EC2 host).
 *
 * It reproduces the two code paths directly rather than importing Floor:
 *
 *   naive   - a fresh canvas + PNG Buffer per page, handed to doc.image().
 *             PDFKit's _imageRegistry is keyed by PATH, so a Buffer always
 *             misses and embeds a new XObject.
 *   cached  - memoized on the image's key, embedded once via doc.openImage(),
 *             which is what shipped in Floor 87c5535ef.
 *
 * The gauge geometry, canvas size (BLOCK_AVG_BAR_CHART 430x180) and grade
 * cardinality match the real renderer. Fonts are standard-14 rather than
 * NotoSansKR: the font cost is identical in both arms, so it cancels out of the
 * comparison, and omitting it keeps the image self-contained.
 *
 * usage: node --expose-gc probe.mjs [pages]
 */

import { execFileSync } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { createCanvas } from "canvas";
import PDFDocument from "pdfkit";

const PAGES = Number(process.env.PAGES ?? process.argv[2] ?? 120);
const W = 430;
const H = 180;

function rssMb() {
  global.gc?.();
  global.gc?.();
  return Math.round(process.memoryUsage.rss() / 1048576);
}

/** cgroup v2 current/peak, i.e. what the kernel actually charged us. */
function cgroup(file) {
  try {
    return Math.round(
      Number(readFileSync(`/sys/fs/cgroup/memory.${file}`, "utf8").trim()) /
        1048576,
    );
  } catch {
    return null;
  }
}

/** Stand-in for renderAverageGauge: pure function of the grade, RGBA like the real one. */
function gauge(grade) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < 12; i++) {
    ctx.beginPath();
    ctx.fillStyle = `rgba(${(grade * 40 + i * 18) % 255}, 120, 90, ${i < grade * 2 ? 1 : 0.28})`;
    ctx.moveTo(10 + i * 34, 170);
    ctx.lineTo(28 + i * 34, 20 + (i % 5) * 12);
    ctx.lineTo(44 + i * 34, 170);
    ctx.closePath();
    ctx.fill();
  }
  return canvas.toBuffer("image/png");
}

async function run(mode) {
  const outPath = `/probe/${mode}-${PAGES}.pdf`;
  const before = rssMb();
  let peak = before;
  const sampler = setInterval(() => {
    const now = Math.round(process.memoryUsage.rss() / 1048576);
    if (now > peak) peak = now;
  }, 10);

  const doc = new PDFDocument({ size: "A4", bufferPages: false });
  const out = createWriteStream(outPath);
  const closed = finished(out);
  doc.pipe(out);

  const memo = new Map();
  let rasterizations = 0;
  const started = Date.now();

  for (let p = 0; p < PAGES; p++) {
    if (p > 0) doc.addPage();
    const grade = p % 6;

    let src;
    if (mode === "naive") {
      rasterizations++;
      src = gauge(grade);
    } else {
      if (!memo.has(grade)) {
        rasterizations++;
        memo.set(grade, doc.openImage(gauge(grade)));
      }
      src = memo.get(grade);
    }
    doc.image(src, 40, 80, { fit: [200, 84] });
  }

  doc.end();
  await closed;
  clearInterval(sampler);

  const wallMs = Date.now() - started;
  const { size } = await stat(outPath);
  const qdf = execFileSync(
    "qpdf",
    ["--qdf", "--object-streams=disable", outPath, "-"],
    { maxBuffer: 1 << 28, encoding: "latin1" },
  );
  const images = (qdf.match(/\/Subtype \/Image/g) ?? []).length;
  execFileSync("qpdf", ["--check", outPath], { stdio: "ignore" });

  return {
    mode,
    pages: PAGES,
    rasterizations,
    imageXObjects: images,
    rssBeforeMb: before,
    rssPeakMb: peak,
    rssDeltaMb: peak - before,
    wallMs,
    bytes: size,
  };
}

// ONE mode per process. Running both arms in a single process was misleading:
// whichever ran second inherited the heap the first had already grown, so its
// rssDelta read as ~0 regardless of its true cost. The caller runs this twice.
const mode = process.env.MODE ?? "naive";
if (mode !== "naive" && mode !== "cached") {
  console.error(`MODE must be naive or cached, got ${mode}`);
  process.exit(2);
}

const result = await run(mode);
console.log(
  JSON.stringify(
    {
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      cgroupMaxMb: cgroup("max"),
      cgroupPeakMb: cgroup("peak"),
      ...result,
    },
    null,
    2,
  ),
);
