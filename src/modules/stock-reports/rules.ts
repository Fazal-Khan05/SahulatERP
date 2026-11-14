import Decimal from "decimal.js";
import { formatIsoDate, isIsoDate } from "@/modules/currencies/rules";
import type { Cell, ReportRow, ReportTable } from "@/modules/reports/rules";
import type { Permission } from "@/modules/tenant/rules";

// Pure rules for the stock reports (Step 31). No I/O.
//
// Every figure is read from what the postings stored: stock moves (each with the value it moved
// at, weighted-average cost), stock balances and posted sales invoice lines. Nothing here prices
// goods again; the reports only add up, sort and age.

export const STOCK_REPORTS = {
  valuation: {
    title: "Stock valuation",
    about: "What each warehouse holds on a day and what it is worth at weighted-average cost, against the stock account in the books.",
    permission: "stock.cost.read",
    period: false,
  },
  movement: {
    title: "Stock movement",
    about: "What came in and went out of each item in a period, with what it held before and after. Choose an item for each of its movements.",
    permission: "stock.cost.read",
    period: true,
  },
  ageing: {
    title: "Stock ageing",
    about: "How long the stock on hand has been held, taking the newest goods received as the ones still on the shelf, and how long since each item last sold.",
    permission: "stock.cost.read",
    period: false,
  },
  "low-stock": {
    title: "Low stock",
    about: "Items whose free stock (on hand, less what open sales orders still have to deliver) is at or below their reorder level.",
    permission: "stock.read",
    period: false,
  },
  "item-profit": {
    title: "Item profit",
    about: "What each item sold for on posted invoices in a period, what those goods cost, and the margin.",
    permission: "stock.cost.read",
    period: true,
  },
} as const satisfies Record<string, { title: string; about: string; permission: Permission; period: boolean }>;

export type StockReportKey = keyof typeof STOCK_REPORTS;
export const isStockReportKey = (value: unknown): value is StockReportKey => typeof value === "string" && Object.hasOwn(STOCK_REPORTS, value);

/** What a stock report was asked for. `from` is used by the reports over a period; the others are as at `to`. */
export type StockFilter = { from: string; to: string; branchId: string | null; warehouseId: string | null; itemId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (value: unknown) => (Array.isArray(value) ? value[0] : value);
const id = (value: unknown) => {
  const v = one(value);
  return typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null;
};

/** The filter from the address. With no dates: the fiscal year so far, as at today. A period the wrong way round is turned round. */
export function readStockFilter(raw: Record<string, unknown>, defaults: { yearStart: string; today: string }): StockFilter {
  const to = isIsoDate(one(raw.to)) ? (one(raw.to) as string) : defaults.today;
  let from = isIsoDate(one(raw.from)) ? (one(raw.from) as string) : defaults.yearStart;
  if (from > to) from = to;
  return { from, to, branchId: id(raw.branch), warehouseId: id(raw.warehouse), itemId: id(raw.item) };
}

export function stockFilterQuery(filter: StockFilter, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ from: filter.from, to: filter.to });
  if (filter.branchId) query.set("branch", filter.branchId);
  if (filter.warehouseId) query.set("warehouse", filter.warehouseId);
  if (filter.itemId) query.set("item", filter.itemId);
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return query.toString();
}

const ZERO = new Decimal(0);
const sum = (values: readonly Decimal[]) => values.reduce((total, value) => total.plus(value), ZERO);
/** A quantity as people write it: no trailing zeros. */
export const plainQuantity = (quantity: Decimal): string => quantity.toFixed(4).replace(/\.?0+$/, "");
const qty = (quantity: Decimal, unit?: string): Cell => (quantity.isZero() ? null : unit ? `${plainQuantity(quantity)} ${unit}` : plainQuantity(quantity));
const money = (amount: Decimal): Cell => (amount.isZero() ? null : amount);

/** Whole days from one ISO date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000);
}

// ── Stock ageing ────────────────────────────────────────────────────────────────────────────────

/** The age bands of the stock ageing report, in days; the last has no end. */
export const AGE_BANDS = [
  { label: "0-30 days", upTo: 30 },
  { label: "31-60 days", upTo: 60 },
  { label: "61-90 days", upTo: 90 },
  { label: "91-180 days", upTo: 180 },
  { label: "Over 180 days", upTo: null },
] as const;

