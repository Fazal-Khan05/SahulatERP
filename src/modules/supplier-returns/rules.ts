import Decimal from "decimal.js";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { parseQuantity } from "@/modules/items/rules";

// Pure rules for sending goods back to a supplier. No I/O.
//
// A return is typed against one posted goods received note: a date, a reason, and how much goes
// back of what. "What" is either goods of one of the note's lines that no bill has billed yet,
// or goods that one line of a posted bill billed. Everything is decimal.js.

export const RETURN_STATUSES = ["draft", "posted"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = { draft: "Draft", posted: "Posted" };

/** A return can have this many lines. */
export const MAX_RETURN_LINES = 200;

const NIL = new Decimal(0);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const isNil = (typed: string) => /^0+(\.0+)?$/.test(typed);
const dmy = (date: string) => date.split("-").reverse().join("-");

export type RawReturn = {
  date?: unknown;
  receiptId?: unknown;
  reason?: unknown;
  supplierReference?: unknown;
  lines?: readonly { receiptLineId?: unknown; billLineId?: unknown; quantity?: unknown }[];
};

export type ReturnDraft = {
  date: string;
  receiptId: string;
  reason: string;
  supplierReference: string | null;
  lines: { receiptLineId: string; billLineId: string | null; quantity: Decimal }[];
};

/** Cleans what was typed for a return, or gives the first thing that is wrong in plain words. A row left empty or at nil does not go back. */
export function readReturn(raw: RawReturn): { ok: true; draft: ReturnDraft } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the day the goods went back." };
  const receiptId = text(raw.receiptId);
  if (receiptId === "") return { ok: false, reason: "Choose the goods received note the goods came in on." };
  const reason = cleanText(raw.reason);
  if (reason.length < 3) return { ok: false, reason: "Say why the goods are going back, in a few words." };
  if (reason.length > 300) return { ok: false, reason: "The reason: use at most 300 characters." };
  const reference = cleanText(raw.supplierReference);
  if (reference.length > 60) return { ok: false, reason: "The supplier's credit note number: use at most 60 characters." };
  const lines: ReturnDraft["lines"] = [];
  for (const row of raw.lines ?? []) {
    const receiptLineId = text(row.receiptLineId);
    const billLineId = text(row.billLineId) || null;
    const typed = text(row.quantity);
    if (receiptLineId === "" || typed === "" || isNil(typed)) continue;
    const parsed = parseQuantity(typed);
    if (!parsed.ok) return { ok: false, reason: `Line ${lines.length + 1}, quantity: ${parsed.reason}` };
    if (lines.some((line) => line.receiptLineId === receiptLineId && line.billLineId === billLineId)) return { ok: false, reason: "The same goods are on the return twice." };
    lines.push({ receiptLineId, billLineId, quantity: parsed.value });
  }
  if (lines.length === 0) return { ok: false, reason: "Enter how much goes back of at least one line." };
  if (lines.length > MAX_RETURN_LINES) return { ok: false, reason: `A return can have at most ${MAX_RETURN_LINES} lines.` };
  return { ok: true, draft: { date: raw.date, receiptId, reason, supplierReference: reference === "" ? null : reference, lines } };
}

/**
 * Something that can go back from one goods received note: what is left of one of its lines
 * that no bill has billed (no bill line), or what is left of what one posted bill billed of it.
 */
export type Returnable = {
  receiptLineId: string;
  billLineId: string | null;
  lineNo: number;
  itemId: string;
  itemCode: string;
  description: string;
  unitCode: string;
  unitFactor: Decimal;
  /** How much can still go back, in the unit the goods were received in. */
  available: Decimal;
  /** What one unit is taken back at: what it came into stock at (not billed), or the bill's price. */
  unitValue: Decimal;
  /** Sales tax the bill charged on one unit; nil for goods not billed. */
  unitTax: Decimal;
  billNumber: string | null;
  billDate: string | null;
  /** How much of the item the warehouse holds now, in the item's own unit. */
  inStock: Decimal;
};

export type ReturnLine = { receiptLineId: string; billLineId: string | null; itemId: string; itemCode: string; unitFactor: Decimal; quantity: Decimal; baseQuantity: Decimal; lineNo: number };

/**
 * The lines of a return worked out against what can go back: each for no more than is left,
 * billed goods on or after their bill's day, in a quantity the item's own unit can hold, and
 * in all no more of an item than the warehouse holds.
 */
export function returnLines(canGoBack: readonly Returnable[], wanted: ReturnDraft["lines"], date: string): { ok: true; lines: ReturnLine[] } | { ok: false; reason: string } {
  const lines: ReturnLine[] = [];
  const leaving = new Map<string, Decimal>();
  for (const want of wanted) {
    const from = canGoBack.find((row) => row.receiptLineId === want.receiptLineId && row.billLineId === want.billLineId);
    if (!from) return { ok: false, reason: "Some goods on the return are no longer there to send back: they were billed or sent back since. Reload the page." };
    const what = from.billNumber ? `${from.itemCode} billed on ${from.billNumber}` : `${from.itemCode} not yet billed`;
    if (want.quantity.gt(from.available)) return { ok: false, reason: `${what}: only ${from.available.toFixed()} can go back, not ${want.quantity.toFixed()}.` };
    if (from.billDate && from.billDate > date) return { ok: false, reason: `${what}: the bill is dated ${dmy(from.billDate)}. Billed goods go back on or after the day of their bill.` };
    const baseQuantity = want.quantity.times(from.unitFactor);
    if (baseQuantity.decimalPlaces() > 4) return { ok: false, reason: `${from.itemCode}: use a quantity the item's own unit can hold, with fewer decimals.` };
    const total = (leaving.get(from.itemId) ?? NIL).plus(baseQuantity);
    if (total.gt(from.inStock)) return { ok: false, reason: `${from.itemCode}: the warehouse holds ${from.inStock.toFixed()}, so ${total.toFixed()} cannot go back. Goods that were sold or moved cannot be sent back from here.` };
    leaving.set(from.itemId, total);
    lines.push({ receiptLineId: from.receiptLineId, billLineId: from.billLineId, itemId: from.itemId, itemCode: from.itemCode, unitFactor: from.unitFactor, quantity: want.quantity, baseQuantity, lineNo: 0 });
  }
  return { ok: true, lines: lines.map((line, index) => ({ ...line, lineNo: index + 1 })) };
}

const paisa = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * What a draft would take back, for showing before it is posted: what comes off goods received
 * and not billed, and what the supplier would owe back for billed goods with the sales tax on
 * them. The database works the exact figures out when the return is posted.
 */
export function returnEstimate(canGoBack: readonly Returnable[], lines: readonly { receiptLineId: string; billLineId: string | null; quantity: Decimal }[]): { notBilled: Decimal; credit: Decimal } {
  let notBilled = NIL;
  let credit = NIL;
  for (const line of lines) {
    const from = canGoBack.find((row) => row.receiptLineId === line.receiptLineId && row.billLineId === line.billLineId);
    if (!from) continue;
    if (from.billLineId === null) notBilled = notBilled.plus(paisa(line.quantity.times(from.unitValue)));
    else credit = credit.plus(paisa(line.quantity.times(from.unitValue))).plus(paisa(line.quantity.times(from.unitTax)));
  }
  return { notBilled, credit };
}
