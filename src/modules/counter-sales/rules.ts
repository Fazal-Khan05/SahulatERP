import { isIsoDate } from "@/modules/currencies/rules";
import { readDraft, type Draft, type RawDocument } from "@/modules/sales/rules";

// Step 22: what is typed for a sale at the counter, cleaned, or the first thing that is wrong in
// plain words. The goods are read as a sales order's lines are; the buyer and the payment are
// the counter's own.

export type RawCounterSale = {
  date?: unknown;
  warehouseId?: unknown;
  buyerName?: unknown;
  buyerPhone?: unknown;
  notes?: unknown;
  furtherTaxExcluded?: unknown;
  lines?: RawDocument["lines"];
  shares?: RawDocument["shares"];
  /** cash, or bank: a transfer or a card, into one of the company's bank accounts. */
  method?: unknown;
  accountId?: unknown;
  reference?: unknown;
};

export type CounterSale = {
  /** The goods, as an order's draft; its customer is filled in with the walk-in customer when the sale is made. */
  order: Omit<Draft, "customerId">;
  buyer: { name: string; phone: string | null };
  payment: { method: "cash" | "bank"; accountId: string; reference: string | null };
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
/** Spaces run together and trimmed, as the database keeps a name. */
const tidy = (value: unknown) => text(value).replace(/\s+/g, " ");

/** A phone number as the database keeps it: digits, spaces and dashes, perhaps with + in front. */
export const PHONE_PATTERN = /^\+?[0-9][0-9 -]{5,18}[0-9]$/;

export function readCounterSale(raw: RawCounterSale, today: string): { ok: true; sale: CounterSale } | { ok: false; reason: string } {
  if (isIsoDate(raw.date) && raw.date > today) return { ok: false, reason: "A counter sale is recorded on the day of the sale or later, never before it." };
  const name = tidy(raw.buyerName);
  // Counted as the database counts: in characters, not in the code units JavaScript keeps.
  if ([...name].length < 2) return { ok: false, reason: "Enter the buyer's name." };
  if ([...name].length > 120) return { ok: false, reason: "The buyer's name: use at most 120 characters." };
  const phone = tidy(raw.buyerPhone);
  if (phone !== "" && !PHONE_PATTERN.test(phone)) return { ok: false, reason: "Enter the buyer's phone as digits, such as 0300 1234567, or leave it empty." };
  // The walk-in customer is named when the sale is made; any text here passes the reader's own check.
  const read = readDraft({ kind: "order", date: raw.date, validUntil: "", customerId: "walk-in", warehouseId: raw.warehouseId, customerReference: "", notes: raw.notes, furtherTaxExcluded: raw.furtherTaxExcluded, lines: raw.lines, shares: raw.shares });
  if (!read.ok) return read;
  if (read.draft.lines.length === 0) return { ok: false, reason: "Enter at least one line: what the buyer took." };
  if (raw.method !== "cash" && raw.method !== "bank") return { ok: false, reason: "Choose how the buyer paid: in cash, or into a bank account." };
  const accountId = text(raw.accountId);
  if (accountId === "") return { ok: false, reason: raw.method === "cash" ? "Choose the cash account the money went into." : "Choose the bank account the money went into." };
  const reference = tidy(raw.reference);
  if (reference.length > 60) return { ok: false, reason: "Use at most 60 characters for the payment's reference." };
  const { kind, date, validUntil, warehouseId, customerReference, notes, furtherTaxExcluded, lines, shares } = read.draft;
  const order = { kind, date, validUntil, warehouseId, customerReference, notes, furtherTaxExcluded, lines, shares };
  return {
    ok: true,
    sale: { order, buyer: { name, phone: phone === "" ? null : phone }, payment: { method: raw.method, accountId, reference: reference === "" ? null : reference } },
  };
}
