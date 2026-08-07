import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderPagesWithPdfkit } from "../runners/pdfkit/render.ts";
import { generateWorkload, type ScaleName } from "../workload/data.ts";
import { layoutDocument } from "../workload/layout.ts";
import type { BindFixtureManifest, BindOutlineEntry } from "./types.ts";

export const BIND_SHARD_PAGES = 400;
export const BIND_MANIFEST_FILE = "manifest.json";

/**
 * Pre-render one immutable set of PDFKit shards shared by every binder run.
 * Fixture preparation is intentionally outside the measured process: this
 * benchmark isolates assembly RSS and wall time from renderer/layout costs.
 */
export async function prepareBindFixture(
  scale: ScaleName,
  fixtureDir: string,
): Promise<string> {
  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(fixtureDir, { recursive: true });

  const workload = generateWorkload(scale);
  const layout = layoutDocument(workload);
  const shards: string[] = [];

  for (let start = 0; start < layout.pages.length; start += BIND_SHARD_PAGES) {
    const relativePath = `shard-${String(shards.length).padStart(4, "0")}.pdf`;
    await renderPagesWithPdfkit(
      layout.pages.slice(start, start + BIND_SHARD_PAGES),
      start,
      layout,
      path.join(fixtureDir, relativePath),
    );
    shards.push(relativePath);
  }

  const firstCustomer = workload.customers[0];
  if (firstCustomer === undefined) {
    throw new Error("bind fixture requires at least one customer");
  }
  const firstCustomerPage = layout.anchorPage[firstCustomer.id];
  if (firstCustomerPage === undefined) {
    throw new Error(`missing first customer anchor ${firstCustomer.id}`);
  }

  const outline: BindOutlineEntry[] = [
    { title: "Cover", pageIndex: 0, level: 0 },
    { title: "Table of Contents", pageIndex: 1, level: 0 },
    { title: "Customers", pageIndex: firstCustomerPage, level: 0 },
    ...workload.customers.map((customer) => {
      const pageIndex = layout.anchorPage[customer.id];
      if (pageIndex === undefined) {
        throw new Error(`missing customer anchor ${customer.id}`);
      }
      return { title: customer.name, pageIndex, level: 1 };
    }),
  ];

  const manifest: BindFixtureManifest = {
    version: 1,
    scale,
    shardPages: BIND_SHARD_PAGES,
    totalPages: layout.totalPages,
    shards,
    outline,
  };
  const manifestPath = path.join(fixtureDir, BIND_MANIFEST_FILE);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}
