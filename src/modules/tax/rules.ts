import Decimal from "decimal.js";
import { z } from "zod";

// Pure rules for sales-tax categories, their dated rates and the withholding rules. No I/O.
//
// Nothing here knows a rate. Rates are rows with an "effective from" date; a lookup for a date
// returns the row in force on that date, so a document dated before a change keeps the old rate.
// Rates are percentages held as decimal.js values, never JS numbers.

/** Digits after the decimal point that a percentage keeps; the columns are numeric(7,4). */
export const PERCENT_SCALE = 4;

// ── Sales-tax categories ────────────────────────────────────────────────────────────────────────
// An item points at a category, never at a rate.

// In the order the screens list them.
export const TAX_CATEGORY_KINDS = ["standard", "third_schedule", "reduced", "zero_rated", "exempt"] as const;
export type TaxCategoryKind = (typeof TAX_CATEGORY_KINDS)[number];

export const TAX_CATEGORY_KIND_LABELS: Record<TaxCategoryKind, string> = {
  standard: "Standard rate",
  third_schedule: "Third Schedule (retail price)",
  reduced: "Reduced rate",
  zero_rated: "Zero-rated",
  exempt: "Exempt",
};

export const taxCategoryKindSchema = z.enum(TAX_CATEGORY_KINDS, "Choose the kind of category.");

export const taxCategoryNameSchema = z
  .string()
  .trim()
  .min(2, "Enter the category's name.")
  .max(60, "Use at most 60 characters.");

/** The law, schedule or SRO a rate comes from. Every dated row says where it comes from. */
export const legalReferenceSchema = z
  .string()
  .trim()
  .min(2, "Say which law or SRO sets this rate.")
  .max(160, "Use at most 160 characters.");

/** An SRO or schedule number, or an item's serial in it. Blank means none. */
export const sroTextSchema = z
  .string()
  .trim()
  .max(60, "Use at most 60 characters.")
  .transform((value) => (value === "" ? null : value));

// ── Withholding rules ───────────────────────────────────────────────────────────────────────────
// One row is one line of a statutory rate card, from a date. `code` names the line and stays the
// same across its dated rows, such as "income_tax.goods.company".

export const WITHHOLDING_KINDS = ["income_tax", "sales_tax", "provincial_sales_tax"] as const;
export type WithholdingKind = (typeof WITHHOLDING_KINDS)[number];

export const WITHHOLDING_KIND_LABELS: Record<WithholdingKind, string> = {
  income_tax: "Income tax on payments (section 153)",
  sales_tax: "Sales tax withheld (Eleventh Schedule)",
  provincial_sales_tax: "Provincial sales tax on services",
};

/** What a rule's percentage is taken of. */
export const WITHHOLDING_BASES = ["gross_amount", "taxable_value", "sales_tax"] as const;
export type WithholdingBase = (typeof WITHHOLDING_BASES)[number];

export const WITHHOLDING_BASE_LABELS: Record<WithholdingBase, string> = {
  gross_amount: "Gross amount, sales tax included",
  taxable_value: "Value before sales tax",
  sales_tax: "Sales tax on the invoice",
};

export const withholdingCodeSchema = z
  .string()
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, "Choose a rule.")
  .max(80, "Choose a rule.");

// ── Percentages ─────────────────────────────────────────────────────────────────────────────────

type Parsed = { ok: true; percent: Decimal } | { ok: false; reason: string };

/**
 * Reads a percentage as a person types it: plain digits with an optional decimal point, from 0
 * to 100. No signs, no exponents, no "%" and no thousands separators, so nothing is ever read
 * as something else.
 */
export function parsePercent(input: unknown): Parsed {
  const text = typeof input === "string" ? input.trim() : "";
  if (text === "") return { ok: false, reason: "Enter the rate." };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: "Enter the rate as a plain number, such as 18 or 5.5." };
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > PERCENT_SCALE) return { ok: false, reason: `Use at most ${PERCENT_SCALE} digits after the point.` };
  if (whole.replace(/^0+/, "").length > 3) return { ok: false, reason: "A rate cannot be more than 100." };
  const percent = new Decimal(text);
  if (percent.gt(100)) return { ok: false, reason: "A rate cannot be more than 100." };
  return { ok: true, percent };
}

