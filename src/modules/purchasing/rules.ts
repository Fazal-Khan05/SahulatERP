import Decimal from "decimal.js";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { parseQuantity, toBaseQuantity, type ItemUnits } from "@/modules/items/rules";

// Pure rules for buying: purchase orders and goods received. No I/O.
//
// An order is typed as a supplier, a warehouse, a date and a list of lines: so many of an item,
// in one of the item's units, at a cost for one of that unit before tax. Goods received are
// typed against an order: how much of each of its lines arrived. Everything is decimal.js.

export const PURCHASE_ORDER_STATUSES = ["draft", "submitted", "cancelled"] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];
export const ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = { draft: "Draft", submitted: "Submitted", cancelled: "Cancelled" };

export const GOODS_RECEIPT_STATUSES = ["draft", "posted"] as const;
export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number];
export const RECEIPT_STATUS_LABELS: Record<GoodsReceiptStatus, string> = { draft: "Draft", posted: "Posted" };

/** A document typed by hand can hold this many lines. */
export const MAX_PURCHASE_LINES = 200;

const NIL = new Decimal(0);
const paisa = (amount: Decimal) => amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const isNil = (typed: string) => /^0+(\.0+)?$/.test(typed);

/** What one of a unit costs can carry this many decimals: a carton priced by the piece rarely divides to the paisa. */
export const UNIT_COST_SCALE = 4;

/** What one costs, before tax: a plain number, nil allowed (a free sample still arrives). */
export function parseUnitCost(input: unknown): { ok: true; cost: Decimal } | { ok: false; reason: string } {
  const typed = text(input);
  if (typed === "") return { ok: false, reason: "Enter what one costs." };
  if (!/^\d+(\.\d+)?$/.test(typed)) return { ok: false, reason: "Enter what one costs as a plain number without commas, such as 1250 or 12.5." };
  const [whole, fraction = ""] = typed.split(".");
  if (fraction.length > UNIT_COST_SCALE) return { ok: false, reason: `Use at most ${UNIT_COST_SCALE} digits after the point.` };
  if (whole.replace(/^0+/, "").length > 13) return { ok: false, reason: "That cost is too large." };
  return { ok: true, cost: new Decimal(typed) };
}

export type RawOrder = {
  date?: unknown;
  supplierId?: unknown;
  warehouseId?: unknown;
  expectedOn?: unknown;
  supplierReference?: unknown;
  note?: unknown;
  lines?: readonly { itemId?: unknown; unitId?: unknown; quantity?: unknown; unitCost?: unknown; description?: unknown }[];
};

export type OrderDraftLine = { itemId: string; unitId: string | null; quantity: Decimal; unitCost: Decimal; description: string | null };
export type OrderDraft = { date: string; supplierId: string; warehouseId: string; expectedOn: string | null; supplierReference: string | null; note: string | null; lines: OrderDraftLine[] };

/** Cleans what was typed for a purchase order, or gives the first thing that is wrong in plain words. */
export function readOrder(raw: RawOrder): { ok: true; order: OrderDraft } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date of the order." };
  const supplierId = text(raw.supplierId);
  if (supplierId === "") return { ok: false, reason: "Choose the supplier." };
  const warehouseId = text(raw.warehouseId);
  if (warehouseId === "") return { ok: false, reason: "Choose the warehouse the goods are to arrive at." };
  const expected = text(raw.expectedOn);
  if (expected !== "" && !isIsoDate(expected)) return { ok: false, reason: "Enter the day the goods are expected, or leave it empty." };
  if (expected !== "" && expected < raw.date) return { ok: false, reason: "The goods cannot be expected before the order's date." };
  const supplierReference = cleanText(raw.supplierReference);
  if (supplierReference.length > 60) return { ok: false, reason: "The supplier's reference: use at most 60 characters." };
  const note = cleanText(raw.note);
  if (note.length > 500) return { ok: false, reason: "Note: use at most 500 characters." };

  const lines: OrderDraftLine[] = [];
  for (const row of raw.lines ?? []) {
    const itemId = text(row.itemId);
    const unitId = text(row.unitId);
    const quantity = text(row.quantity);
    const unitCost = text(row.unitCost);
    const description = cleanText(row.description);
    if (itemId === "" && quantity === "" && unitCost === "") continue;
    const at = `Line ${lines.length + 1}`;
    if (itemId === "") return { ok: false, reason: `${at}: choose an item.` };
    if (description.length > 300) return { ok: false, reason: `${at}: use at most 300 characters for the description.` };
    const parsedQuantity = parseQuantity(quantity);
    if (!parsedQuantity.ok) return { ok: false, reason: `${at}, quantity: ${parsedQuantity.reason}` };
    const parsedCost = parseUnitCost(unitCost);
    if (!parsedCost.ok) return { ok: false, reason: `${at}, cost: ${parsedCost.reason}` };
    lines.push({ itemId, unitId: unitId === "" ? null : unitId, quantity: parsedQuantity.value, unitCost: parsedCost.cost, description: description === "" ? null : description });
  }
  if (lines.length > MAX_PURCHASE_LINES) return { ok: false, reason: `An order can have at most ${MAX_PURCHASE_LINES} lines.` };
  return {
    ok: true,
    order: { date: raw.date, supplierId, warehouseId, expectedOn: expected === "" ? null : expected, supplierReference: supplierReference === "" ? null : supplierReference, note: note === "" ? null : note, lines },
  };
}

/** What a line of an order needs to know about its item. */
export type OrderItem = ItemUnits & { id: string; code: string; name: string; archived: boolean };

