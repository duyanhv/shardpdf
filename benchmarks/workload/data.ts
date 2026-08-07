/**
 * Deterministic workload data. Same scale ⇒ byte-identical input for every runner,
 * so memory/time comparisons are apples to apples. No Date.now, no Math.random.
 */

export interface LineItem {
  sku: string;
  description: string;
  qty: number;
  unitPriceCents: number;
}

export interface Invoice {
  id: string;
  date: string; // ISO yyyy-mm-dd
  items: LineItem[];
  totalCents: number;
}

export interface Customer {
  id: string;
  name: string;
  invoices: Invoice[];
}

export interface Workload {
  scale: ScaleName;
  customers: Customer[];
  totalInvoices: number;
}

export const SCALES = {
  smoke: { invoices: 300, customers: 12 },
  mid: { invoices: 5_000, customers: 100 },
  full: { invoices: 50_000, customers: 500 },
} as const;

export type ScaleName = keyof typeof SCALES;

const FIRST = [
  "Acme",
  "Globex",
  "Initech",
  "Umbrella",
  "Stark",
  "Wayne",
  "Hooli",
  "Vandelay",
];
const SECOND = [
  "Logistics",
  "Dynamics",
  "Industries",
  "Holdings",
  "Freight",
  "Systems",
  "Labs",
  "Trading",
];
const NOUNS = [
  "widget",
  "flange",
  "gasket",
  "coupling",
  "bearing",
  "valve",
  "sprocket",
  "manifold",
];
const ADJS = [
  "reinforced",
  "anodized",
  "industrial",
  "precision",
  "heavy-duty",
  "compact",
  "sealed",
  "modular",
];

/** mulberry32 — tiny seedable PRNG, deterministic across platforms. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  const item = arr[Math.floor(rand() * arr.length)];
  if (item === undefined) throw new Error("unreachable: pick from empty array");
  return item;
}

function int(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/** Deterministic date in 2025, derived from invoice ordinal. */
function invoiceDate(ordinal: number, total: number): string {
  const dayOfYear = 1 + Math.floor((ordinal / total) * 364);
  const date = new Date(Date.UTC(2025, 0, dayOfYear));
  return date.toISOString().slice(0, 10);
}

export function generateWorkload(scale: ScaleName): Workload {
  const { invoices: totalInvoices, customers: customerCount } = SCALES[scale];
  const rand = mulberry32(0x5eed_ba5e);

  const customers: Customer[] = [];
  for (let c = 0; c < customerCount; c++) {
    customers.push({
      id: `CUST-${String(c + 1).padStart(4, "0")}`,
      name: `${pick(rand, FIRST)} ${pick(rand, SECOND)} #${c + 1}`,
      invoices: [],
    });
  }

  for (let i = 0; i < totalInvoices; i++) {
    const customer = customers[i % customerCount];
    if (customer === undefined)
      throw new Error("unreachable: customer index out of range");
    const itemCount = int(rand, 5, 15);
    const items: LineItem[] = [];
    let totalCents = 0;
    for (let j = 0; j < itemCount; j++) {
      const item: LineItem = {
        sku: `SKU-${int(rand, 10_000, 99_999)}`,
        description: `${pick(rand, ADJS)} ${pick(rand, NOUNS)}`,
        qty: int(rand, 1, 40),
        unitPriceCents: int(rand, 99, 250_000),
      };
      totalCents += item.qty * item.unitPriceCents;
      items.push(item);
    }
    customer.invoices.push({
      id: `INV-${String(i + 1).padStart(6, "0")}`,
      date: invoiceDate(i, totalInvoices),
      items,
      totalCents,
    });
  }

  return { scale, customers, totalInvoices };
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