/** As parsePercent, but nothing typed means "none" and comes back as null. */
export function parseOptionalPercent(input: unknown): { ok: true; percent: Decimal | null } | { ok: false; reason: string } {
  if (input === null || input === undefined || (typeof input === "string" && input.trim() === "")) {
    return { ok: true, percent: null };
  }
  return parsePercent(input);
}

/** A percentage for showing: "18%", "5.5%", "0.25%". */
export function formatPercent(percent: Decimal): string {
  const [whole, fraction = ""] = percent.toFixed(PERCENT_SCALE).split(".");
  const kept = fraction.replace(/0+$/, "");
  return `${whole}${kept ? `.${kept}` : ""}%`;
}

/**
 * Whether a rate makes sense for a kind of category. Exempt goods carry no tax at all.
 * Zero-rated goods are taxed at 0, but the law can still put further tax on them (Sales Tax Act
 * 1990, s.4 applies "except" s.3(1A)), so only their rate is fixed. Every other kind exists to
 * charge some tax.
 */
export function checkRateForKind(
  kind: TaxCategoryKind,
  rate: Decimal,
  furtherTaxRate: Decimal,
): { ok: true } | { ok: false; reason: string } {
  if (kind === "exempt") {
    if (!rate.isZero() || !furtherTaxRate.isZero()) {
      return { ok: false, reason: "Exempt goods carry no tax. Leave both rates at 0." };
    }
    return { ok: true };
  }
  if (kind === "zero_rated") {
    if (!rate.isZero()) return { ok: false, reason: "Zero-rated goods are taxed at 0. Leave the rate at 0." };
    return { ok: true };
  }
  if (rate.isZero()) {
    return { ok: false, reason: "Enter a rate above 0, or make the category exempt or zero-rated." };
  }
  return { ok: true };
}

/**
 * Whether a rule's second rate, for a supplier who is not on the Active Taxpayers List, suits the
 * rule. Income tax always has one (the law raises every section 153 rate for such a supplier),
 * and it is never lower than the normal rate. The other kinds of rule have one rate for every
 * supplier. Nothing typed never quietly means "the same" or "none".
 */
export function checkNonAtlRate(
  kind: WithholdingKind,
  rate: Decimal,
  rateNonAtl: Decimal | null,
): { ok: true } | { ok: false; reason: string } {
  if (kind !== "income_tax") {
    if (rateNonAtl !== null) return { ok: false, reason: "This rule has one rate for every supplier. Leave the second rate empty." };
    return { ok: true };
  }
  if (rateNonAtl === null) {
    return { ok: false, reason: "Enter the rate for a supplier who is not on the Active Taxpayers List. It is normally double." };
  }
  if (rateNonAtl.lt(rate)) {
    return { ok: false, reason: "The rate for a supplier who is not on the Active Taxpayers List cannot be lower than the normal rate." };
  }
  return { ok: true };
}

// ── Lookups by date ─────────────────────────────────────────────────────────────────────────────

/**
 * The row in force on a date: the latest one effective on or before it, or null when every row
 * starts later. Dates are YYYY-MM-DD, which sort correctly as text.
 */
export function inForceOn<T extends { effectiveFrom: string }>(rows: readonly T[], on: string): T | null {
  let found: T | null = null;
  for (const row of rows) {
    if (row.effectiveFrom <= on && (found === null || row.effectiveFrom > found.effectiveFrom)) found = row;
  }
  return found;
}

/**
 * The rate of a sales-tax category on a date. A document dated before a change gets the rate
 * that applied then. Null when the category had no rate yet; the caller must refuse to guess.
 */
export function taxRateOn<T extends { categoryId: string; effectiveFrom: string }>(
  rates: readonly T[],
  categoryId: string,
  on: string,
): T | null {
  return inForceOn(
    rates.filter((rate) => rate.categoryId === categoryId),
    on,
  );
}

/** The withholding rule with this code on a date, or null when it did not exist yet. */
export function withholdingRuleOn<T extends { code: string; effectiveFrom: string }>(
  rules: readonly T[],
  code: string,
  on: string,
): T | null {
  return inForceOn(
    rules.filter((rule) => rule.code === code),
    on,
  );
}

