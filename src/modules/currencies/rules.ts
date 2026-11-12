import Decimal from "decimal.js";
import { z } from "zod";

// Pure rules for currencies and exchange rates. No I/O.
//
// A company has one base currency, chosen once and never changed, and any number of foreign
// currencies. A rate says how many units of the base currency one unit of a foreign currency is
// worth, from a given date until the next rate. Rates are decimal.js values, never JS numbers.

/** Digits after the decimal point that a rate keeps; the column is numeric(20,8). */
export const RATE_SCALE = 8;

export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z]{3}$/, "Use the three-letter code, such as USD."));

export const currencyNameSchema = z
  .string()
  .trim()
  .min(2, "Enter the currency's name.")
  .max(60, "Use at most 60 characters.");

export const rateSourceSchema = z
  .string()
  .trim()
  .min(1, "Say where the rate comes from, such as the bank's name.")
  .max(60, "Use at most 60 characters.");

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Reads a rate as a person types it. Plain digits with an optional decimal point: no signs, no
 * exponents, no thousands separators, so "1,234" is never silently read as something else.
 */
export function parseRate(input: unknown): { ok: true; rate: Decimal } | { ok: false; reason: string } {
  const text = typeof input === "string" ? input.trim() : "";
  if (text === "") return { ok: false, reason: "Enter the rate." };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: "Enter the rate as a plain number, such as 278.5." };
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > RATE_SCALE) return { ok: false, reason: `Use at most ${RATE_SCALE} digits after the point.` };
  if (whole.replace(/^0+/, "").length > 12) return { ok: false, reason: "That rate is too large." };
  const rate = new Decimal(text);
  if (rate.lte(0)) return { ok: false, reason: "The rate must be more than zero." };
  return { ok: true, rate };
}

/**
 * The rate in force on a date: the latest one dated on or before it, or null when every rate is
 * later. Dates are YYYY-MM-DD, which sort correctly as text.
 */
export function rateInForce<T extends { date: string }>(rates: readonly T[], on: string): T | null {
  let found: T | null = null;
  for (const rate of rates) {
    if (rate.date <= on && (found === null || rate.date > found.date)) found = rate;
  }
  return found;
}

/** A rate for showing: no exponent, no trailing zeros, at least two digits after the point. */
export function formatRate(rate: Decimal): string {
  const [whole, fraction = ""] = rate.toFixed(RATE_SCALE).split(".");
  return `${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

/** YYYY-MM-DD shown as DD-MM-YYYY. */
export function formatIsoDate(date: string): string {
  return date.split("-").reverse().join("-");
}
