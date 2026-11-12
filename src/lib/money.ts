import Decimal from "decimal.js";

// Amounts are decimal.js values and numeric(20,4) columns; never a JS number.

/** Digits after the decimal point that an amount keeps. */
export const AMOUNT_SCALE = 4;

type Parsed = { ok: true; amount: Decimal } | { ok: false; reason: string };

/**
 * Reads an amount as a person types it: plain digits with an optional decimal point, zero or
 * more. No signs, no exponents and no commas, so "5,00,000" is never read as something else.
 */
export function parseAmount(input: unknown): Parsed {
  const text = typeof input === "string" ? input.trim() : "";
  if (text === "") return { ok: false, reason: "Enter the amount." };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: "Enter the amount as a plain number without commas, such as 500000." };
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > AMOUNT_SCALE) return { ok: false, reason: `Use at most ${AMOUNT_SCALE} digits after the point.` };
  if (whole.replace(/^0+/, "").length > 15) return { ok: false, reason: "That amount is too large." };
  return { ok: true, amount: new Decimal(text) };
}

/**
 * An amount for showing, grouped the Pakistani way: the last three digits, then twos (lakh,
 * crore). Two digits after the point, more only when the amount has them. "12,34,567.50".
 */
export function formatAmount(amount: Decimal): string {
  const [whole, fraction = ""] = amount.abs().toFixed(AMOUNT_SCALE).split(".");
  const head = whole.slice(0, -3);
  const grouped = head === "" ? whole : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${whole.slice(-3)}`;
  const decimals = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${amount.isNegative() && !amount.isZero() ? "-" : ""}${grouped}.${decimals}`;
}