/**
 * The percentage a rule gives for a supplier. Where the law sets a different rate for a person
 * who is not on the Active Taxpayers List, that rate applies to them; otherwise the list makes
 * no difference.
 */
export function withholdingRateFor(rule: { rate: Decimal; rateNonAtl: Decimal | null }, onActiveTaxpayersList: boolean): Decimal {
  return onActiveTaxpayersList || rule.rateNonAtl === null ? rule.rate : rule.rateNonAtl;
}

// ── The tax engine ──────────────────────────────────────────────────────────────────────────────
//
// What one line of a sale carries in tax: given the item, the buyer, the date and the price, it
// gives the rate, the sales tax, the further tax, the value the tax was worked on and what the
// buyer pays. It reads nothing and knows no rate: the caller hands it the dated rows, and it
// picks the one in force on the document's date. Everything is decimal.js; amounts are rounded
// to the paisa, half up, once, at the end of each line.
//
// The law it follows is the Sales Tax Act 1990: section 3(1) for the rate, 3(1A) for further
// tax, 3(2)(a) and the Third Schedule for goods taxed on their printed retail price, section 4
// for zero-rating and section 13 for exemption. docs/RATES-REVIEW.md says what was read where.

/** The company making the sale. */
export type SellerTax = {
  /** A company not registered for sales tax charges none and shows none. */
  salesTaxRegistered: boolean;
  /** Whether its prices already include the tax, or the tax is added on top of them. */
  pricesIncludeTax: boolean;
};

/** The buyer, as recorded on the customer. */
export type BuyerTax = {
  registrationType: "registered" | "unregistered";
  /** Whether the buyer is on the Active Taxpayers List: active, inactive, or not yet checked. */
  atlStatus: "unknown" | "active" | "inactive";
  /** True when the supply is one the law takes out of further tax (SRO 648(I)/2013), such as a sale to an end consumer. */
  furtherTaxExcluded?: boolean;
};

export type TaxCategoryForLine = { id: string; kind: TaxCategoryKind; sroScheduleNo: string | null; sroItemSerial: string | null };

/** The item on the line. `category` is null when none was set on the item. */
export type ItemTax = {
  category: TaxCategoryForLine | null;
  /**
   * The retail price of one of the item's own unit as the Act defines it (s.2(27)): before sales
   * tax. Third Schedule goods are taxed on it. A pack that prints one price including the tax
   * has this price times (100 + rate) / 100 on it.
   */
  retailPrice: Decimal | null;
  /** FBR's name for the kind of sale, when the item carries its own. */
  saleType: string | null;
};

export type DatedTaxRate = { categoryId: string; effectiveFrom: string; rate: Decimal; furtherTaxRate: Decimal };

export type TaxLineInput = {
  seller: SellerTax;
  buyer: BuyerTax;
  item: ItemTax;
  /** The date of the document, as 2026-11-13. The rate in force on that day applies. */
  date: string;
  /** The currency of the document. Amounts are worked and rounded in it. */
  currency: string;
  /** How many were sold, in the unit they were sold in, and the price of one of that unit. */
  quantity: Decimal;
  unitPrice: Decimal;
  /**
   * How many of the item's own unit one of the unit sold holds: 12 for a carton of 12, nothing
   * (one) when the item is sold in its own unit. Used only to bring the retail price, which is
   * for the item's own unit, to the quantity sold; the line itself is priced as it was entered.
   */
  unitsPerUnitSold?: Decimal;
  /** Taken off the line before tax; nothing when absent. */
  discount?: Decimal;
  /** Every dated rate the caller holds; the engine picks by category and date. */
  rates: readonly DatedTaxRate[];
  /** What an item with no category of its own is treated as: the company's standard-rate category. It must be one. */
  standardCategory: TaxCategoryForLine | null;
};

/** Why further tax was or was not added. */
export type FurtherTaxReason = "buyer_unregistered" | "buyer_inactive" | "buyer_not_checked" | null;

