import Decimal from "decimal.js";
import { AMOUNT_SCALE, parseAmount } from "@/lib/money";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";

// Pure rules for prices. No I/O.
//
// A price is for one of the item's own unit, from a date, optionally until a date. Four kinds of
// price can exist for an item, and the one a customer pays is decided in this order:
//
//   1. the customer's own price for the item
//   2. the price for the customer's class
//   3. the price on the customer's price list (or the company's default list when the customer
//      has none)
//   4. the item's default price
//
// The first level that has a price in force on the date wins; a lower level is never mixed in.
// Prices are decimal.js values, never JS numbers.

export const PRICE_SOURCES = ["customer", "class", "list", "item"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const PRICE_SOURCE_LABELS: Record<PriceSource, string> = {
  customer: "This customer's own price",
  class: "Price for the customer's class",
  list: "Price list",
  item: "The item's default price",
};

/** A price with the days it applies: from `validFrom`, to `validTo` inclusive, or open-ended. */
export type DatedPrice = { price: Decimal; validFrom: string; validTo: string | null };

/**
 * The price in force on a date among rows of one level: the one that started latest among those
 * whose days include the date. Dates are YYYY-MM-DD, which sort correctly as text.
 */
export function priceInForce<T extends { validFrom: string; validTo: string | null }>(rows: readonly T[], on: string): T | null {
  let found: T | null = null;
  for (const row of rows) {
    if (row.validFrom <= on && (row.validTo === null || on <= row.validTo) && (found === null || row.validFrom > found.validFrom)) found = row;
  }
  return found;
}

/** Every price that could apply to one item for one customer, already narrowed to that item and customer. */
export type PriceCandidates = {
  /** The customer's own prices for the item. */
  customer: readonly DatedPrice[];
  /** Prices for the customer's class; empty when the customer has no class. */
  class: readonly DatedPrice[];
  /** Prices on the list that applies: the customer's, else the company's default. */
  list: readonly DatedPrice[];
  /** The item's default price, if it has one. */
  itemDefault: Decimal | null;
};

/**
 * The price a customer pays for an item on a date, and where it came from. Null when no level
 * has a price: the caller must ask for one, never guess.
 */
export function resolvePrice(candidates: PriceCandidates, on: string): { price: Decimal; source: PriceSource; validFrom: string | null } | null {
  for (const source of ["customer", "class", "list"] as const) {
    const found = priceInForce(candidates[source], on);
    if (found) return { price: found.price, source, validFrom: found.validFrom };
  }
  return candidates.itemDefault === null ? null : { price: candidates.itemDefault, source: "item", validFrom: null };
}

// ── Reading what a person types ─────────────────────────────────────────────────────────────────

export function readListName(raw: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  const name = cleanText(raw);
  if ([...name].length < 2 || name.length > 60) return { ok: false, reason: "Enter the price list's name, in 2 to 60 characters." };
  return { ok: true, name };
}

export function readClass(raw: unknown): { ok: true; customerClass: string } | { ok: false; reason: string } {
  const customerClass = cleanText(raw);
  if (customerClass === "" || customerClass.length > 40) return { ok: false, reason: "Enter the customer class, such as Wholesale." };
  return { ok: true, customerClass };
}

/** A price with its dates as typed: the price as exact text, the start date, and an optional last day. */
export function readDatedPrice(raw: { price?: unknown; validFrom?: unknown; validTo?: unknown }): { ok: true; price: string; validFrom: string; validTo: string | null } | { ok: false; reason: string } {
  const parsed = parseAmount(raw.price);
  if (!parsed.ok) return { ok: false, reason: `Price: ${parsed.reason}` };
  if (!isIsoDate(raw.validFrom)) return { ok: false, reason: "Enter the date the price applies from." };
  const until = cleanText(raw.validTo);
  if (until !== "" && !isIsoDate(until)) return { ok: false, reason: "Enter the last day the price applies, or leave it empty." };
  if (until !== "" && until < raw.validFrom) return { ok: false, reason: "The last day cannot be before the first." };
  return { ok: true, price: parsed.amount.toFixed(AMOUNT_SCALE), validFrom: raw.validFrom, validTo: until === "" ? null : until };
}
