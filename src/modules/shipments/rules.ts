import Decimal from "decimal.js";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { parseBillAmount } from "@/modules/supplier-bills/rules";

// Pure rules for shipments and the charges of bringing them in. No I/O.
//
// A shipment is typed as a supplier, a branch, the day it was opened and what identifies it at
// the port. A charge is a line of a supplier bill that was charged to Goods in transit, with
// what kind of charge it is. Spreading the charges is the database's act; the same sums are
// worked here to show them beforehand. Everything is decimal.js.

export const SHIPMENT_STATUSES = ["open", "closed", "cancelled"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = { open: "Open", closed: "Closed", cancelled: "Cancelled" };

export const SHIPMENT_STAGES = ["ordered", "shipped", "at_port", "cleared", "received"] as const;
export type ShipmentStage = (typeof SHIPMENT_STAGES)[number];
export const SHIPMENT_STAGE_LABELS: Record<ShipmentStage, string> = { ordered: "Ordered", shipped: "Shipped", at_port: "At the port", cleared: "Cleared customs", received: "Received" };

export const CHARGE_CLASSES = ["inventory", "sales_tax", "advance_income_tax", "deposit", "expense"] as const;
export type ChargeClass = (typeof CHARGE_CLASSES)[number];
export const CHARGE_CLASS_LABELS: Record<ChargeClass, string> = {
  inventory: "Part of what the goods cost",
  sales_tax: "Sales tax paid at import, claimed back",
  advance_income_tax: "Income tax paid at import",
  deposit: "Deposit that comes back",
  expense: "Expense, not part of what the goods cost",
};

export const CHARGE_BASES = ["value", "quantity", "weight", "volume"] as const;
export type ChargeBasis = (typeof CHARGE_BASES)[number];
export const CHARGE_BASIS_LABELS: Record<ChargeBasis, string> = { value: "By value", quantity: "By quantity", weight: "By weight", volume: "By volume" };

const NIL = new Decimal(0);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const paisa = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export type RawShipment = {
  openedOn?: unknown;
  supplierId?: unknown;
  branchId?: unknown;
  stage?: unknown;
  origin?: unknown;
  port?: unknown;
  containerNo?: unknown;
  blNumber?: unknown;
  lcNumber?: unknown;
  gdNumber?: unknown;
  gdDate?: unknown;
  customsValue?: unknown;
  expectedOn?: unknown;
  note?: unknown;
};

export type ShipmentDetails = {
  stage: ShipmentStage;
  origin: string | null;
  port: string | null;
  containerNo: string | null;
  blNumber: string | null;
  lcNumber: string | null;
  gdNumber: string | null;
  gdDate: string | null;
  customsValue: Decimal | null;
  expectedOn: string | null;
  note: string | null;
};

export type ShipmentDraft = ShipmentDetails & { openedOn: string; supplierId: string; branchId: string };

const FIELDS: readonly { key: "origin" | "port" | "containerNo" | "blNumber" | "lcNumber" | "gdNumber" | "note"; label: string; max: number }[] = [
  { key: "origin", label: "Shipped from", max: 80 },
  { key: "port", label: "Port", max: 80 },
  { key: "containerNo", label: "Container number", max: 60 },
  { key: "blNumber", label: "Bill of lading number", max: 60 },
  { key: "lcNumber", label: "Letter of credit number", max: 60 },
  { key: "gdNumber", label: "Goods declaration (GD) number", max: 100 },
  { key: "note", label: "Note", max: 500 },
];

/** Cleans what describes a shipment: how far it has come and what identifies it at the port. */
export function readShipmentDetails(raw: RawShipment): { ok: true; details: ShipmentDetails } | { ok: false; reason: string } {
  const stage = SHIPMENT_STAGES.find((known) => known === (text(raw.stage) || "ordered"));
  if (!stage) return { ok: false, reason: "Choose how far the shipment has come." };
  const words = {} as Record<(typeof FIELDS)[number]["key"], string | null>;
  for (const field of FIELDS) {
    const value = cleanText(raw[field.key]);
    if (value.length > field.max) return { ok: false, reason: `${field.label}: use at most ${field.max} characters.` };
    words[field.key] = value === "" ? null : value;
  }
  const gdDate = text(raw.gdDate);
  if (gdDate !== "" && !isIsoDate(gdDate)) return { ok: false, reason: "Enter the date on the goods declaration, or leave it empty." };
  const expectedOn = text(raw.expectedOn);
  if (expectedOn !== "" && !isIsoDate(expectedOn)) return { ok: false, reason: "Enter the day the goods are expected, or leave it empty." };
  let customsValue: Decimal | null = null;
  if (text(raw.customsValue) !== "") {
    const parsed = parseBillAmount(raw.customsValue);
    if (!parsed.ok) return { ok: false, reason: `Customs value: ${parsed.reason}` };
    customsValue = parsed.amount;
  }
  return { ok: true, details: { stage, ...words, gdDate: gdDate === "" ? null : gdDate, customsValue, expectedOn: expectedOn === "" ? null : expectedOn } };
}

/** Cleans what was typed to open a shipment, or gives the first thing that is wrong in plain words. */
export function readShipment(raw: RawShipment): { ok: true; shipment: ShipmentDraft } | { ok: false; reason: string } {
  if (!isIsoDate(raw.openedOn)) return { ok: false, reason: "Enter the day the shipment is opened." };
  const supplierId = text(raw.supplierId);
  if (supplierId === "") return { ok: false, reason: "Choose the supplier." };
  const branchId = text(raw.branchId);
  if (branchId === "") return { ok: false, reason: "Choose the branch the shipment belongs to." };
  const details = readShipmentDetails(raw);
  if (!details.ok) return details;
  return { ok: true, shipment: { openedOn: raw.openedOn, supplierId, branchId, ...details.details } };
}

export type RawCharge = { billLineId?: unknown; class?: unknown; basis?: unknown; accountId?: unknown };
export type ChargeDraft = { billLineId: string; class: ChargeClass; basis: ChargeBasis | null; accountId: string | null };

/** Cleans a charge put on a shipment: which bill line, what kind of charge, and what follows from the kind. */
export function readCharge(raw: RawCharge): { ok: true; charge: ChargeDraft } | { ok: false; reason: string } {
  const billLineId = text(raw.billLineId);
  if (billLineId === "") return { ok: false, reason: "Choose the bill line the charge was billed on." };
  const kind = CHARGE_CLASSES.find((known) => known === raw.class);
  if (!kind) return { ok: false, reason: "Choose what kind of charge it is." };
  let basis: ChargeBasis | null = null;
  if (kind === "inventory") {
    basis = CHARGE_BASES.find((known) => known === raw.basis) ?? null;
    if (!basis) return { ok: false, reason: "Choose what the charge is spread over the goods by: value, quantity, weight or volume." };
  }
  const accountId = kind === "deposit" || kind === "expense" ? text(raw.accountId) : "";
  if (kind === "deposit" && accountId === "") return { ok: false, reason: "Choose the asset account the deposit is held in." };
  if (kind === "expense" && accountId === "") return { ok: false, reason: "Choose the expense account the charge goes to." };
  return { ok: true, charge: { billLineId, class: kind, basis, accountId: accountId === "" ? null : accountId } };
}

/** One line of a shipment's goods, with what a charge can be measured by. */
export type GoodsLine = { receiptLineId: string; itemId: string; itemCode: string; value: Decimal; quantity: Decimal; weight: Decimal; volume: Decimal };

const BASIS_WORDS: Record<ChargeBasis, string> = { value: "value", quantity: "quantity", weight: "weight", volume: "volume" };

/**
 * A charge shared over the lines of a shipment's goods in proportion to a measure, to the
 * paisa: each line its part, never more than is left of the charge, the last line that has any
 * of the measure taking what is left. A line with none of the measure gets nothing. Refused
 * when no line has any. The database spreads a charge the same way when the shipment is closed.
 */
export function spreadCharge(amount: Decimal, basis: ChargeBasis, lines: readonly GoodsLine[]): { ok: true; shares: Decimal[] } | { ok: false; reason: string } {
  const measures = lines.map((line) => line[basis]);
  const sum = measures.reduce((total, measure) => total.plus(measure), NIL);
  if (lines.length === 0) return { ok: false, reason: "The shipment has no goods to spread charges over." };
  if (sum.lte(0)) return { ok: false, reason: `None of the goods has a ${BASIS_WORDS[basis]} to spread the charge by.${basis === "weight" || basis === "volume" ? ` Enter the ${BASIS_WORDS[basis]} on the items' cards, or spread it another way.` : ""}` };
  const last = measures.reduce((found, measure, index) => (measure.gt(0) ? index : found), -1);
  let given = NIL;
  const shares = measures.map((measure, index) => {
    if (measure.lte(0)) return NIL;
    const share = index === last ? amount.minus(given) : Decimal.min(paisa(amount.times(measure).div(sum)), amount.minus(given));
    given = given.plus(share);
    return share;
  });
  return { ok: true, shares };
}

/**
 * What an item's share of the charges does: the part of what the shipment brought that the
 * company still holds takes its part into stock; the rest goes to cost of goods sold.
 */
export function splitHeld(amount: Decimal, brought: Decimal, held: Decimal): { toStock: Decimal; toCogs: Decimal } {
  const kept = Decimal.min(brought, Decimal.max(held, 0));
  const toStock = kept.gte(brought) ? amount : kept.lte(0) ? NIL : paisa(amount.times(kept).div(brought));
  return { toStock, toCogs: amount.minus(toStock) };
}

export type PendingCharge = { class: ChargeClass; basis: ChargeBasis | null; amount: Decimal };
export type SpreadPreview = {
  /** What each line of the goods would take of the charges that are part of what the goods cost. */
  perLine: Decimal[];
  toStock: Decimal;
  toCogs: Decimal;
  salesTax: Decimal;
  advanceIncomeTax: Decimal;
  deposits: Decimal;
  expenses: Decimal;
  total: Decimal;
};

/** What spreading the waiting charges would do today, or why it cannot be worked out. `held` is what the company holds of each item now. */
export function previewSpread(charges: readonly PendingCharge[], lines: readonly GoodsLine[], held: ReadonlyMap<string, Decimal>): { ok: true; preview: SpreadPreview } | { ok: false; reason: string } {
  const perLine = lines.map(() => NIL);
  const sums = { salesTax: NIL, advanceIncomeTax: NIL, deposits: NIL, expenses: NIL, total: NIL };
  for (const charge of charges) {
    sums.total = sums.total.plus(charge.amount);
    if (charge.class === "sales_tax") sums.salesTax = sums.salesTax.plus(charge.amount);
    else if (charge.class === "advance_income_tax") sums.advanceIncomeTax = sums.advanceIncomeTax.plus(charge.amount);
    else if (charge.class === "deposit") sums.deposits = sums.deposits.plus(charge.amount);
    else if (charge.class === "expense") sums.expenses = sums.expenses.plus(charge.amount);
    else {
      const spread = spreadCharge(charge.amount, charge.basis ?? "value", lines);
      if (!spread.ok) return spread;
      spread.shares.forEach((share, index) => (perLine[index] = perLine[index].plus(share)));
    }
  }
  const byItem = new Map<string, { amount: Decimal; brought: Decimal }>();
  lines.forEach((line, index) => {
    const item = byItem.get(line.itemId) ?? { amount: NIL, brought: NIL };
    byItem.set(line.itemId, { amount: item.amount.plus(perLine[index]), brought: item.brought.plus(line.quantity) });
  });
  let toStock = NIL;
  let toCogs = NIL;
  for (const [itemId, item] of byItem) {
    const split = splitHeld(item.amount, item.brought, held.get(itemId) ?? NIL);
    toStock = toStock.plus(split.toStock);
    toCogs = toCogs.plus(split.toCogs);
  }
  return { ok: true, preview: { perLine, toStock, toCogs, ...sums } };
}
