/**
 * Reference layout: turns the workload into an exact list of pages of text lines,
 * with anchors and link sources resolved to absolute page numbers.
 *
 * This is the manual "two-pass" that pdf-lib/pdfkit force on application code:
 * page numbers for the TOC and "Page X of Y" footers must be known before any
 * page is drawn, so the entire document is paginated here, up front, in memory.
 * shardpdf's orchestrator exists to own exactly this work.
 *
 * Monospace (Courier) layout keeps pagination trivially deterministic: every
 * line is one row, every page holds LINES_PER_PAGE rows.
 */

import { formatCents, type Workload } from "./data.ts";

export interface Line {
  text: string;
  bold?: boolean;
  /** Named destination starting at this line. */
  anchor?: string;
  /** This line is a link to the given anchor. */
  linkTo?: string;
}

export interface PageSpec {
  lines: Line[];
}

export interface LayoutDoc {
  pages: PageSpec[];
  totalPages: number;
  /** anchor name -> 0-based absolute page index */
  anchorPage: Record<string, number>;
}

export const PAGE = {
  width: 612, // US Letter, points
  height: 792,
  margin: 54,
  fontSize: 9,
  lineHeight: 12,
  footerHeight: 24,
} as const;

export const LINES_PER_PAGE = Math.floor(
  (PAGE.height - PAGE.margin * 2 - PAGE.footerHeight) / PAGE.lineHeight,
);

export function layoutDocument(workload: Workload): LayoutDoc {
  // TOC size is known up front: heading + blank + one row per customer.
  const tocLineCount = workload.customers.length + 2;
  const tocPageCount = Math.ceil(tocLineCount / LINES_PER_PAGE);
  const bodyStartPage = 1 + tocPageCount; // 0-based; page 0 is the cover

  // Pass 1: lay out the body, recording where each customer section lands.
  const bodyPages: PageSpec[] = [];
  const anchorPage: Record<string, number> = {};
  let current: Line[] = [];

  const flush = (): void => {
    bodyPages.push({ lines: current });
    current = [];
  };
  const push = (line: Line): void => {
    if (current.length >= LINES_PER_PAGE) flush();
    if (line.anchor !== undefined) {
      anchorPage[line.anchor] = bodyStartPage + bodyPages.length;
    }
    current.push(line);
  };

  for (const customer of workload.customers) {
    if (current.length > 0) flush(); // each section starts on a fresh page
    push({
      text: `${customer.name}  (${customer.id})`,
      bold: true,
      anchor: customer.id,
    });
    push({ text: "" });
    for (const invoice of customer.invoices) {
      push({
        text: `${invoice.id}  ${invoice.date}  total ${formatCents(invoice.totalCents)}`,
        bold: true,
      });
      for (const item of invoice.items) {
        const amount = formatCents(item.qty * item.unitPriceCents);
        push({
          text: `  ${item.sku}  ${item.description.padEnd(24)} ${String(item.qty).padStart(3)} x ${formatCents(item.unitPriceCents).padStart(11)} = ${amount.padStart(12)}`,
        });
      }
      push({ text: "" });
    }
  }
  if (current.length > 0) flush();

  // Pass 2: the TOC can now cite real page numbers.
  const tocLines: Line[] = [
    { text: "Table of Contents", bold: true },
    { text: "" },
  ];
  for (const customer of workload.customers) {
    const target = anchorPage[customer.id];
    if (target === undefined) throw new Error(`no anchor for ${customer.id}`);
    tocLines.push({
      text: `${customer.name.padEnd(48, ".")} ${String(target + 1).padStart(6)}`,
      linkTo: customer.id,
    });
  }
  const tocPages: PageSpec[] = [];
  for (let i = 0; i < tocLines.length; i += LINES_PER_PAGE) {
    tocPages.push({ lines: tocLines.slice(i, i + LINES_PER_PAGE) });
  }
  if (tocPages.length !== tocPageCount) {
    throw new Error(
      `TOC page estimate ${tocPageCount} != actual ${tocPages.length}`,
    );
  }

  const cover: PageSpec = {
    lines: [
      { text: "Annual Billing Report", bold: true },
      { text: "" },
      { text: `Scale:     ${workload.scale}` },
      { text: `Customers: ${workload.customers.length}` },
      { text: `Invoices:  ${workload.totalInvoices}` },
      { text: "" },
      { text: "Deterministic workload — seed 0x5eedba5e" },
    ],
  };

  const pages = [cover, ...tocPages, ...bodyPages];
  return { pages, totalPages: pages.length, anchorPage };
}
