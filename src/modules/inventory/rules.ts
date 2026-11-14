import Decimal from "decimal.js";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";

// Pure rules for stock. No I/O.
//
// A warehouse holds a quantity of an item and that quantity has a value: what the goods cost.
// Goods coming in add their quantity and their value. Goods leaving take their share of the
// value with them, at the weighted-average cost: the value on hand times the quantity leaving,
// over the quantity on hand, rounded to the paisa. The last of the stock takes the last of the
// value, so rounding never leaves a value behind with nothing in stock.
//
// The database works a move out the same way (app.move_stock); these functions say what it
// will do, for the screens and for the tests. Quantities are in the item's own unit.

export type StockOnHand = { quantity: Decimal; value: Decimal };

const Wide = Decimal.clone({ precision: 60 });

/** What one of the item's own unit costs on average; nil when there is none in stock. */
export function averageCost(stock: StockOnHand): Decimal {
  return stock.quantity.isZero() ? new Decimal(0) : new Decimal(new Wide(stock.value).div(stock.quantity).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed());
}

/** Stock after goods come in with their value. */
export function receive(stock: StockOnHand, quantity: Decimal, value: Decimal): StockOnHand {
  return { quantity: stock.quantity.plus(quantity), value: stock.value.plus(value) };
}

/**
 * Takes a quantity out of stock: what it is worth at the weighted-average cost, and what is
 * left. Refused when there is not enough: stock never goes below zero.
 */
export function issue(stock: StockOnHand, quantity: Decimal): { ok: true; value: Decimal; left: StockOnHand } | { ok: false; short: Decimal } {
  if (!quantity.isFinite() || quantity.lte(0)) return { ok: false, short: new Decimal(0) };
  if (quantity.gt(stock.quantity)) return { ok: false, short: quantity.minus(stock.quantity) };
  // Rounded once, from the exact quotient, the way the database rounds it.
  // Never more than the stock is worth: a value below a paisa cannot round up past itself.
  const value = quantity.eq(stock.quantity) ? stock.value : Decimal.min(new Decimal(new Wide(stock.value).times(quantity).div(stock.quantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed()), stock.value);
  return { ok: true, value, left: { quantity: stock.quantity.minus(quantity), value: stock.value.minus(value) } };
}

/** How much of an order line is still to be delivered. */
export function remainingToDeliver(ordered: Decimal, delivered: Decimal): Decimal {
  return Decimal.max(ordered.minus(delivered), 0);
}

// ── Step 30: transfers, adjustments, opening stock and counts ───────────────────────────────────
// What a person types for each, read into something the commands can save. Items are named by
// their codes, as on the item list and in a spreadsheet; the commands find the items.

export const STOCK_DOCUMENT_STATUSES = ["draft", "submitted", "posted"] as const;
export type StockDocumentStatus = (typeof STOCK_DOCUMENT_STATUSES)[number];

/** Why stock is adjusted. The founder chose a fixed list on 2026-11-14, so adjustments can be totalled by reason. */
export const ADJUSTMENT_REASONS = ["damaged", "lost", "found", "sample", "own_use", "correction", "other"] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export const REASON_LABELS: Record<AdjustmentReason, string> = {
  damaged: "Damaged",
  lost: "Lost or stolen",
  found: "Found",
  sample: "Sample or gift",
  own_use: "Own use",
  correction: "Correction of a mistake",
  other: "Other",
};
export const isAdjustmentReason = (value: unknown): value is AdjustmentReason => typeof value === "string" && (ADJUSTMENT_REASONS as readonly string[]).includes(value);

export const ADJUSTMENT_KINDS = ["adjustment", "opening"] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];
export const isAdjustmentKind = (value: unknown): value is AdjustmentKind => value === "adjustment" || value === "opening";

/** A document typed by hand holds this many lines; opening stock from a file, this many rows. */
export const MAX_STOCK_LINES = 200;
export const MAX_OPENING_ROWS = 2000;
export const QUANTITY_SCALE = 4;

const typed = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const clean = cleanText;
const isDate = isIsoDate;

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * A quantity or a cost as a person types it: plain digits with an optional decimal point, at
 * most four digits after it. No signs, no commas, no exponents. `zero` says whether nothing is
 * an answer (a count of zero, goods that cost nothing).
 */
export function readNumber(input: unknown, what: string, zero: boolean): Read<Decimal> {
  const text = typed(input);
  if (text === "") return { ok: false, reason: `Enter ${what}.` };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: `Enter ${what} as a plain number without commas, such as 12 or 2.5.` };
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > QUANTITY_SCALE) return { ok: false, reason: `Use at most ${QUANTITY_SCALE} digits after the point.` };
  if (whole.replace(/^0+/, "").length > 11) return { ok: false, reason: "That number is too large." };
  const value = new Decimal(text);
  if (!zero && value.isZero()) return { ok: false, reason: `Enter ${what} above zero.` };
  return { ok: true, value };
}

function readNote(raw: unknown): Read<string | null> {
  const note = clean(raw);
  if (note.length > 500) return { ok: false, reason: "Use at most 500 characters for the note." };
  return { ok: true, value: note === "" ? null : note };
}

