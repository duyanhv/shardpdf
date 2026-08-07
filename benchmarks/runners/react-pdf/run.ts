/**
 * @react-pdf/renderer runner — the one IDIOMATIC runner: react-pdf owns layout
 * (Yoga), pagination, footers, and links, so it does NOT use the shared
 * reference layout. Content comes from the same workload data.
 *
 * Known spec deviation, by library limitation: react-pdf exposes no API to
 * learn which page an anchor lands on, so TOC entries are links WITHOUT page
 * numbers. Per workload/spec.md that is `wrong-output` even if the render
 * survives — itself a finding.
 *
 * No JSX: Node runs .ts via type stripping, which cannot transform JSX.
 */

import {
  Document,
  Link,
  Page,
  renderToFile,
  Text,
  View,
} from "@react-pdf/renderer";
import { createElement as h, type ReactElement } from "react";
import { runnerMain } from "../../harness/protocol.ts";
import { formatCents, generateWorkload } from "../../workload/data.ts";

const styles = {
  page: {
    paddingTop: 54,
    paddingBottom: 78,
    paddingHorizontal: 54,
    fontFamily: "Courier",
    fontSize: 9,
  },
  bold: { fontFamily: "Courier-Bold" },
  footer: {
    position: "absolute",
    bottom: 30,
    left: 0,
    right: 0,
    textAlign: "center",
  },
  invoice: { marginBottom: 8 },
} as const;

function footer(): ReactElement {
  return h(Text, {
    fixed: true,
    style: styles.footer,
    render: ({
      pageNumber,
      totalPages,
    }: {
      pageNumber: number;
      totalPages: number;
    }) => `Page ${pageNumber} of ${totalPages}`,
  });
}

runnerMain(async (scale, outPath) => {
  const workload = generateWorkload(scale);

  const cover = h(
    Page,
    { key: "cover", size: "LETTER", style: styles.page },
    h(Text, { style: styles.bold }, "Annual Billing Report"),
    h(Text, null, `Scale:     ${workload.scale}`),
    h(Text, null, `Customers: ${workload.customers.length}`),
    h(Text, null, `Invoices:  ${workload.totalInvoices}`),
    footer(),
  );

  const toc = h(
    Page,
    { key: "toc", size: "LETTER", style: styles.page, wrap: true },
    h(Text, { style: styles.bold }, "Table of Contents"),
    ...workload.customers.map((customer) =>
      // No page numbers: react-pdf cannot resolve anchor -> page for TOC text.
      h(Link, { key: customer.id, src: `#${customer.id}` }, customer.name),
    ),
    footer(),
  );

  const sections = workload.customers.map((customer) =>
    h(
      Page,
      { key: customer.id, size: "LETTER", style: styles.page, wrap: true },
      h(
        Text,
        { id: customer.id, style: styles.bold },
        `${customer.name}  (${customer.id})`,
      ),
      ...customer.invoices.map((invoice) =>
        h(
          View,
          { key: invoice.id, style: styles.invoice },
          h(
            Text,
            { style: styles.bold },
            `${invoice.id}  ${invoice.date}  total ${formatCents(invoice.totalCents)}`,
          ),
          ...invoice.items.map((item, i) =>
            h(
              Text,
              { key: i },
              `  ${item.sku}  ${item.description.padEnd(24)} ${String(item.qty).padStart(3)} x ${formatCents(item.unitPriceCents).padStart(11)} = ${formatCents(item.qty * item.unitPriceCents).padStart(12)}`,
            ),
          ),
        ),
      ),
      footer(),
    ),
  );

  await renderToFile(h(Document, null, cover, toc, ...sections), outPath);
  return null; // renderToFile exposes no page count; harness uses qpdf's.
});