const bandOf = (days: number) => AGE_BANDS.findIndex((band) => band.upTo === null || days <= band.upTo);

/**
 * Splits what is on hand into age bands. The newest goods received are taken to be the ones still
 * on the shelf: `incoming` (every quantity that came in, on or before `asAt`, newest first) is
 * walked until the quantity on hand is used up. Whatever the incoming moves do not account for is
 * put in the oldest band.
 */
export function ageStock(onHand: Decimal, incoming: readonly { date: string; quantity: Decimal }[], asAt: string): Decimal[] {
  const bands = AGE_BANDS.map(() => ZERO);
  let left = onHand;
  for (const move of incoming) {
    if (!left.gt(0)) break;
    const take = Decimal.min(left, move.quantity);
    if (!take.gt(0)) continue;
    const band = bandOf(Math.max(0, daysBetween(move.date, asAt)));
    bands[band] = bands[band].plus(take);
    left = left.minus(take);
  }
  if (left.gt(0)) bands[bands.length - 1] = bands[bands.length - 1].plus(left);
  return bands;
}

// ── Tables ──────────────────────────────────────────────────────────────────────────────────────

const asAt = (date: string) => `As at the end of ${formatIsoDate(date)}`;
const period = (filter: StockFilter) => `${formatIsoDate(filter.from)} to ${formatIsoDate(filter.to)}`;

export type HeldRow = { code: string; name: string; unit: string; warehouse: string; quantity: Decimal; value: Decimal };

/**
 * Stock valuation. `books` is what the stock account stands at in the books on the same day, for
 * the same branch; it is left out when the report is for one warehouse, which the books do not
 * keep apart.
 */
export function valuationTable(rows: readonly HeldRow[], filter: StockFilter, books: Decimal | null): ReportTable {
  const total = sum(rows.map((row) => row.value));
  const lines: ReportRow[] = rows.map((row) => ({
    kind: "line",
    depth: 0,
    cells: [row.code, row.name, row.warehouse, qty(row.quantity, row.unit), row.quantity.isZero() ? null : row.value.div(row.quantity).toDecimalPlaces(4, Decimal.ROUND_HALF_UP), row.value],
  }));
  const notes: string[] = [];
  const tail: ReportRow[] = [{ kind: "grand", depth: 0, cells: ["", "Total", "", "", "", total] }];
  if (books !== null) {
    tail.push({ kind: "total", depth: 0, cells: ["", "Stock account in the books", "", "", "", books] });
    const difference = total.minus(books);
    tail.push({ kind: "total", depth: 0, cells: ["", "Difference", "", "", "", difference] });
    if (!difference.isZero()) notes.push("The stock held and the stock account in the books do not agree. An entry made to the stock account by hand, or stock brought in outside the app's documents, would do this; please report it.");
  } else {
    notes.push("Shown for one warehouse: the books keep stock by branch, not by warehouse, so there is nothing to compare it with.");
  }
  return {
    title: STOCK_REPORTS.valuation.title,
    period: asAt(filter.to),
    columns: [
      { label: "Item", numeric: false },
      { label: "Name", numeric: false },
      { label: "Warehouse", numeric: false },
      { label: "Quantity", numeric: true },
      { label: "Average cost", numeric: true },
      { label: "Value", numeric: true },
    ],
    rows: [...lines, ...tail],
    notes,
  };
}

export type MovementRow = { code: string; name: string; unit: string; warehouse: string; openingQuantity: Decimal; openingValue: Decimal; inQuantity: Decimal; inValue: Decimal; outQuantity: Decimal; outValue: Decimal };

