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
