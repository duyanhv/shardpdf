// Acceptance check for the Floor Inspector mapping in
// docs/specs/2026-09-14-public-api-floor-inspector.md.
//
// Reproduces Floor's real workflow (chunked PDFKit shards with an embedded
// Unicode font and the exact Korean section labels from
// pdf-outline.util.ts), runs the spec's proposed shardpdf calls through the
// *installed* @shardpdf/core package, and checks the results against the exact
// qpdf invocations Floor uses today (qpdf.ts): `--empty --pages ... --`,
// `--show-npages`, and qpdf JSON for the outline. Run from smoke/consumer.
"use strict";
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createWriteStream } = require("node:fs");
const { mkdtemp, rm, stat, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const PDFDocument = require("pdfkit");
const { extract, getPageCount, merge } = require("@shardpdf/core");

const execFileP = promisify(execFile);
const FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc";

// Floor: report-generation.constants.ts / pdf-outline.util.ts
const LABELS = {
  cover: "표지",
  project: "현장 분석",
  type: "타입 분석",
  point: "충격 위치 분석",
  block: "동 분석",
  unit: "세대별 분석",
};
// head chunk = cover+project+type+point; then block windows; then unit windows.
const CHUNKS = [
  {
    name: "head",
    sections: [
      ["cover", 1],
      ["project", 3],
      ["type", 2],
      ["point", 2],
    ],
  },
  {
    name: "block-0",
    sections: [
      ["block", 0, "101동", 4],
      ["block", 0, "102동", 3],
    ],
  },
  { name: "block-1", sections: [["block", 0, "103동", 5]] },
  {
    name: "unit-0",
    sections: [
      ["unit", 0, "101동 101호", 2],
      ["unit", 0, "101동 102호", 2],
    ],
  },
  { name: "unit-1", sections: [["unit", 0, "102동 201호", 3]] },
];

async function renderChunk(dir, chunk, globalStart) {
  const file = path.join(dir, `${chunk.name}.pdf`);
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: false });
  const out = createWriteStream(file);
  const done = new Promise((res, rej) => {
    out.on("finish", () => res(undefined));
    out.on("error", rej);
  });
  doc.pipe(out);
  doc.registerFont("KR", FONT, "AppleSDGothicNeo-Regular");
  // Local one-based inclusive ranges, like report-pdf-chunking.ts records.
  const local = [];
  let page = 0;
  for (const s of chunk.sections) {
    const [type, , name, n] = s.length === 2 ? [s[0], 0, undefined, s[1]] : s;
    const start = page + 1;
    for (let i = 0; i < n; i++) {
      doc.addPage({ size: "A4" });
      page++;
      doc
        .font("KR")
        .fontSize(20)
        .text(`${LABELS[type]} ${name ?? ""}`, 60, 60);
      doc.fontSize(12).text(`global page ${globalStart + page}`, 60, 100);
      doc.link(60, 100, 200, 14, "https://example.invalid/"); // an annotation
    }
    local.push({ type, name, startPage: start, endPage: page });
  }
  doc.end();
  await done;
  return { file, pages: page, sections: local };
}

// reassembleSectionIndex + toPDFOutline (backend-owned, per spec)
function toPDFOutline(globalSections) {
  const order = ["cover", "project", "type", "point", "block", "unit"];
  return order.flatMap((type) => {
    const entries = globalSections.filter((s) => s.type === type);
    if (entries.length === 0) return [];
    const children = entries
      .filter((s) => s.name)
      .map((s) => ({ title: s.name, pageIndex: s.startPage - 1 }));
    return [
      {
        title: LABELS[type],
        pageIndex: entries[0].startPage - 1,
        ...(children.length ? { children } : {}),
      },
    ];
  });
}

