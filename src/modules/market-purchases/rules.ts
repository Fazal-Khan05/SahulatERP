import Decimal from "decimal.js";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { readOrder, type OrderDraftLine, type RawOrder } from "@/modules/purchasing/rules";

// A quick market purchase: what is typed for it, cleaned, or the first thing that is wrong in
// plain words. No I/O. The goods are read as a purchase order's lines are; the seller and the
// payment are the purchase's own.

/** Said on the screen and in the notes: what a quick market purchase does not do. */
export const NO_TAX_ON_MARKET_PURCHASE =
  "No sales tax is claimed and no tax is withheld on a quick market purchase. If the seller gave a sales tax invoice you want to claim, or tax must be withheld from them, use a purchase order and a supplier bill instead.";

export type RawMarketPurchase = {
  date?: unknown;
  warehouseId?: unknown;
  /** "supplier": one on the list. "market": a seller who is not, named here. */
  sellerKind?: unknown;
  supplierId?: unknown;
  sellerName?: unknown;
  sellerPhone?: unknown;
  memoNo?: unknown;
  note?: unknown;
  lines?: RawOrder["lines"];
  /** cash, or bank: a transfer or a card, out of one of the company's bank accounts. */
  method?: unknown;
  accountId?: unknown;
  reference?: unknown;
};

export type MarketPurchase = {
  date: string;
  warehouseId: string;
  seller: { kind: "supplier"; supplierId: string } | { kind: "market"; name: string; phone: string | null };
  memoNo: string | null;
  note: string | null;
  lines: OrderDraftLine[];
  payment: { method: "cash" | "bank"; accountId: string; reference: string | null };
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** A phone number as the database keeps it: digits, spaces and dashes, perhaps with + in front. */
export const PHONE_PATTERN = /^\+?[0-9][0-9 -]{5,18}[0-9]$/;

export function readMarketPurchase(raw: RawMarketPurchase, today: string): { ok: true; purchase: MarketPurchase } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the day the goods were bought." };
  if (raw.date > today) return { ok: false, reason: "A purchase is recorded on the day the goods were bought or later, never before it." };
  if (raw.sellerKind !== "supplier" && raw.sellerKind !== "market") return { ok: false, reason: "Say who the goods were bought from: a supplier on your list, or a seller in the market." };
  let seller: MarketPurchase["seller"];
  if (raw.sellerKind === "supplier") {
    const supplierId = text(raw.supplierId);
    if (supplierId === "") return { ok: false, reason: "Choose the supplier." };
    seller = { kind: "supplier", supplierId };
  } else {
    const name = cleanText(raw.sellerName);
    // Counted as the database counts: in characters, not in the code units JavaScript keeps.
    if ([...name].length < 2) return { ok: false, reason: "Enter the seller's name, or the shop's." };
    if ([...name].length > 120) return { ok: false, reason: "The seller's name: use at most 120 characters." };
    const phone = cleanText(raw.sellerPhone);
    if (phone !== "" && !PHONE_PATTERN.test(phone)) return { ok: false, reason: "Enter the seller's phone as digits, such as 0300 1234567, or leave it empty." };
    seller = { kind: "market", name, phone: phone === "" ? null : phone };
  }
  const memoNo = cleanText(raw.memoNo);
  if ([...memoNo].length > 40) return { ok: false, reason: "The cash memo number: use at most 40 characters." };
  const note = cleanText(raw.note);
  if (note.length > 300) return { ok: false, reason: "Note: use at most 300 characters." };
  // The lines are an order's; the supplier is filled in when the purchase is made, so any text passes the reader's own check here.
  const read = readOrder({ date: raw.date, supplierId: "seller", warehouseId: raw.warehouseId, expectedOn: "", supplierReference: "", note: "", lines: raw.lines });
  if (!read.ok) return { ok: false, reason: read.reason.replace("the warehouse the goods are to arrive at", "the warehouse the goods came into") };
  const lines = read.order.lines;
  if (lines.length === 0) return { ok: false, reason: "Enter at least one line: what was bought, how many, and what one cost." };
  // A free sample is an order's business; goods bought in the market cost something, and a line at nothing would be paid nothing.
  const free = lines.findIndex((line) => line.unitCost.lte(0));
  if (free >= 0) return { ok: false, reason: `Line ${free + 1}, cost: enter what one cost, more than zero.` };
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const key = `${line.itemId}|${line.unitId ?? ""}`;
    if (seen.has(key)) return { ok: false, reason: `Line ${index + 1}: this item is on the purchase twice in the same unit. Put it on one line.` };
    seen.add(key);
  }
  if (raw.method !== "cash" && raw.method !== "bank") return { ok: false, reason: "Choose how it was paid: in cash, or from a bank account." };
  const accountId = text(raw.accountId);
  if (accountId === "") return { ok: false, reason: raw.method === "cash" ? "Choose the cash account the money came out of." : "Choose the bank account the money came out of." };
  const reference = cleanText(raw.reference);
  if (reference.length > 60) return { ok: false, reason: "Use at most 60 characters for the payment's reference." };
  return {
    ok: true,
    purchase: {
      date: raw.date,
      warehouseId: read.order.warehouseId,
      seller,
      memoNo: memoNo === "" ? null : memoNo,
      note: note === "" ? null : note,
      lines,
      payment: { method: raw.method, accountId, reference: reference === "" ? null : reference },
    },
  };
}

/** What goes in the note of each document the purchase makes, so each says where it came from and who sold. */
export function documentNote(purchase: Pick<MarketPurchase, "seller" | "memoNo" | "note">): string {
  const parts = ["Quick market purchase"];
  if (purchase.seller.kind === "market") parts.push(`from ${purchase.seller.name}${purchase.seller.phone ? ` (${purchase.seller.phone})` : ""}`);
  let said = parts.join(" ");
  if (purchase.memoNo) said += `, cash memo ${purchase.memoNo}`;
  said += ".";
  return purchase.note ? `${said} ${purchase.note}` : said;
}

/** How much of an item is missing, in the item's own unit, for a delivery or a sale that needs more than is on hand. */
export type Shortage = { itemId: string; itemCode: string; description: string; /** The item's own unit, when a line names it; null when every line is in a larger unit. */ unitCode: string | null; needed: Decimal; onHand: Decimal; short: Decimal };

/**
 * What a delivery note, or an invoice that delivers, is short of: item by item (an item can be on
 * more than one line), what its lines need in the item's own unit against what the warehouse
 * holds. Empty when there is enough of everything.
 */
export function shortages(rows: readonly { itemId: string; itemCode: string; description: string; unitCode: string; unitFactor: Decimal; quantity: Decimal; onHand: Decimal }[]): Shortage[] {
  const byItem = new Map<string, Shortage>();
  for (const row of rows) {
    if (row.quantity.lte(0)) continue;
    const found = byItem.get(row.itemId) ?? { itemId: row.itemId, itemCode: row.itemCode, description: row.description, unitCode: null, needed: new Decimal(0), onHand: row.onHand, short: new Decimal(0) };
    found.needed = found.needed.plus(row.quantity.times(row.unitFactor));
    if (row.unitFactor.eq(1)) found.unitCode = row.unitCode;
    byItem.set(row.itemId, found);
  }
  const short: Shortage[] = [];
  for (const item of byItem.values()) {
    if (item.needed.gt(item.onHand)) short.push({ ...item, short: item.needed.minus(item.onHand) });
  }
  return short;
}
