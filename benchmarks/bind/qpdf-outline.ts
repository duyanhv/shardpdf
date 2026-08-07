import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { BindOutlineEntry } from "./types.ts";

const execFileP = promisify(execFile);

type QpdfObjectRef = `${number} 0 R`;
type QpdfObjectValue = Record<string, unknown>;

interface QpdfJsonPage {
  object: QpdfObjectRef;
}

interface QpdfJsonMetadata {
  maxobjectid: number;
  [key: string]: unknown;
}

interface QpdfJsonObjectEntry {
  value?: QpdfObjectValue;
  stream?: { dict: QpdfObjectValue; data?: string };
}

interface QpdfJsonTrailer {
  value: QpdfObjectValue;
}

interface QpdfJsonObjectMap {
  trailer: QpdfJsonTrailer;
  [key: string]: QpdfJsonObjectEntry | QpdfJsonTrailer;
}

interface QpdfJsonDocument {
  pages: QpdfJsonPage[];
  qpdf: [QpdfJsonMetadata, QpdfJsonObjectMap];
  [key: string]: unknown;
}

interface OutlineNode {
  title: string;
  pageRef: QpdfObjectRef;
  children: OutlineNode[];
}

interface BranchResult {
  entries: Record<string, QpdfJsonObjectEntry>;
  firstRef: QpdfObjectRef;
  lastRef: QpdfObjectRef;
  directCount: number;
  nextObjectNumber: number;
}

/**
 * Reproduce Floor Inspector's current outline path: qpdf structural JSON is
 * read, parsed, mutated, stringified, then applied to the already-merged PDF.
 * Stream bytes are omitted so this measures the optimized production shape,
 * not qpdf's much larger default inline-stream JSON.
 */
export async function injectQpdfOutlines(
  inputPath: string,
  outputPath: string,
  outline: BindOutlineEntry[],
): Promise<void> {
  const jsonPath = `${outputPath}.qpdf.json`;
  try {
    await execFileP("qpdf", [
      inputPath,
      "--json-output=2",
      "--json-stream-data=none",
      "--json-key=pages",
      "--json-key=qpdf",
      jsonPath,
    ]);
    const document = JSON.parse(
      await readFile(jsonPath, "utf8"),
    ) as QpdfJsonDocument;
    const outlined = addOutline(document, outline);
    await writeFile(jsonPath, JSON.stringify(outlined));
    await execFileP("qpdf", [
      inputPath,
      `--update-from-json=${jsonPath}`,
      outputPath,
    ]);
  } finally {
    await rm(jsonPath, { force: true });
  }
}

function addOutline(
  document: QpdfJsonDocument,
  outline: BindOutlineEntry[],
): QpdfJsonDocument {
  if (outline.length === 0) return document;

  const pageRefs = document.pages.map((page) => page.object);
  const nodes = toOutlineTree(outline, pageRefs);
  const [metadata, objects] = document.qpdf;
  const rootRef = readObjectRef(objects.trailer.value["/Root"], "trailer root");
  const catalog = readValueEntry(objects, rootRef, "catalog");
  const outlineRootRef = makeObjectRef(metadata.maxobjectid + 1);
  const branch = buildBranch(outlineRootRef, nodes, metadata.maxobjectid + 2);

  return {
    ...document,
    qpdf: [
      { ...metadata, maxobjectid: branch.nextObjectNumber - 1 },
      {
        ...objects,
        ...branch.entries,
        [`obj:${outlineRootRef}`]: {
          value: {
            "/Type": "/Outlines",
            "/First": branch.firstRef,
            "/Last": branch.lastRef,
            "/Count": branch.directCount,
          },
        },
        [`obj:${rootRef}`]: {
          value: { ...catalog, "/Outlines": outlineRootRef },
        },
      },
    ],
  };
}

function toOutlineTree(
  outline: BindOutlineEntry[],
  pageRefs: QpdfObjectRef[],
): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  outline.forEach((entry, index) => {
    if (!Number.isInteger(entry.level) || entry.level < 0) {
      throw new Error(
        `outline entry ${index} has invalid level ${entry.level}`,
      );
    }
    if (entry.level > stack.length) {
      throw new Error(
        `outline entry ${index} jumps from level ${Math.max(0, stack.length - 1)} to ${entry.level}`,
      );
    }
    const pageRef = pageRefs[entry.pageIndex];
    if (pageRef === undefined) {
      throw new Error(
        `outline entry ${index} targets page ${entry.pageIndex}, document has ${pageRefs.length}`,
      );
    }
    const node: OutlineNode = {
      title: entry.title,
      pageRef,
      children: [],
    };
    if (entry.level === 0) {
      roots.push(node);
    } else {
      const parent = stack[entry.level - 1];
      if (parent === undefined) {
        throw new Error(`outline entry ${index} has no parent`);
      }
      parent.children.push(node);
    }
    stack[entry.level] = node;
    stack.length = entry.level + 1;
  });

  return roots;
}

function buildBranch(
  parentRef: QpdfObjectRef,
  nodes: OutlineNode[],
  nextObjectNumber: number,
): BranchResult {
  const entries: Record<string, QpdfJsonObjectEntry> = {};
  const items: Array<{ ref: QpdfObjectRef; value: QpdfObjectValue }> = [];
  let currentObjectNumber = nextObjectNumber;

  for (const node of nodes) {
    const ref = makeObjectRef(currentObjectNumber++);
    const value: QpdfObjectValue = {
      "/Title": `u:${node.title}`,
      "/Parent": parentRef,
      "/Dest": [node.pageRef, "/Fit"],
    };
    if (node.children.length > 0) {
      const childBranch = buildBranch(ref, node.children, currentObjectNumber);
      currentObjectNumber = childBranch.nextObjectNumber;
      Object.assign(entries, childBranch.entries);
      value["/First"] = childBranch.firstRef;
      value["/Last"] = childBranch.lastRef;
      value["/Count"] = -childBranch.directCount;
    }
    entries[`obj:${ref}`] = { value };
    items.push({ ref, value });
  }

  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("outline branch must not be empty");
  }
  items.forEach((item, index) => {
    const previous = items[index - 1];
    const next = items[index + 1];
    if (previous !== undefined) item.value["/Prev"] = previous.ref;
    if (next !== undefined) item.value["/Next"] = next.ref;
  });

  return {
    entries,
    firstRef: first.ref,
    lastRef: last.ref,
    directCount: items.length,
    nextObjectNumber: currentObjectNumber,
  };
}

function readObjectRef(value: unknown, label: string): QpdfObjectRef {
  if (typeof value !== "string" || !/^\d+ 0 R$/.test(value)) {
    throw new Error(
      `expected ${label} to be an object ref, got ${String(value)}`,
    );
  }
  return value as QpdfObjectRef;
}

function readValueEntry(
  objects: QpdfJsonObjectMap,
  ref: QpdfObjectRef,
  label: string,
): QpdfObjectValue {
  const entry = objects[`obj:${ref}`];
  if (entry === undefined || !("value" in entry) || entry.value === undefined) {
    throw new Error(`expected ${label} value at ${ref}`);
  }
  return entry.value;
}

function makeObjectRef(objectNumber: number): QpdfObjectRef {
  return `${objectNumber} 0 R`;
}