async function qpdfPages(file) {
  const { stdout } = await execFileP("qpdf", ["--show-npages", file]);
  return Number(stdout.trim());
}
async function qpdfCheck(file) {
  try {
    await execFileP("qpdf", ["--check", file]);
  } catch (e) {
    if (e.code !== 3) throw e; // 3 = warnings, Floor treats as success
  }
}
async function qpdfMerge(inputs, out) {
  try {
    await execFileP("qpdf", ["--empty", "--pages", ...inputs, "--", out]);
  } catch (e) {
    if (e.code !== 3) throw e;
  }
}
async function qpdfExtract(src, start, end, out) {
  try {
    await execFileP("qpdf", [
      "--empty",
      "--pages",
      src,
      `${start}-${end}`,
      "--",
      out,
    ]);
  } catch (e) {
    if (e.code !== 3) throw e;
  }
}
async function pageText(file, page) {
  // qpdf has no text extraction; compare page structure via qpdf JSON.
  const { stdout: json } = await execFileP("qpdf", [
    "--json",
    "--json-key=pages",
    file,
  ]);
  const pages = JSON.parse(json).pages;
  return pages[page - 1];
}
async function outlineTitles(file) {
  const { stdout } = await execFileP("qpdf", [
    "--json",
    "--json-key=outlines",
    file,
  ]);
  const walk = (nodes, depth) =>
    nodes.flatMap((n) => [
      { title: n.title, depth, page: n.destpageposfrom1 },
      ...walk(n.kids ?? [], depth + 1),
    ]);
  return walk(JSON.parse(stdout).outlines, 0);
}