/** Stock movement for a period, item by item and warehouse by warehouse. `outQuantity` and `outValue` are positive. */
export function movementTable(rows: readonly MovementRow[], filter: StockFilter): ReportTable {
  const lines: ReportRow[] = rows.map((row) => {
    const closingQuantity = row.openingQuantity.plus(row.inQuantity).minus(row.outQuantity);
    const closingValue = row.openingValue.plus(row.inValue).minus(row.outValue);
    return {
      kind: "line",
      depth: 0,
      cells: [row.code, row.name, row.warehouse, qty(row.openingQuantity, row.unit), money(row.openingValue), qty(row.inQuantity), money(row.inValue), qty(row.outQuantity), money(row.outValue), qty(closingQuantity, row.unit), money(closingValue)],
    };
  });
  const totals = (pick: (row: MovementRow) => Decimal) => sum(rows.map(pick));
  const opening = totals((r) => r.openingValue);
  const inValue = totals((r) => r.inValue);
  const outValue = totals((r) => r.outValue);
  return {
    title: STOCK_REPORTS.movement.title,
    period: period(filter),
    columns: [
      { label: "Item", numeric: false },
      { label: "Name", numeric: false },
      { label: "Warehouse", numeric: false },
      { label: "Opening", numeric: true },
      { label: "Opening value", numeric: true },
      { label: "In", numeric: true },
      { label: "In value", numeric: true },
      { label: "Out", numeric: true },
      { label: "Out value", numeric: true },
      { label: "Closing", numeric: true },
      { label: "Closing value", numeric: true },
    ],
    rows: [...lines, { kind: "grand", depth: 0, cells: ["", "Total", "", "", opening, "", inValue, "", outValue, "", opening.plus(inValue).minus(outValue)] }],
    notes: rows.length === 0 ? ["Nothing was held or moved in this period."] : [],
  };
}

export type MoveLine = { date: string; document: string; warehouse: string; quantity: Decimal; value: Decimal };

/** Every movement of one item in a period, with the running quantity and value. */
export function itemMovesTable(item: { code: string; name: string; unit: string }, opening: { quantity: Decimal; value: Decimal }, moves: readonly MoveLine[], filter: StockFilter): ReportTable {
  let quantity = opening.quantity;
  let value = opening.value;
  const lines: ReportRow[] = moves.map((move) => {
    quantity = quantity.plus(move.quantity);
    value = value.plus(move.value);
    const coming = move.quantity.gt(0);
    return { kind: "line", depth: 0, cells: [formatIsoDate(move.date), move.document, move.warehouse, coming ? plainQuantity(move.quantity) : null, coming ? null : plainQuantity(move.quantity.abs()), move.value, plainQuantity(quantity), value] };
  });
  return {
    title: `${STOCK_REPORTS.movement.title}: ${item.code} ${item.name}`,
    period: period(filter),
    columns: [
      { label: "Date", numeric: false },
      { label: "Document", numeric: false },
      { label: "Warehouse", numeric: false },
      { label: `In (${item.unit})`, numeric: true },
      { label: `Out (${item.unit})`, numeric: true },
      { label: "Value", numeric: true },
      { label: "Balance", numeric: true },
      { label: "Balance value", numeric: true },
    ],
    rows: [
      { kind: "heading", depth: 0, cells: ["", "Opening", "", null, null, null, plainQuantity(opening.quantity), opening.value] },
      ...lines,
      { kind: "grand", depth: 0, cells: ["", "Closing", "", null, null, null, plainQuantity(quantity), value] },
    ],
    notes: [],
  };
}

export type AgeingRow = { code: string; name: string; unit: string; warehouse: string; quantity: Decimal; value: Decimal; bands: Decimal[]; lastSold: string | null };

export function ageingTable(rows: readonly AgeingRow[], filter: StockFilter): ReportTable {
  const total = sum(rows.map((row) => row.value));
  return {
    title: STOCK_REPORTS.ageing.title,
    period: asAt(filter.to),
    columns: [
      { label: "Item", numeric: false },
      { label: "Name", numeric: false },
      { label: "Warehouse", numeric: false },
      { label: "On hand", numeric: true },
      ...AGE_BANDS.map((band) => ({ label: band.label, numeric: true })),
      { label: "Value", numeric: true },
      { label: "Last sold", numeric: false },
      { label: "Days since sold", numeric: true },
    ],
    rows: [
      ...rows.map((row): ReportRow => ({
        kind: "line",
        depth: 0,
        cells: [row.code, row.name, row.warehouse, qty(row.quantity, row.unit), ...row.bands.map((band) => qty(band)), row.value, row.lastSold ? formatIsoDate(row.lastSold) : "Never", row.lastSold ? String(daysBetween(row.lastSold, filter.to)) : null],
      })),
      { kind: "grand", depth: 0, cells: ["", "Total", "", "", ...AGE_BANDS.map(() => null), total, "", null] },
    ],
    notes: ["Goods moved between warehouses, or put back by a cancelled delivery note, are aged from the day they arrived in the warehouse."],
  };
}