export type CostedLine = {
  itemId: string;
  description: string;
  unitId: string;
  unitFactor: Decimal;
  quantity: Decimal;
  baseQuantity: Decimal;
  unitCost: Decimal;
  /** The quantity at the cost of one, to the paisa. */
  amount: Decimal;
};

/** One line of an order worked out: its unit, its quantity in the item's own unit, and what it comes to. */
export function costLine(line: OrderDraftLine, item: OrderItem): { ok: true; line: CostedLine } | { ok: false; reason: string } {
  if (item.archived) return { ok: false, reason: `${item.code} is archived. Restore the item before ordering it.` };
  const unitId = line.unitId ?? item.baseUnitId;
  const base = toBaseQuantity(line.quantity, unitId, item);
  if (!base.ok) return { ok: false, reason: base.reason };
  const unitFactor = unitId === item.baseUnitId ? new Decimal(1) : (item.conversions.find((c) => c.unitId === unitId)?.factor ?? new Decimal(1));
  return {
    ok: true,
    line: { itemId: item.id, description: line.description ?? item.name, unitId, unitFactor, quantity: line.quantity, baseQuantity: base.quantity, unitCost: line.unitCost, amount: paisa(line.quantity.times(line.unitCost)) },
  };
}

/** What the lines of an order come to. */
export function orderTotal(lines: readonly Pick<CostedLine, "amount">[]): Decimal {
  return lines.reduce((sum, line) => sum.plus(line.amount), NIL);
}

/** A line of a submitted order as whoever receives goods sees it: no cost. */
export type OrderLineToReceive = { lineId: string; lineNo: number; itemId: string; itemCode: string; description: string; unitCode: string; unitFactor: Decimal; ordered: Decimal; received: Decimal };

/** How much of an order line is still to arrive, in the unit it was ordered in; never below nothing. */
export function stillToReceive(line: Pick<OrderLineToReceive, "ordered" | "received">): Decimal {
  return Decimal.max(line.ordered.minus(line.received), 0);
}

export type RawReceipt = { date?: unknown; supplierDeliveryNote?: unknown; note?: unknown; lines?: readonly { orderLineId?: unknown; quantity?: unknown }[] };
export type ReceiptDraft = { date: string; supplierDeliveryNote: string | null; note: string | null; lines: { orderLineId: string; quantity: Decimal }[] };

/** Cleans what was typed for goods received: a date, and how much of each line of the order arrived. A line left empty or at nil did not arrive. */
export function readReceipt(raw: RawReceipt): { ok: true; receipt: ReceiptDraft } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the day the goods arrived." };
  const deliveryNote = cleanText(raw.supplierDeliveryNote);
  if (deliveryNote.length > 60) return { ok: false, reason: "The supplier's delivery note number: use at most 60 characters." };
  const note = cleanText(raw.note);
  if (note.length > 500) return { ok: false, reason: "Note: use at most 500 characters." };
  const lines: ReceiptDraft["lines"] = [];
  for (const row of raw.lines ?? []) {
    const orderLineId = text(row.orderLineId);
    const typed = text(row.quantity);
    if (orderLineId === "" || typed === "" || isNil(typed)) continue;
    const parsed = parseQuantity(typed);
    if (!parsed.ok) return { ok: false, reason: `Line ${lines.length + 1}, quantity: ${parsed.reason}` };
    if (lines.some((line) => line.orderLineId === orderLineId)) return { ok: false, reason: "A line of the order is on the goods received note twice." };
    lines.push({ orderLineId, quantity: parsed.value });
  }
  if (lines.length > MAX_PURCHASE_LINES) return { ok: false, reason: `A document can have at most ${MAX_PURCHASE_LINES} lines.` };
  return { ok: true, receipt: { date: raw.date, supplierDeliveryNote: deliveryNote === "" ? null : deliveryNote, note: note === "" ? null : note, lines } };
}

/**
 * The lines of a goods received note worked out against what is left of the order: each is a
 * line of the order, for no more than is still to arrive, in a quantity the item's own unit
 * can hold.
 */
export function receiptLines(
  order: readonly OrderLineToReceive[],
  wanted: ReceiptDraft["lines"],
): { ok: true; lines: { orderLineId: string; itemId: string; itemCode: string; unitFactor: Decimal; quantity: Decimal; baseQuantity: Decimal; lineNo: number }[] } | { ok: false; reason: string } {
  const lines = [];
  for (const want of wanted) {
    const from = order.find((line) => line.lineId === want.orderLineId);
    if (!from) return { ok: false, reason: "A line on the goods received note is not a line of its order." };
    const left = stillToReceive(from);
    if (want.quantity.gt(left)) {
      return { ok: false, reason: from.received.isZero() ? `${from.itemCode}: ${from.ordered.toFixed()} was ordered, so ${want.quantity.toFixed()} cannot be received.` : `${from.itemCode}: ${from.ordered.toFixed()} was ordered and ${from.received.toFixed()} has arrived, so only ${left.toFixed()} more can be received.` };
    }
    const baseQuantity = want.quantity.times(from.unitFactor);
    if (baseQuantity.decimalPlaces() > 4) return { ok: false, reason: `${from.itemCode}: use a quantity the item's own unit can hold, with fewer decimals.` };
    lines.push({ orderLineId: from.lineId, itemId: from.itemId, itemCode: from.itemCode, unitFactor: from.unitFactor, quantity: want.quantity, baseQuantity, lineNo: from.lineNo });
  }
  return { ok: true, lines: lines.sort((a, b) => a.lineNo - b.lineNo) };
}