/** The first item code typed on two lines, or null. Codes are compared as the item list does: without regard to case. */
function repeatedCode(lines: readonly { itemCode: string }[]): string | null {
  const seen = new Set<string>();
  for (const line of lines) {
    const key = line.itemCode.toLowerCase();
    if (seen.has(key)) return line.itemCode;
    seen.add(key);
  }
  return null;
}

export type TransferLine = { itemCode: string; quantity: Decimal };
export type TransferDraft = { date: string; fromWarehouseId: string; toWarehouseId: string; note: string | null; lines: TransferLine[] };
export type RawTransfer = { date?: unknown; fromWarehouseId?: unknown; toWarehouseId?: unknown; note?: unknown; lines?: readonly { itemCode?: unknown; quantity?: unknown }[] };

/** Cleans what was typed for a stock transfer, or gives the first thing that is wrong in plain words. */
export function readTransfer(raw: RawTransfer): { ok: true; draft: TransferDraft } | { ok: false; reason: string } {
  if (!isDate(raw.date)) return { ok: false, reason: "Enter the date of the transfer." };
  const fromWarehouseId = typed(raw.fromWarehouseId);
  const toWarehouseId = typed(raw.toWarehouseId);
  if (fromWarehouseId === "") return { ok: false, reason: "Choose the warehouse the goods leave." };
  if (toWarehouseId === "") return { ok: false, reason: "Choose the warehouse the goods go to." };
  if (fromWarehouseId === toWarehouseId) return { ok: false, reason: "A transfer goes from one warehouse to another. Choose two different warehouses." };
  const note = readNote(raw.note);
  if (!note.ok) return note;
  const lines: TransferLine[] = [];
  for (const row of raw.lines ?? []) {
    const itemCode = clean(row.itemCode);
    if (itemCode === "" && typed(row.quantity) === "") continue;
    const at = `Line ${lines.length + 1}`;
    if (itemCode === "") return { ok: false, reason: `${at}: enter the item's code.` };
    const quantity = readNumber(row.quantity, "the quantity", false);
    if (!quantity.ok) return { ok: false, reason: `${at}: ${quantity.reason}` };
    lines.push({ itemCode, quantity: quantity.value });
  }
  if (lines.length > MAX_STOCK_LINES) return { ok: false, reason: `A transfer can have at most ${MAX_STOCK_LINES} lines.` };
  const twice = repeatedCode(lines);
  if (twice) return { ok: false, reason: `${twice} is on the transfer twice. Put each item on one line.` };
  return { ok: true, draft: { date: raw.date, fromWarehouseId, toWarehouseId, note: note.value, lines } };
}

/** Above zero for goods added, below zero for goods taken out. A cost only on goods added. */
export type AdjustmentLine = { itemCode: string; quantity: Decimal; unitCost: Decimal | null };
export type AdjustmentDraft = { kind: AdjustmentKind; date: string; warehouseId: string; reason: AdjustmentReason | null; note: string | null; lines: AdjustmentLine[] };
export type RawAdjustment = {
  date?: unknown;
  warehouseId?: unknown;
  reason?: unknown;
  note?: unknown;
  /** `direction` is "out" for goods taken out; anything else adds. */
  lines?: readonly { itemCode?: unknown; direction?: unknown; quantity?: unknown; unitCost?: unknown }[];
};

/**
 * Cleans what was typed for a stock adjustment or for opening stock. An adjustment says why;
 * "Other" needs a note. Goods added may state what one cost (opening stock must); goods taken
 * out never do: they leave at the average cost.
 */
export function readAdjustment(kind: AdjustmentKind, raw: RawAdjustment): { ok: true; draft: AdjustmentDraft } | { ok: false; reason: string } {
  const opening = kind === "opening";
  if (!isDate(raw.date)) return { ok: false, reason: opening ? "Enter the date the stock was counted for opening." : "Enter the date of the adjustment." };
  const warehouseId = typed(raw.warehouseId);
  if (warehouseId === "") return { ok: false, reason: "Choose the warehouse." };
  const note = readNote(raw.note);
  if (!note.ok) return note;
  let reason: AdjustmentReason | null = null;
  if (!opening) {
    if (!isAdjustmentReason(raw.reason)) return { ok: false, reason: "Choose the reason for the adjustment." };
    reason = raw.reason;
    if (reason === "other" && note.value === null) return { ok: false, reason: 'Say in the note what the reason is, when it is "Other".' };
  }
  const lines: AdjustmentLine[] = [];
  for (const row of raw.lines ?? []) {
    const itemCode = clean(row.itemCode);
    if (itemCode === "" && typed(row.quantity) === "" && typed(row.unitCost) === "") continue;
    const at = `Line ${lines.length + 1}`;
    if (itemCode === "") return { ok: false, reason: `${at}: enter the item's code.` };
    const quantity = readNumber(row.quantity, "the quantity", false);
    if (!quantity.ok) return { ok: false, reason: `${at}: ${quantity.reason}` };
    const out = typed(row.direction) === "out";
    let unitCost: Decimal | null = null;
    if (typed(row.unitCost) !== "") {
      if (out) return { ok: false, reason: `${at}: goods taken out leave at their average cost. Leave the cost empty.` };
      const cost = readNumber(row.unitCost, "what one costs", true);
      if (!cost.ok) return { ok: false, reason: `${at}: ${cost.reason}` };
      unitCost = cost.value;
    } else if (opening && !out) {
      return { ok: false, reason: `${at}: enter what one ${itemCode} cost. Opening stock comes in at its cost.` };
    }
    lines.push({ itemCode, quantity: out ? quantity.value.negated() : quantity.value, unitCost });
  }
  if (lines.length > MAX_STOCK_LINES) return { ok: false, reason: `Enter at most ${MAX_STOCK_LINES} lines by hand. For more, import a file.` };
  const twice = repeatedCode(lines);
  if (twice) return { ok: false, reason: `${twice} is entered twice. Put each item on one line.` };
  return { ok: true, draft: { kind, date: raw.date, warehouseId, reason, note: note.value, lines } };
}

