import Decimal from "decimal.js";
import { AMOUNT_SCALE, formatAmount, parseAmount } from "@/lib/money";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { parseQuantity, toBaseQuantity } from "@/modules/items/rules";
import type { PriceSource } from "@/modules/prices/rules";
import { taxLine, type BuyerTax, type DatedTaxRate, type FurtherTaxReason, type SellerTax, type TaxCategoryForLine } from "@/modules/tax/rules";
import type { TaxCategoryKind } from "@/modules/tax/rules";

// Pure rules for sales documents. No I/O.
//
// A sales document is typed as a customer, a date and a list of lines: so many of an item, in
// one of the item's units, at a price, less a discount. What each line comes to, and the tax on
// it, is worked out here from facts the caller hands in (the item, the price lists' price, the
// dated tax rates): the tax itself is the tax engine's answer (tax/rules.ts), never a rate typed
// by anyone. Everything is decimal.js.

/** The kinds of sales document that can be written so far. */
export const SALES_KINDS = ["quotation", "order", "delivery"] as const;
export type SalesKind = (typeof SALES_KINDS)[number];
export const isSalesKind = (value: unknown): value is SalesKind => typeof value === "string" && (SALES_KINDS as readonly string[]).includes(value);

/** The kinds typed from nothing on the entry form. A delivery note is not: it is made from its order. */
export const ENTRY_KINDS = ["quotation", "order"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const isEntryKind = (value: unknown): value is EntryKind => typeof value === "string" && (ENTRY_KINDS as readonly string[]).includes(value);

export const KIND_LABELS: Record<SalesKind, string> = { quotation: "Quotation", order: "Sales order", delivery: "Delivery note" };
export const KIND_PLURALS: Record<SalesKind, string> = { quotation: "Quotations", order: "Sales orders", delivery: "Delivery notes" };

export const SALES_STATUSES = ["draft", "on_hold", "submitted", "cancelled"] as const;
export type SalesStatus = (typeof SALES_STATUSES)[number];
export const STATUS_LABELS: Record<SalesStatus, string> = { draft: "Draft", on_hold: "Waiting for approval", submitted: "Submitted", cancelled: "Cancelled" };
/** A delivery note that is submitted has moved its goods: it is "posted". */
export const statusLabel = (kind: SalesKind, status: SalesStatus) => (kind === "delivery" && status === "submitted" ? "Posted" : STATUS_LABELS[status]);

/** A document typed by hand can hold this many lines. */
export const MAX_SALES_LINES = 200;

/** Digits after the point that an amount on a document keeps: the paisa. */
const DOCUMENT_SCALE = 2;
const paisa = (amount: Decimal) => amount.toDecimalPlaces(DOCUMENT_SCALE, Decimal.ROUND_HALF_UP);
const Wide = Decimal.clone({ precision: 60 });
const NIL = new Decimal(0);
const HUNDRED = new Decimal(100);
/** The columns are numeric(20,4): sixteen digits before the point. */
const AMOUNT_LIMIT = new Decimal("1e16");

// ── Reading what a person types ─────────────────────────────────────────────────────────────────

export type RawLine = { itemId?: unknown; description?: unknown; unitId?: unknown; quantity?: unknown; unitPrice?: unknown; discountPercent?: unknown };
export type RawShare = { userId?: unknown; percent?: unknown };
export type RawDocument = {
  kind?: unknown;
  date?: unknown;
  validUntil?: unknown;
  customerId?: unknown;
  warehouseId?: unknown;
  customerReference?: unknown;
  notes?: unknown;
  furtherTaxExcluded?: unknown;
  /** One entry per row of the form, in order; rows left wholly empty are skipped and not counted. */
  lines?: readonly RawLine[];
  shares?: readonly RawShare[];
};

export type DraftLine = {
  itemId: string;
  /** What the line says; null keeps the item's own name. */
  description: string | null;
  /** The unit sold in; null means the item's own unit. */
  unitId: string | null;
  quantity: Decimal;
  /** The price of one of the unit sold; null takes the price lists' price. */
  unitPrice: Decimal | null;
  discountPercent: Decimal | null;
};
export type Share = { userId: string; percent: Decimal };
export type Draft = {
  kind: EntryKind;
  date: string;
  validUntil: string | null;
  customerId: string;
  warehouseId: string;
  customerReference: string | null;
  notes: string | null;
  furtherTaxExcluded: boolean;
  lines: DraftLine[];
  shares: Share[];
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** A percentage as typed: a plain number from 0 to 100 with at most four digits after the point. */
export function parsePercent(input: unknown): { ok: true; percent: Decimal } | { ok: false; reason: string } {
  const typed = text(input);
  if (typed === "") return { ok: false, reason: "Enter a percentage." };
  if (!/^\d+(\.\d+)?$/.test(typed)) return { ok: false, reason: "Enter a percentage as a plain number, such as 5 or 2.5." };
  if ((typed.split(".")[1] ?? "").length > 4) return { ok: false, reason: "Use at most 4 digits after the point." };
  const percent = new Decimal(typed);
  if (percent.gt(100)) return { ok: false, reason: "A percentage cannot be more than 100." };
  return { ok: true, percent };
}

/**
 * The salespeople's shares of a sale: none at all, or shares that come to exactly 100, each
 * person once.
 */
export function readShares(raw: readonly RawShare[] | undefined): { ok: true; shares: Share[] } | { ok: false; reason: string } {
  const shares: Share[] = [];
  for (const row of raw ?? []) {
    const userId = text(row.userId);
    const typed = text(row.percent);
    if (userId === "" && typed === "") continue;
    if (userId === "") return { ok: false, reason: "Salespeople: choose who the share is for." };
    const parsed = parsePercent(typed === "" ? "100" : typed);
    if (!parsed.ok) return { ok: false, reason: `Salespeople: ${parsed.reason}` };
    if (parsed.percent.isZero()) return { ok: false, reason: "Salespeople: a share must be more than zero." };
    if (shares.some((share) => share.userId === userId)) return { ok: false, reason: "Salespeople: the same person is listed twice." };
    shares.push({ userId, percent: parsed.percent });
  }
  if (shares.length > 10) return { ok: false, reason: "Salespeople: a sale can be shared between at most 10 people." };
  const sum = shares.reduce((total, share) => total.plus(share.percent), NIL);
  if (shares.length > 0 && !sum.eq(100)) return { ok: false, reason: `Salespeople: the shares come to ${sum.toFixed()}%, not 100%.` };
  return { ok: true, shares };
}

/** Cleans what was typed for a sales document, or gives the first thing that is wrong in plain words. */
export function readDraft(raw: RawDocument): { ok: true; draft: Draft } | { ok: false; reason: string } {
  if (!isEntryKind(raw.kind)) return { ok: false, reason: "Choose a quotation or a sales order." };
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date." };
  const until = text(raw.validUntil);
  if (until !== "" && raw.kind !== "quotation") return { ok: false, reason: "Only a quotation has a last day." };
  if (until !== "" && !isIsoDate(until)) return { ok: false, reason: "Enter the quotation's last day, or leave it empty." };
  if (until !== "" && until < raw.date) return { ok: false, reason: "The quotation's last day cannot be before its date." };
  const customerId = text(raw.customerId);
  if (customerId === "") return { ok: false, reason: "Choose the customer." };
  const warehouseId = text(raw.warehouseId);
  if (warehouseId === "") return { ok: false, reason: "Choose the warehouse the goods leave from." };
  const customerReference = cleanText(raw.customerReference);
  if (customerReference.length > 60) return { ok: false, reason: "The customer's reference: use at most 60 characters." };
  const notes = cleanText(raw.notes);
  if (notes.length > 1000) return { ok: false, reason: "Notes: use at most 1,000 characters." };

  const lines: DraftLine[] = [];
  for (const row of raw.lines ?? []) {
    const itemId = text(row.itemId);
    const description = cleanText(row.description);
    const unitId = text(row.unitId);
    const quantity = text(row.quantity);
    const unitPrice = text(row.unitPrice);
    const discount = text(row.discountPercent);
    if (itemId === "" && quantity === "" && unitPrice === "" && discount === "") continue;
    const at = `Line ${lines.length + 1}`;
    if (itemId === "") return { ok: false, reason: `${at}: choose an item.` };
    if (description.length > 300) return { ok: false, reason: `${at}: use at most 300 characters for the description.` };
    const parsedQuantity = parseQuantity(quantity);
    if (!parsedQuantity.ok) return { ok: false, reason: `${at}, quantity: ${parsedQuantity.reason}` };
    let price: Decimal | null = null;
    if (unitPrice !== "") {
      const parsed = parseAmount(unitPrice);
      if (!parsed.ok) return { ok: false, reason: `${at}, price: ${parsed.reason.replace("the amount", "the price")}` };
      price = parsed.amount;
    }
    let percent: Decimal | null = null;
    if (discount !== "") {
      const parsed = parsePercent(discount);
      if (!parsed.ok) return { ok: false, reason: `${at}, discount: ${parsed.reason}` };
      percent = parsed.percent.isZero() ? null : parsed.percent;
    }
    lines.push({ itemId, description: description === "" ? null : description, unitId: unitId === "" ? null : unitId, quantity: parsedQuantity.value, unitPrice: price, discountPercent: percent });
  }
  if (lines.length > MAX_SALES_LINES) return { ok: false, reason: `A document can have at most ${MAX_SALES_LINES} lines.` };
  const shares = readShares(raw.shares);
  if (!shares.ok) return shares;
  return {
    ok: true,
    draft: {
      kind: raw.kind,
      date: raw.date,
      validUntil: until === "" ? null : until,
      customerId,
      warehouseId,
      customerReference: customerReference === "" ? null : customerReference,
      notes: notes === "" ? null : notes,
      furtherTaxExcluded: raw.furtherTaxExcluded === true || raw.furtherTaxExcluded === "on" || raw.furtherTaxExcluded === "true",
      lines,
      shares: shares.shares,
    },
  };
}

// ── Working a line out ──────────────────────────────────────────────────────────────────────────

/** What the caller knows about the item on a line. */
export type LineItem = {
  id: string;
  code: string;
  name: string;
  archived: boolean;
  baseUnitId: string;
  /** The other units the item is sold in; one of each holds `factor` of the item's own unit. */
  conversions: readonly { unitId: string; factor: Decimal }[];
  taxCategory: TaxCategoryForLine | null;
  /** One of the item's own unit, before sales tax. */
  retailPrice: Decimal | null;
  saleType: string | null;
  fbrUomCode: string | null;
  hsCode: string | null;
};

/** What the price lists give for one of the item's own unit, and from which level. */
export type ListPrice = { price: Decimal; source: PriceSource };

/** What every line of one document shares: who sells, who buys, when, and the dated rates. */
export type TaxContext = {
  seller: SellerTax;
  buyer: BuyerTax;
  date: string;
  currency: string;
  rates: readonly DatedTaxRate[];
  standardCategory: TaxCategoryForLine | null;
};

/** A line worked out in full: what is stored. */
export type PricedLine = {
  itemId: string;
  description: string;
  unitId: string;
  unitFactor: Decimal;
  quantity: Decimal;
  baseQuantity: Decimal;
  listPrice: Decimal | null;
  priceSource: PriceSource | null;
  unitPrice: Decimal;
  discountPercent: Decimal | null;
  /** The quantity at the price, before the discount. */
  gross: Decimal;
  discountAmount: Decimal;
  taxCategoryId: string | null;
  taxKind: TaxCategoryKind | null;
  taxRate: Decimal;
  taxRateFrom: string | null;
  taxAmount: Decimal;
  furtherTaxRate: Decimal;
  furtherTaxAmount: Decimal;
  furtherTaxReason: FurtherTaxReason;
  extraTaxAmount: Decimal;
  retailPrice: Decimal | null;
  retailPriceBase: Decimal | null;
  saleType: string | null;
  sroScheduleNo: string | null;
  sroItemSerial: string | null;
  fbrUomCode: string | null;
  hsCode: string | null;
  value: Decimal;
  total: Decimal;
};

/**
 * One typed line, worked out: its unit and quantity in the item's own unit, its price (the
 * typed one, else the price lists'), its discount and its tax. It never guesses: a line with no
 * price anywhere is refused, and so is a quantity that is not an exact number of the item's
 * own unit.
 */
export function priceLine(line: DraftLine, item: LineItem, listPrice: ListPrice | null, context: TaxContext): { ok: true; line: PricedLine } | { ok: false; reason: string } {
  if (item.archived) return { ok: false, reason: `${item.code} is archived and cannot be sold.` };
  const unitId = line.unitId ?? item.baseUnitId;
  const conversion = item.conversions.find((c) => c.unitId === unitId);
  if (unitId !== item.baseUnitId && !conversion) return { ok: false, reason: `${item.code} is not sold in that unit.` };
  const unitFactor = unitId === item.baseUnitId ? new Decimal(1) : conversion!.factor;
  const base = toBaseQuantity(line.quantity, unitId, { baseUnitId: item.baseUnitId, conversions: item.conversions });
  if (!base.ok) return base;

  // The price lists price one of the item's own unit; a carton of 12 costs twelve times that.
  const listed = listPrice === null ? null : new Decimal(new Wide(listPrice.price).times(unitFactor).toDecimalPlaces(AMOUNT_SCALE, Decimal.ROUND_HALF_UP).toFixed());
  const unitPrice = line.unitPrice ?? listed;
  if (unitPrice === null) return { ok: false, reason: `${item.code} has no price for this customer. Enter the price.` };

  const gross = paisa(new Decimal(new Wide(line.quantity).times(unitPrice).toFixed()));
  if (gross.gte(AMOUNT_LIMIT)) return { ok: false, reason: `${item.code}: that quantity at that price is too large an amount.` };
  const discountAmount = line.discountPercent === null ? NIL : paisa(new Decimal(new Wide(gross).times(line.discountPercent).div(HUNDRED).toFixed()));
  const taxed = taxLine({
    seller: context.seller,
    buyer: context.buyer,
    item: { category: item.taxCategory, retailPrice: item.retailPrice, saleType: item.saleType },
    date: context.date,
    currency: context.currency,
    quantity: line.quantity,
    unitPrice,
    unitsPerUnitSold: unitFactor,
    discount: discountAmount,
    rates: context.rates,
    standardCategory: context.standardCategory,
  });
  if (!taxed.ok) return { ok: false, reason: `${item.code}: ${taxed.reason}` };
  const tax = taxed.line;
  return {
    ok: true,
    line: {
      itemId: item.id,
      description: line.description ?? item.name,
      unitId,
      unitFactor,
      quantity: line.quantity,
      baseQuantity: base.quantity,
      listPrice: listed,
      priceSource: listed === null ? null : listPrice!.source,
      unitPrice,
      discountPercent: line.discountPercent,
      gross,
      discountAmount,
      taxCategoryId: tax.categoryId,
      taxKind: tax.kind,
      taxRate: tax.rate,
      taxRateFrom: tax.rateFrom,
      taxAmount: tax.taxAmount,
      furtherTaxRate: tax.furtherTaxRate,
      furtherTaxAmount: tax.furtherTaxAmount,
      furtherTaxReason: tax.furtherTaxReason,
      extraTaxAmount: tax.extraTaxAmount,
      retailPrice: item.retailPrice,
      retailPriceBase: tax.retailPriceBase,
      saleType: tax.saleType,
      sroScheduleNo: tax.sroScheduleNo,
      sroItemSerial: tax.sroItemSerial,
      // FBR's codes mean something only on a document that carries sales tax.
      fbrUomCode: tax.taxed ? item.fbrUomCode : null,
      hsCode: tax.taxed ? item.hsCode : null,
      value: tax.value,
      total: tax.total,
    },
  };
}

export type Totals = { gross: Decimal; discount: Decimal; value: Decimal; tax: Decimal; furtherTax: Decimal; extraTax: Decimal; total: Decimal };

/** What a document's lines come to. */
export function documentTotals(lines: readonly Pick<PricedLine, "gross" | "discountAmount" | "value" | "taxAmount" | "furtherTaxAmount" | "extraTaxAmount" | "total">[]): Totals {
  const sum = (pick: (line: (typeof lines)[number]) => Decimal) => lines.reduce((total, line) => total.plus(pick(line)), NIL);
  return {
    gross: sum((l) => l.gross),
    discount: sum((l) => l.discountAmount),
    value: sum((l) => l.value),
    tax: sum((l) => l.taxAmount),
    furtherTax: sum((l) => l.furtherTaxAmount),
    extraTax: sum((l) => l.extraTaxAmount),
    total: sum((l) => l.total),
  };
}

// ── The credit limit ────────────────────────────────────────────────────────────────────────────

export type CreditFacts = {
  /** The most the customer may owe; null means no limit has been set. */
  limit: Decimal | null;
  /** What the books say the customer owes now. */
  receivable: Decimal;
  /** Orders already submitted for the customer, this one left out. */
  openOrders: Decimal;
};

/**
 * Whether an order fits under the customer's credit limit: what the customer owes, plus the
 * orders already submitted, plus this one, against the limit. No limit means no check.
 */
export function creditCheck(facts: CreditFacts, orderTotal: Decimal): { over: boolean; exposure: Decimal; after: Decimal; by: Decimal } {
  const exposure = facts.receivable.plus(facts.openOrders);
  const after = exposure.plus(orderTotal);
  const over = facts.limit !== null && after.gt(facts.limit);
  return { over, exposure, after, by: over ? after.minus(facts.limit!) : NIL };
}

/** Why an order is over the limit, in words for the screen. */
export function creditRefusal(facts: CreditFacts, orderTotal: Decimal): string | null {
  const check = creditCheck(facts, orderTotal);
  if (!check.over || facts.limit === null) return null;
  const parts = [`owes ${formatAmount(facts.receivable)}`];
  if (!facts.openOrders.isZero()) parts.push(`has ${formatAmount(facts.openOrders)} in other orders`);
  return `This order of ${formatAmount(orderTotal)} takes the customer ${formatAmount(check.by)} over the credit limit of ${formatAmount(facts.limit)}: the customer ${parts.join(" and ")}.`;
}

/** The reason an owner gives for approving an order over the limit. */
export function readReason(raw: unknown, what: string): { ok: true; reason: string } | { ok: false; reason: string } {
  const reason = cleanText(raw);
  if ([...reason].length < 3) return { ok: false, reason: `Say ${what}, in a few words.` };
  if (reason.length > 300) return { ok: false, reason: "Use at most 300 characters for the reason." };
  return { ok: true, reason };
}

/** The salesperson a document is filed under: the one with the largest share, the first listed on a tie. */
export function leadSalesperson(shares: readonly Share[]): string | null {
  let lead: Share | null = null;
  for (const share of shares) if (lead === null || share.percent.gt(lead.percent)) lead = share;
  return lead?.userId ?? null;
}

// ── Delivery notes ──────────────────────────────────────────────────────────────────────────────
//
// A delivery note is made from one sales order and delivers some or all of what the order still
// has to deliver. Its lines are lines of the order: the same item, in the same unit, at the
// order's price and discount, for a quantity that is typed. It carries no tax: tax belongs to
// the invoice. What the goods cost is worked out by the database when the note is posted.

/** A line of the order, as a delivery note needs it. Quantities are in the unit the line was sold in. */
export type OrderLineToDeliver = {
  id: string;
  itemId: string;
  itemCode: string;
  description: string;
  unitId: string;
  unitFactor: Decimal;
  quantity: Decimal;
  unitPrice: Decimal;
  listPrice: Decimal | null;
  priceSource: PriceSource | null;
  discountPercent: Decimal | null;
  /** What posted delivery notes have already delivered of it, in the same unit. */
  delivered: Decimal;
};

export type RawDelivery = { date?: unknown; notes?: unknown; lines?: readonly { sourceLineId?: unknown; quantity?: unknown }[] };
export type DeliveryDraft = { date: string; notes: string | null; lines: { sourceLineId: string; quantity: Decimal }[] };

/** Cleans what was typed for a delivery note: a date, and how much of each line of the order to deliver now. A line left empty or at nil is not delivered. */
export function readDelivery(raw: RawDelivery): { ok: true; delivery: DeliveryDraft } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date of the delivery." };
  const notes = cleanText(raw.notes);
  if (notes.length > 1000) return { ok: false, reason: "Notes: use at most 1,000 characters." };
  const lines: DeliveryDraft["lines"] = [];
  for (const row of raw.lines ?? []) {
    const sourceLineId = text(row.sourceLineId);
    const typed = text(row.quantity);
    if (sourceLineId === "" || typed === "" || /^0+(\.0+)?$/.test(typed)) continue;
    const parsed = parseQuantity(typed);
    if (!parsed.ok) return { ok: false, reason: `Line ${lines.length + 1}, quantity: ${parsed.reason}` };
    if (lines.some((line) => line.sourceLineId === sourceLineId)) return { ok: false, reason: "A line of the order is on the delivery note twice." };
    lines.push({ sourceLineId, quantity: parsed.value });
  }
  if (lines.length > MAX_SALES_LINES) return { ok: false, reason: `A document can have at most ${MAX_SALES_LINES} lines.` };
  return { ok: true, delivery: { date: raw.date, notes: notes === "" ? null : notes, lines } };
}

/** How much of an order line is still to be delivered, in the unit it was sold in; never below nil. */
export function stillToDeliver(line: Pick<OrderLineToDeliver, "quantity" | "delivered">): Decimal {
  return Decimal.max(line.quantity.minus(line.delivered), 0);
}

/**
 * The lines of a delivery note, worked out from the order's own lines and the quantities to
 * deliver now. A quantity above what the order still has to deliver is refused, here and again
 * by the database when the note is posted. The goods are valued at the order's price less its
 * discount; no tax is worked out.
 */
export function deliveryLines(order: readonly OrderLineToDeliver[], wanted: readonly { sourceLineId: string; quantity: Decimal }[]): { ok: true; lines: (PricedLine & { sourceLineId: string })[] } | { ok: false; reason: string } {
  const lines: (PricedLine & { sourceLineId: string })[] = [];
  for (const want of wanted) {
    const line = order.find((candidate) => candidate.id === want.sourceLineId);
    if (!line) return { ok: false, reason: "A line on the delivery note is not a line of its order." };
    const left = stillToDeliver(line);
    if (want.quantity.gt(left)) {
      return { ok: false, reason: `${line.itemCode}: the order has ${left.toFixed()} still to deliver, not ${want.quantity.toFixed()}.` };
    }
    const base = new Decimal(new Wide(want.quantity).times(line.unitFactor).toFixed());
    if (base.decimalPlaces() > 4) return { ok: false, reason: `${line.itemCode}: that quantity does not come to an exact number of the item's own unit.` };
    const gross = paisa(new Decimal(new Wide(want.quantity).times(line.unitPrice).toFixed()));
    const discountAmount = line.discountPercent === null ? NIL : paisa(new Decimal(new Wide(gross).times(line.discountPercent).div(HUNDRED).toFixed()));
    const value = gross.minus(discountAmount);
    lines.push({
      sourceLineId: line.id,
      itemId: line.itemId,
      description: line.description,
      unitId: line.unitId,
      unitFactor: line.unitFactor,
      quantity: want.quantity,
      baseQuantity: base,
      listPrice: line.listPrice,
      priceSource: line.priceSource,
      unitPrice: line.unitPrice,
      discountPercent: line.discountPercent,
      gross,
      discountAmount,
      taxCategoryId: null,
      taxKind: null,
      taxRate: NIL,
      taxRateFrom: null,
      taxAmount: NIL,
      furtherTaxRate: NIL,
      furtherTaxAmount: NIL,
      furtherTaxReason: null,
      extraTaxAmount: NIL,
      retailPrice: null,
      retailPriceBase: null,
      saleType: null,
      sroScheduleNo: null,
      sroItemSerial: null,
      fbrUomCode: null,
      hsCode: null,
      value,
      total: value,
    });
  }
  return { ok: true, lines };
}

/**
 * Whether the warehouse holds enough for a delivery note, item by item (an item can be on more
 * than one line). The first item that is short is named; null when there is enough of everything.
 */
export function stockShortfall(needs: readonly { itemId: string; itemCode: string; baseQuantity: Decimal }[], onHand: ReadonlyMap<string, Decimal>): { itemCode: string; needed: Decimal; onHand: Decimal } | null {
  const needed = new Map<string, { itemCode: string; quantity: Decimal }>();
  for (const need of needs) needed.set(need.itemId, { itemCode: need.itemCode, quantity: (needed.get(need.itemId)?.quantity ?? NIL).plus(need.baseQuantity) });
  for (const [itemId, need] of needed) {
    const held = onHand.get(itemId) ?? NIL;
    if (need.quantity.gt(held)) return { itemCode: need.itemCode, needed: need.quantity, onHand: held };
  }
  return null;
}