export type TaxLine = {
  currency: string;
  /** False when the seller is not registered: there is no tax to show anywhere. */
  taxed: boolean;
  categoryId: string | null;
  kind: TaxCategoryKind | null;
  /** The value of the supply before any tax, after the discount. */
  value: Decimal;
  /** The day the rate that was used came into force, so the row can be found again. Null when no rate was needed. */
  rateFrom: string | null;
  /** Percentages, and the amounts they came to. */
  rate: Decimal;
  taxAmount: Decimal;
  furtherTaxRate: Decimal;
  furtherTaxAmount: Decimal;
  furtherTaxReason: FurtherTaxReason;
  /** Extra tax under section 3(5). No category carries any yet; kept so no document ever lacks the figure. */
  extraTaxAmount: Decimal;
  /** For Third Schedule goods, the retail price times the quantity: what the sales tax was worked on. Null otherwise. */
  retailPriceBase: Decimal | null;
  /** What the buyer pays for the line: value plus every tax. */
  total: Decimal;
  /** FBR's name for the kind of sale, and the schedule or SRO behind a special treatment. */
  saleType: string | null;
  sroScheduleNo: string | null;
  sroItemSerial: string | null;
};

/** FBR's names for the kinds of sale, by kind of category. An item's own name, when it has one, wins. */
export const DEFAULT_SALE_TYPES: Record<TaxCategoryKind, string> = {
  standard: "Goods at standard rate (default)",
  reduced: "Goods at Reduced Rate",
  third_schedule: "3rd Schedule Goods",
  zero_rated: "Goods at zero-rate",
  exempt: "Exempt goods",
};

/** Digits after the point that an amount on a document keeps. */
export const TAX_AMOUNT_SCALE = 2;
const paisa = (amount: Decimal) => amount.toDecimalPlaces(TAX_AMOUNT_SCALE, Decimal.ROUND_HALF_UP);
const Wide = Decimal.clone({ precision: 60 });
const NIL = new Decimal(0);

/**
 * Whether the buyer attracts further tax, and why. Section 3(1A) puts it on a supply to a person
 * who has no registration number or is not an active taxpayer. A registered buyer whose status
 * has not been checked is not known to be an active taxpayer, so further tax is added until
 * someone checks: the seller answers for further tax it did not charge, with surcharge and
 * penalty, which is the larger risk. The reason comes back with the line, so that a screen can
 * say why the tax is there and send the user to check the customer.
 */
export function furtherTaxReason(buyer: BuyerTax): FurtherTaxReason {
  if (buyer.furtherTaxExcluded) return null;
  if (buyer.registrationType === "unregistered") return "buyer_unregistered";
  if (buyer.atlStatus === "inactive") return "buyer_inactive";
  if (buyer.atlStatus === "unknown") return "buyer_not_checked";
  return null;
}

/**
 * The tax on one line of a sale, or why it cannot be worked out. It never guesses: an item
 * taxed on its retail price needs one, and a category needs a rate in force on the date.
 */
