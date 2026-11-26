import Decimal from "decimal.js";
import { readRupees } from "@/modules/cash-bank/rules";
import { isIsoDate } from "@/modules/currencies/rules";

// Money in and money out (batch A): what is typed, cleaned, or the first thing that is wrong in
// plain words; and which accounts the other side may be, as the database decides it
// (app.money_in_out_other_account in drizzle/0049_money_in_out.sql), so a form offers only those.

export type Direction = "in" | "out";
export const isDirection = (value: unknown): value is Direction => value === "in" || value === "out";

export const WORDS: Record<Direction, { title: string; party: string; account: string; other: string; record: string; list: string }> = {
  in: { title: "Money in", party: "Received from", account: "Into", other: "What it is", record: "Record money in", list: "Money in" },
  out: { title: "Money out", party: "Paid to", account: "Out of", other: "What it is", record: "Record money out", list: "Money out" },
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const tidy = (value: unknown) => text(value).replace(/\s+/g, " ");

export type RawMoneyInOut = { direction?: unknown; date?: unknown; moneyAccountId?: unknown; otherAccountId?: unknown; amount?: unknown; party?: unknown; reference?: unknown; memo?: unknown };
export type MoneyInOut = { direction: Direction; date: string; moneyAccountId: string; otherAccountId: string; amount: Decimal; party: string; reference: string | null; memo: string | null };

export function readMoneyInOut(raw: RawMoneyInOut, today: string): { ok: true; entry: MoneyInOut } | { ok: false; reason: string } {
  if (!isDirection(raw.direction)) return { ok: false, reason: "Choose whether the money came in or went out." };
  const direction = raw.direction;
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date." };
  if (raw.date > today) return { ok: false, reason: "That date has not come yet." };
  const moneyAccountId = text(raw.moneyAccountId);
  if (moneyAccountId === "") return { ok: false, reason: direction === "in" ? "Choose the cash or bank account the money came into." : "Choose the cash or bank account the money went out of." };
  const otherAccountId = text(raw.otherAccountId);
  if (otherAccountId === "") return { ok: false, reason: "Choose what the money is, such as Owner's capital, a loan, Drawings or Other income." };
  if (otherAccountId === moneyAccountId) return { ok: false, reason: "Money moved between two cash or bank accounts is a transfer." };
  const amount = readRupees(raw.amount);
  if (!amount.ok) return amount;
  const party = tidy(raw.party);
  // Counted as the database counts: in characters.
  if ([...party].length < 2) return { ok: false, reason: direction === "in" ? "Say who the money came from." : "Say who the money went to." };
  if ([...party].length > 120) return { ok: false, reason: "From or to whom: use at most 120 characters." };
  const reference = tidy(raw.reference);
  if ([...reference].length > 60) return { ok: false, reason: "The reference: use at most 60 characters." };
  const memo = tidy(raw.memo);
  if ([...memo].length > 300) return { ok: false, reason: "The note: use at most 300 characters." };
  return { ok: true, entry: { direction, date: raw.date, moneyAccountId, otherAccountId, amount: amount.amount, party, reference: reference || null, memo: memo || null } };
}

export type AccountFacts = { type: "asset" | "liability" | "equity" | "income" | "expense"; isGroup: boolean; isControl: boolean; controlType: string | null; archived: boolean };

/**
 * Whether an account may be the other side of money in or out: one that takes postings, in use, not
 * a control account (receivables, payables, stock, tax, cash and bank are kept by their own
 * documents), and for money out not an expense, which has a form of its own.
 */
export function otherSideAllowed(account: AccountFacts, direction: Direction): boolean {
  if (account.isGroup || account.archived || account.isControl || account.controlType !== null) return false;
  return direction === "in" || account.type !== "expense";
}