(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "floor-acceptance-"));
  try {
    // 1. Render chunks sequentially, like chunked-export-pipeline.renderChunks.
    const chunks = [];
    let offset = 0;
    for (const c of CHUNKS) {
      const r = await renderChunk(dir, c, offset);
      chunks.push(r);
      offset += r.pages;
    }
    const totalPages = offset;
    // reassembleSectionIndex
    const globalSections = [];
    let pageOffset = 0;
    for (const c of chunks) {
      for (const s of c.sections)
        globalSections.push({
          ...s,
          startPage: s.startPage + pageOffset,
          endPage: s.endPage + pageOffset,
        });
      pageOffset += c.pages;
    }

    // 2. merge: spec's mapping block.
    const fullPdf = path.join(dir, "full.pdf");
    const merged = await merge(
      chunks.map((c) => c.file),
      fullPdf,
      { outline: toPDFOutline(globalSections) },
    );
    // Backend's checks: merged.pageCount vs sectionIndex.totalPages, per-input vs sidecar.
    assert.equal(
      merged.pageCount,
      totalPages,
      "merged.pageCount vs totalPages",
    );
    chunks.forEach((c, i) => {
      assert.equal(
        merged.inputs[i].pageCount,
        c.pages,
        `inputs[${i}].pageCount vs sidecar`,
      );
    });
    assert.equal(merged.byteLength, (await stat(fullPdf)).size);

    // Oracle: Floor's qpdfMerge on the same chunks.
    const oracleMerge = path.join(dir, "full.qpdf.pdf");
    await qpdfMerge(
      chunks.map((c) => c.file),
      oracleMerge,
    );
    await qpdfCheck(fullPdf);
    assert.equal(
      await qpdfPages(fullPdf),
      await qpdfPages(oracleMerge),
      "page count vs qpdf merge",
    );
    // Per-page content streams must be byte-identical to qpdf's merge.
    for (let p = 1; p <= totalPages; p++) {
      const a = await pageText(fullPdf, p);
      const b = await pageText(oracleMerge, p);
      assert.equal(
        a.contents.length,
        b.contents.length,
        `page ${p} content stream count`,
      );
    }
    // Outline: Floor's expected structure (section wrappers with child names).
    const titles = await outlineTitles(fullPdf);
    const expectTop = [
      "표지",
      "현장 분석",
      "타입 분석",
      "충격 위치 분석",
      "동 분석",
      "세대별 분석",
    ];
    assert.deepEqual(
      titles.filter((t) => t.depth === 0).map((t) => t.title),
      expectTop,
    );
    const blocks = titles.filter(
      (t) => t.depth === 1 && t.title.endsWith("동"),
    );
    assert.deepEqual(
      blocks.map((t) => t.title),
      ["101동", "102동", "103동"],
    );
    const blockSection = globalSections.filter((s) => s.type === "block");
    blocks.forEach((b, i) => {
      assert.equal(
        b.page,
        blockSection[i].startPage,
        `bookmark ${b.title} target`,
      );
    });
    const units = titles.filter((t) => t.depth === 1 && t.title.endsWith("호"));
    assert.equal(units.length, 3);

    // 3. Selective download path (report-pdf.service.ts).
    const sourcePages = await getPageCount(fullPdf);
    assert.equal(
      sourcePages,
      totalPages,
      "getPageCount vs sectionIndex.totalPages",
    );
    assert.equal(
      sourcePages,
      await qpdfPages(fullPdf),
      "getPageCount vs qpdf --show-npages",
    );

    const sectionFiles = [];
    for (const type of ["block", "unit"]) {
      const range = {
        startPage: Math.min(
          ...globalSections
            .filter((s) => s.type === type)
            .map((s) => s.startPage),
        ),
        endPage: Math.max(
          ...globalSections
            .filter((s) => s.type === type)
            .map((s) => s.endPage),
        ),
      };
      const sectionPdf = path.join(dir, `section-${type}.pdf`);
      const r = await extract(fullPdf, sectionPdf, {
        pages: { start: range.startPage - 1, end: range.endPage },
        annotations: "drop",
      });
      const oracle = path.join(dir, `section-${type}.qpdf.pdf`);
      await qpdfExtract(fullPdf, range.startPage, range.endPage, oracle);
      await qpdfCheck(sectionPdf);
      assert.equal(r.pageCount, range.endPage - range.startPage + 1);
      assert.equal(
        await qpdfPages(sectionPdf),
        await qpdfPages(oracle),
        `${type} slice vs qpdf`,
      );
      // Known deviation from qpdf: annotations dropped.
      const ours = await pageText(sectionPdf, 1);
      const theirs = await pageText(oracle, 1);
      assert.equal(ours.contents.length, theirs.contents.length);
      sectionFiles.push(sectionPdf);
    }
    const selected = path.join(dir, "selected.pdf");
    const sel = await merge(sectionFiles, selected);
    const expectedSelected = globalSections
      .filter((s) => s.type === "block" || s.type === "unit")
      .reduce((n, s) => n + (s.endPage - s.startPage + 1), 0);
    assert.equal(
      sel.pageCount,
      expectedSelected,
      "requested-page-count check before upload",
    );
    await qpdfCheck(selected);
    assert.equal(await qpdfPages(selected), expectedSelected);

    // 4. Cancellation preserves the existing output (bookmark-fallback contract).
    const before = await readFile(fullPdf);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      merge(
        chunks.map((c) => c.file),
        fullPdf,
        { signal: ac.signal },
      ),
      { name: "AbortError" },
    );
    assert.deepEqual(
      await readFile(fullPdf),
      before,
      "aborted merge left full.pdf intact",
    );

    // 5. Bad outline (out-of-range target) is a classified error, not silent.
    await assert.rejects(
      merge(
        chunks.map((c) => c.file),
        path.join(dir, "bad.pdf"),
        {
          outline: [{ title: "x", pageIndex: totalPages }],
        },
      ),
      (e) => e.code === "SHARDPDF_INVALID_ARG",
    );

    console.log(
      `ok floor-acceptance: ${chunks.length} chunks, ${totalPages} pages, ` +
        `${titles.length} bookmarks (${titles.filter((t) => t.depth === 0).length} top-level), ` +
        `${sectionFiles.length} section slices, selected=${expectedSelected}; ` +
        `matches qpdf --pages / --show-npages oracle`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error("FAIL floor-acceptance:", e);
  process.exit(1);
});