export function taxLine(input: TaxLineInput): { ok: true; line: TaxLine } | { ok: false; reason: string } {
  const { seller, buyer, item, quantity, unitPrice } = input;
  const discount = input.discount ?? NIL;
  const perUnitSold = input.unitsPerUnitSold ?? new Decimal(1);
  if (!quantity.isFinite() || quantity.lte(0)) return { ok: false, reason: "The quantity must be more than zero." };
  if (!unitPrice.isFinite() || unitPrice.lt(0)) return { ok: false, reason: "The price cannot be negative." };
  if (!discount.isFinite()) return { ok: false, reason: "The discount is not an amount." };
  if (discount.lt(0)) return { ok: false, reason: "The discount cannot be negative." };
  if (!perUnitSold.isFinite() || perUnitSold.lte(0)) return { ok: false, reason: "The size of the unit sold must be more than zero." };
  // What the line comes to at its price, before anything else is known about it.
  const priced = paisa(new Wide(quantity).times(unitPrice));
  const off = paisa(discount);
  if (off.gt(priced)) return { ok: false, reason: "The discount cannot be more than the line." };
  const amount = priced.minus(off);
  const base = { currency: input.currency, extraTaxAmount: NIL };
  const untaxed = { value: amount, rateFrom: null, rate: NIL, taxAmount: NIL, furtherTaxRate: NIL, furtherTaxAmount: NIL, furtherTaxReason: null, retailPriceBase: null, total: amount };

  if (!seller.salesTaxRegistered) {
    return { ok: true, line: { ...base, ...untaxed, taxed: false, categoryId: null, kind: null, saleType: null, sroScheduleNo: null, sroItemSerial: null } };
  }

  const category = item.category ?? input.standardCategory;
  if (!category) return { ok: false, reason: "This company has no standard-rate tax category to fall back on. Set the item's tax category." };
  // An item with no category is charged the standard rate, never whatever happens to be handed in.
  if (item.category === null && category.kind !== "standard") return { ok: false, reason: "The category used for items with none of their own must be a standard-rate one. Set the item's tax category." };
  const described = { ...base, taxed: true, categoryId: category.id, kind: category.kind, saleType: item.saleType ?? DEFAULT_SALE_TYPES[category.kind], sroScheduleNo: category.sroScheduleNo, sroItemSerial: category.sroItemSerial };

  // Exempt goods carry no tax of any kind, whoever buys them, and need no rate to say so.
  if (category.kind === "exempt") return { ok: true, line: { ...described, ...untaxed } };

  const row = taxRateOn(input.rates, category.id, input.date);
  if (!row) return { ok: false, reason: `No tax rate is in force for this item's category on ${input.date.split("-").reverse().join("-")}. Add the rate under Settings, Tax.` };
  // A row that contradicts its category is not obeyed.
  if (category.kind === "zero_rated" && !row.rate.isZero()) return { ok: false, reason: "This item's category is zero-rated but its rate is not nil. Correct the rate under Settings, Tax." };
  if (category.kind !== "zero_rated" && row.rate.lte(0)) return { ok: false, reason: "This item's category has no rate above nil. Correct the rate under Settings, Tax." };

  const reason = row.furtherTaxRate.isZero() ? null : furtherTaxReason(buyer);
  const furtherRate = reason === null ? NIL : row.furtherTaxRate;
  const rated = { ...described, rateFrom: row.effectiveFrom, rate: row.rate, furtherTaxRate: furtherRate, furtherTaxReason: reason };

  if (category.kind === "third_schedule") {
    // Taxed on the retail price, whatever the goods are sold for.
    if (item.retailPrice === null || item.retailPrice.lte(0)) return { ok: false, reason: "This item is taxed on its retail price. Set the retail price on the item." };
    const retailPriceBase = paisa(new Wide(quantity).times(perUnitSold).times(item.retailPrice));
    const taxAmount = paisa(new Wide(retailPriceBase).times(row.rate).div(100));
    if (seller.pricesIncludeTax) {
      // The price is what the buyer pays: the tax is a fixed sum inside it, and further tax shares the rest.
      const afterTax = amount.minus(taxAmount);
      if (afterTax.lt(0)) return { ok: false, reason: "The price is less than the sales tax on the item's retail price." };
      const furtherTaxAmount = paisa(new Wide(afterTax).times(furtherRate).div(new Wide(100).plus(furtherRate)));
      return { ok: true, line: { ...rated, value: afterTax.minus(furtherTaxAmount), taxAmount, furtherTaxAmount, retailPriceBase, total: amount } };
    }
    const furtherTaxAmount = paisa(new Wide(amount).times(furtherRate).div(100));
    return { ok: true, line: { ...rated, value: amount, taxAmount, furtherTaxAmount, retailPriceBase, total: amount.plus(taxAmount).plus(furtherTaxAmount) } };
  }

  // Standard, reduced and zero-rated goods: a percentage of the value.
  if (seller.pricesIncludeTax) {
    // The price already holds the taxes: each is its share of the price, and the value is what is left.
    const whole = new Wide(100).plus(row.rate).plus(furtherRate);
    const taxAmount = paisa(new Wide(amount).times(row.rate).div(whole));
    const furtherTaxAmount = paisa(new Wide(amount).times(furtherRate).div(whole));
    return { ok: true, line: { ...rated, value: amount.minus(taxAmount).minus(furtherTaxAmount), taxAmount, furtherTaxAmount, retailPriceBase: null, total: amount } };
  }
  const taxAmount = paisa(new Wide(amount).times(row.rate).div(100));
  const furtherTaxAmount = paisa(new Wide(amount).times(furtherRate).div(100));
  return { ok: true, line: { ...rated, value: amount, taxAmount, furtherTaxAmount, retailPriceBase: null, total: amount.plus(taxAmount).plus(furtherTaxAmount) } };
}