/** The columns of an opening stock file, by the headings a spreadsheet would use. */
export const OPENING_COLUMNS = [
  { key: "code", header: "Item code" },
  { key: "quantity", header: "Quantity" },
  { key: "cost", header: "Unit cost" },
] as const;
export type OpeningColumn = (typeof OPENING_COLUMNS)[number]["key"];
export type OpeningProblem = { row: number; name: string; problems: string[] };

/**
 * Reads the rows of an opening stock file: an item's code, how many the warehouse holds in the
 * item's own unit, and what one cost. Every row that is wrong is listed, so the file is put
 * right in one go; nothing is kept unless every row is right.
 */
export function readOpeningRows(rows: readonly { row: number; raw: Partial<Record<OpeningColumn, string>>; extra: boolean }[]): { ok: true; lines: AdjustmentLine[] } | { ok: false; problems: OpeningProblem[] } {
  const lines: AdjustmentLine[] = [];
  const problems: OpeningProblem[] = [];
  const seen = new Map<string, number>();
  for (const { row, raw, extra } of rows) {
    const found: string[] = [];
    const itemCode = clean(raw.code);
    if (itemCode === "") found.push("The item's code is missing.");
    const quantity = readNumber(raw.quantity, "the quantity", false);
    if (!quantity.ok) found.push(`Quantity: ${quantity.reason}`);
    const cost = readNumber(raw.cost, "what one cost", true);
    if (!cost.ok) found.push(`Unit cost: ${cost.reason}`);
    if (extra) found.push("The row has more cells than the file has columns.");
    const first = seen.get(itemCode.toLowerCase());
    if (itemCode !== "" && first !== undefined) found.push(`The same item is on row ${first}. Put each item on one row.`);
    if (itemCode !== "" && first === undefined) seen.set(itemCode.toLowerCase(), row);
    if (found.length > 0 || !quantity.ok || !cost.ok) problems.push({ row, name: itemCode, problems: found });
    else lines.push({ itemCode, quantity: quantity.value, unitCost: cost.value });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, lines };
}

export type CountDraft = { date: string; warehouseId: string; note: string | null };

/** Cleans what was typed to start a stock count. */
export function readCountStart(raw: { date?: unknown; warehouseId?: unknown; note?: unknown }): { ok: true; draft: CountDraft } | { ok: false; reason: string } {
  if (!isDate(raw.date)) return { ok: false, reason: "Enter the date of the count." };
  const warehouseId = typed(raw.warehouseId);
  if (warehouseId === "") return { ok: false, reason: "Choose the warehouse to count." };
  const note = readNote(raw.note);
  if (!note.ok) return note;
  return { ok: true, draft: { date: raw.date, warehouseId, note: note.value } };
}

/**
 * What was typed on a count sheet, line by line: a number, or nothing for a line not counted
 * (yet). A count of zero is an answer: the shelf was empty.
 */
export function readCounted(rows: readonly { lineId?: unknown; counted?: unknown; label?: string }[]): { ok: true; counted: { lineId: string; counted: Decimal | null }[] } | { ok: false; reason: string } {
  const counted: { lineId: string; counted: Decimal | null }[] = [];
  for (const row of rows) {
    const lineId = typed(row.lineId);
    if (lineId === "") continue;
    if (typed(row.counted) === "") {
      counted.push({ lineId, counted: null });
      continue;
    }
    const read = readNumber(row.counted, "what was counted", true);
    if (!read.ok) return { ok: false, reason: `${row.label ?? "A line"}: ${read.reason}` };
    counted.push({ lineId, counted: read.value });
  }
  return { ok: true, counted };
}

/** Counted less what the books held: above zero is a surplus, below zero a shortage. Null for a line not counted. */
export function countDifference(book: Decimal, counted: Decimal | null): Decimal | null {
  return counted === null ? null : counted.minus(book);
}

/** A quantity for showing: no trailing zeros, "12" or "2.5". */
export function formatQuantity(quantity: Decimal): string {
  return quantity.toFixed(QUANTITY_SCALE).replace(/\.?0+$/, "");
}
