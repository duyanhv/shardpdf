/**
 * Verifies the dedupe fix is visually a NO-OP: the naive and deduped PDFs must
 * be pixel-identical, not merely valid. This is the check that makes the
 * optimization safe to ship, and the kind of check that would have caught the
 * original issue -- `qpdf --check` passes on both, so validity proves nothing.
 *
 * Asserts:
 *   1. identical page counts
 *   2. identical rasterized pixels on sampled pages
 *   3. the deduped PDF has ~one image XObject per DISTINCT chart, not per page
 *
 * Requires: qpdf, and pdftoppm (poppler) or sips for rasterization.
 *
 * usage: FLOOR_ROOT=... node verify-dedupe.mjs [pages]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import zlib from "node:zlib";
import { OUT_DIR, outPath } from "./probe-config.mjs";

const pages = Number(process.argv[2] ?? 120);
mkdirSync(OUT_DIR, { recursive: true });

function has(bin) {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function run(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 1 << 28 });
}
function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exitCode = 1;
}

if (!has("qpdf")) {
  console.error("verify-dedupe: qpdf is required (brew install qpdf)");
  process.exit(2);
}
const raster = has("pdftoppm") ? "pdftoppm" : has("sips") ? "sips" : undefined;
if (!raster) {
  console.error("verify-dedupe: need pdftoppm (poppler) or sips to rasterize");
  process.exit(2);
}

// Render both variants through the probe itself, so this verifies the same
// code path the headline numbers came from.
for (const strategy of ["naive", "openimage"]) {
  run(process.execPath, [
    "--expose-gc",
    new URL("dedupe-probe.mjs", import.meta.url).pathname,
    String(pages),
    strategy,
  ]);
}
const naive = outPath("dedupe-naive.pdf");
const deduped = outPath("dedupe-openimage.pdf");
for (const p of [naive, deduped]) if (!existsSync(p)) fail(`missing ${p}`);

// 1. page counts
const nPages = Number(run("qpdf", ["--show-npages", naive]).trim());
const dPages = Number(run("qpdf", ["--show-npages", deduped]).trim());
console.log(`pages: naive=${nPages} deduped=${dPages}`);
if (nPages !== pages || dPages !== pages)
  fail(`expected ${pages} pages in both`);

// 3. image XObject count
function imageCount(p) {
  const qdf = run("qpdf", ["--qdf", "--object-streams=disable", p, "-"]);
  return (qdf.match(/\/Subtype \/Image/g) ?? []).length;
}
const nImgs = imageCount(naive);
const dImgs = imageCount(deduped);
console.log(`image XObjects: naive=${nImgs} deduped=${dImgs}`);
// The probe cycles 6 distinct grades; pdfkit may emit a soft mask per image.
if (dImgs > 6 * 2) fail(`deduped should hold <=12 image objects, got ${dImgs}`);
if (nImgs < pages)
  fail(`naive was expected to duplicate per page, got ${nImgs}`);

// 2. pixel equality on sampled pages
function rasterizePixels(pdf, page, tag) {
  const prefix = outPath(`verify-${tag}-${page}`);
  if (raster === "pdftoppm") {
    run("pdftoppm", [
      "-png",
      "-r",
      "72",
      "-f",
      String(page),
      "-l",
      String(page),
      pdf,
      prefix,
    ]);
  } else {
    run("sips", ["-s", "format", "png", "--out", `${prefix}.png`, pdf]);
  }
  const file = [
    `${prefix}-${page}.png`,
    `${prefix}-0${page}.png`,
    `${prefix}.png`,
  ].find(existsSync);
  if (!file)
    throw new Error(`rasterizer produced no output for ${pdf} p${page}`);
  // Compare decoded pixels, not file bytes: PNG encoder metadata differs.
  const buf = readFileSync(file);
  let i = 8;
  let idat = Buffer.alloc(0);
  let ihdr;
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("latin1");
    if (type === "IHDR") ihdr = buf.subarray(i + 8, i + 8 + 13).toString("hex");
    if (type === "IDAT")
      idat = Buffer.concat([idat, buf.subarray(i + 8, i + 8 + len)]);
    i += 12 + len;
  }
  return { ihdr, pixels: zlib.inflateSync(idat) };
}

const sample = [...new Set([1, Math.ceil(pages / 2), pages])];
for (const page of sample) {
  const a = rasterizePixels(naive, page, "naive");
  const b = rasterizePixels(deduped, page, "dedup");
  const same = a.ihdr === b.ihdr && a.pixels.equals(b.pixels);
  console.log(
    `page ${page}: ihdr ${a.ihdr === b.ihdr ? "match" : "DIFFER"}, ` +
      `${a.pixels.length} pixel bytes ${same ? "identical" : "DIFFER"}`,
  );
  if (!same) fail(`page ${page} is not pixel-identical`);
}

console.log(
  process.exitCode
    ? "\nRESULT: FAIL"
    : `\nRESULT: PASS - dedupe is visually a no-op (${nImgs} -> ${dImgs} image objects)`,
);