export type LowStockRow = { code: string; name: string; unit: string; reorderLevel: Decimal; onHand: Decimal; onOrder: Decimal; byWarehouse: { warehouse: string; quantity: Decimal }[] };

/** Free stock at or below the reorder level, shortest first. */
export function lowStockTable(rows: readonly LowStockRow[], today: string): ReportTable {
  const low = rows
    .map((row) => ({ ...row, free: row.onHand.minus(row.onOrder) }))
    .filter((row) => row.free.lte(row.reorderLevel))
    .sort((a, b) => b.reorderLevel.minus(b.free).comparedTo(a.reorderLevel.minus(a.free)) || a.code.localeCompare(b.code));
  return {
    title: STOCK_REPORTS["low-stock"].title,
    period: `On ${formatIsoDate(today)}`,
    columns: [
      { label: "Item", numeric: false },
      { label: "Name", numeric: false },
      { label: "Reorder level", numeric: true },
      { label: "On hand", numeric: true },
      { label: "On open orders", numeric: true },
      { label: "Free", numeric: true },
      { label: "Short by", numeric: true },
      { label: "Where it is", numeric: false },
    ],
    rows: low.map((row) => ({
      kind: "line",
      depth: 0,
      cells: [
        row.code,
        row.name,
        `${plainQuantity(row.reorderLevel)} ${row.unit}`,
        plainQuantity(row.onHand),
        plainQuantity(row.onOrder),
        plainQuantity(row.free),
        plainQuantity(row.reorderLevel.minus(row.free)),
        row.byWarehouse
          .filter((place) => !place.quantity.isZero())
          .map((place) => `${place.warehouse} ${plainQuantity(place.quantity)}`)
          .join(", "),
      ],
    })),
    notes: low.length === 0 ? ["No item is at or below its reorder level. An item with no reorder level is never listed."] : ["An item with no reorder level is never listed. Orders waiting for the owner's approval are not counted as on order."],
  };
}

export type ProfitRow = { code: string; name: string; unit: string; quantity: Decimal; sales: Decimal; cost: Decimal };

/** Profit as a percentage of sales, to one decimal; null when nothing was sold for anything. */
export function marginPercent(sales: Decimal, cost: Decimal): Decimal | null {
  return sales.isZero() ? null : sales.minus(cost).div(sales).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
}

const percent = (value: Decimal | null): Cell => (value === null ? null : `${value.toFixed(1)}%`);

export function itemProfitTable(rows: readonly ProfitRow[], filter: StockFilter): ReportTable {
  const sales = sum(rows.map((row) => row.sales));
  const cost = sum(rows.map((row) => row.cost));
  return {
    title: STOCK_REPORTS["item-profit"].title,
    period: period(filter),
    columns: [
      { label: "Item", numeric: false },
      { label: "Name", numeric: false },
      { label: "Quantity sold", numeric: true },
      { label: "Sales", numeric: true },
      { label: "Cost of goods sold", numeric: true },
      { label: "Profit", numeric: true },
      { label: "Margin", numeric: true },
    ],
    rows: [
      ...rows.map((row): ReportRow => ({ kind: "line", depth: 0, cells: [row.code, row.name, `${plainQuantity(row.quantity)} ${row.unit}`, row.sales, row.cost, row.sales.minus(row.cost), percent(marginPercent(row.sales, row.cost))] })),
      { kind: "grand", depth: 0, cells: ["", "Total", "", sales, cost, sales.minus(cost), percent(marginPercent(sales, cost))] },
    ],
    notes: [
      "Sales are the invoices' values before sales tax. The cost is what those goods left stock at.",
      "An invoice made from a delivery note counts here in the invoice's period; the books put its cost in the delivery note's month.",
    ],
  };
}
