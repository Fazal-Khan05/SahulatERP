import Decimal from "decimal.js";
import { parseAmount } from "@/lib/money";
import { formatIsoDate, isIsoDate } from "@/modules/currencies/rules";
import type { ReportRow, ReportTable } from "@/modules/reports/rules";

// Pure rules for recovery (Step 33): ageing what customers owe, promises to pay, and the customer
// statement. No I/O.
//
// What a customer owes comes from one place, app.receivables_open (Step 32): every open invoice
// with its due date and what is still outstanding on it. The overdue list and the aged
// receivables report are both built from the same rows by ageOpenItems, so they cannot disagree.

const ZERO = new Decimal(0);
const sum = (values: readonly Decimal[]) => values.reduce((total, value) => total.plus(value), ZERO);

/** Whole days from one ISO date to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000);
}

// ── Ageing ──────────────────────────────────────────────────────────────────────────────────────

/** The founder's bands (2026-11-14): by days past the due date. */
export const OVERDUE_BANDS = [
  { label: "Not due yet", upTo: 0 },
  { label: "1-30 days", upTo: 30 },
  { label: "31-60 days", upTo: 60 },
  { label: "61-90 days", upTo: 90 },
  { label: "Over 90 days", upTo: null },
] as const;

/** An open invoice (or opening balance) as app.receivables_open gives it. */
export type OpenItem = { kind: "invoice" | "opening"; id: string; number: string | null; date: string; dueDate: string; total: Decimal; settled: Decimal; outstanding: Decimal };

export type CustomerAgeing = {
  customerId: string;
  code: string | null;
  name: string;
  /** What is outstanding in each band, in the order of OVERDUE_BANDS. */
  bands: Decimal[];
  total: Decimal;
  /** Everything past its due date: every band but the first. */
  overdue: Decimal;
  /** Days past due of the oldest overdue item; 0 when nothing is overdue. */
  oldestDays: number;
};

const bandOf = (daysPastDue: number) => OVERDUE_BANDS.findIndex((band) => band.upTo === null || daysPastDue <= band.upTo);

/** One customer's open items, aged by days past the due date as at `today`. */
export function ageOpenItems(customer: { customerId: string; code: string | null; name: string }, items: readonly Pick<OpenItem, "dueDate" | "outstanding">[], today: string): CustomerAgeing {
  const bands = OVERDUE_BANDS.map(() => ZERO);
  let oldestDays = 0;
  for (const item of items) {
    if (!item.outstanding.gt(0)) continue;
    const days = daysBetween(item.dueDate, today);
    const band = bandOf(days);
    bands[band] = bands[band].plus(item.outstanding);
    if (days > oldestDays) oldestDays = days;
  }
  return { ...customer, bands, total: sum(bands), overdue: sum(bands.slice(1)), oldestDays };
}

/** The overdue customers: those with anything past due, most overdue first. */
export function overdueCustomers(rows: readonly CustomerAgeing[]): CustomerAgeing[] {
  return rows.filter((row) => row.overdue.gt(0)).sort((a, b) => b.overdue.comparedTo(a.overdue) || b.oldestDays - a.oldestDays || a.name.localeCompare(b.name));
}

/** The aged receivables report: every customer who owes anything, by name, with a total row. */
export function ageingTable(rows: readonly CustomerAgeing[], today: string): ReportTable {
  const owing = rows.filter((row) => row.total.gt(0)).sort((a, b) => a.name.localeCompare(b.name));
  const cell = (amount: Decimal) => (amount.isZero() ? null : amount);
  return {
    title: "Aged receivables",
    period: `As at ${formatIsoDate(today)}, by days past the due date`,
    columns: [
      { label: "Code", numeric: false },
      { label: "Customer", numeric: false },
      ...OVERDUE_BANDS.map((band) => ({ label: band.label, numeric: true })),
      { label: "Total", numeric: true },
    ],
    rows: [
      ...owing.map((row): ReportRow => ({ kind: "line", depth: 0, cells: [row.code ?? "", row.name, ...row.bands.map(cell), row.total] })),
      { kind: "grand", depth: 0, cells: ["", "Total", ...OVERDUE_BANDS.map((_, at) => sum(owing.map((row) => row.bands[at]))), sum(owing.map((row) => row.total))] },
    ],
    notes: [
      "What is still owed on each posted invoice and opening balance. Money received but not yet set against an invoice (an advance) is not taken off here.",
    ],
  };
}

// ── Promises to pay ─────────────────────────────────────────────────────────────────────────────

export type PromiseState = "waiting" | "kept" | "broken";
export const PROMISE_LABELS: Record<PromiseState, string> = { waiting: "Waiting", kept: "Kept", broken: "Broken" };

/**
 * The founder's rule (2026-11-14): a promise is broken when, by the day promised, less than the
 * promised amount has arrived since the day it was made. Paid in full, it is kept, even early.
 * Until the day has passed it is waiting.
 */
export function promiseState(promise: { amount: Decimal; promisedOn: string }, received: Decimal, today: string): PromiseState {
  if (received.gte(promise.amount)) return "kept";
  return today > promise.promisedOn ? "broken" : "waiting";
}

// ── What a member types ─────────────────────────────────────────────────────────────────────────

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export type FollowUpDraft = { note: string; nextOn: string | null };

/** A follow-up: what was said, and when to ask again (today or later, or not at all). */
export function readFollowUp(raw: { note?: unknown; nextOn?: unknown }, today: string): { ok: true; draft: FollowUpDraft } | { ok: false; reason: string } {
  const note = text(raw.note);
  if (note === "") return { ok: false, reason: "Write what was said." };
  if (note.length > 1000) return { ok: false, reason: "Keep the note under 1,000 characters." };
  const next = text(raw.nextOn);
  if (next === "") return { ok: true, draft: { note, nextOn: null } };
  if (!isIsoDate(next)) return { ok: false, reason: "Give the next follow-up as a date." };
  if (next < today) return { ok: false, reason: "The next follow-up cannot be in the past." };
  return { ok: true, draft: { note, nextOn: next } };
}

export type PromiseDraft = { amount: Decimal; promisedOn: string; note: string | null };

/** A promise: an amount in rupees and paisa, by a day that is today or later. */
export function readPromise(raw: { amount?: unknown; promisedOn?: unknown; note?: unknown }, today: string): { ok: true; draft: PromiseDraft } | { ok: false; reason: string } {
  const amount = parseAmount(raw.amount);
  if (!amount.ok) return amount;
  if (!amount.amount.gt(0)) return { ok: false, reason: "The amount promised must be more than nothing." };
  if (!amount.amount.eq(amount.amount.toDecimalPlaces(2))) return { ok: false, reason: "Give the amount to the paisa: at most two digits after the point." };
  const promisedOn = text(raw.promisedOn);
  if (!isIsoDate(promisedOn)) return { ok: false, reason: "Give the day the customer promised to pay by." };
  if (promisedOn < today) return { ok: false, reason: "A promise is for today or a day to come." };
  const note = text(raw.note);
  if (note.length > 500) return { ok: false, reason: "Keep the note under 500 characters." };
  return { ok: true, draft: { amount: amount.amount, promisedOn, note: note === "" ? null : note } };
}

// ── The customer statement ──────────────────────────────────────────────────────────────────────

const SOURCE_WORDS: Record<string, string> = {
  sales_invoice: "Invoice",
  credit_note: "Credit note",
  receipt: "Received",
  cheque_return: "Cheque returned",
  advance_application: "Advance set against invoices",
  opening_balance: "Opening balance",
  credit_note: "Credit note (goods returned)",
  manual_journal: "Journal entry",
};

/** A line of the customer's receivables account, as app.customer_statement gives it. */
export type StatementLine = { date: string; writtenAt: Date; sourceType: string; number: string | null; debit: Decimal; credit: Decimal };

export type StatementRow = { date: string; what: string; number: string | null; debit: Decimal; credit: Decimal; balance: Decimal };
export type Statement = { opening: Decimal; rows: StatementRow[]; closing: Decimal; debits: Decimal; credits: Decimal };

/**
 * The statement for a period: what the customer owed before it, each line with the balance after
 * it, and what they owe at its end. A balance below nothing means the customer has paid ahead.
 */
export function buildStatement(opening: { debit: Decimal; credit: Decimal }, lines: readonly StatementLine[]): Statement {
  const start = opening.debit.minus(opening.credit);
  let balance = start;
  const sorted = [...lines].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.writtenAt.getTime() - b.writtenAt.getTime()));
  const rows = sorted.map((line) => {
    balance = balance.plus(line.debit).minus(line.credit);
    // A cheque that bounces before it clears, or a receipt cancelled, is taken back by reversing the receipt's entry.
    const what = line.sourceType === "reversal" ? (line.debit.gt(0) ? "Receipt taken back" : "Entry reversed") : (SOURCE_WORDS[line.sourceType] ?? "Entry");
    return { date: line.date, what, number: line.number, debit: line.debit, credit: line.credit, balance };
  });
  return { opening: start, rows, closing: balance, debits: sum(rows.map((row) => row.debit)), credits: sum(rows.map((row) => row.credit)) };
}

/** A statement's period from the address: the first of this month to today when none is given; a period the wrong way round is turned round. */
export function readPeriod(raw: { from?: unknown; to?: unknown }, today: string): { from: string; to: string } {
  const one = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const to = isIsoDate(one(raw.to)) ? (one(raw.to) as string) : today;
  let from = isIsoDate(one(raw.from)) ? (one(raw.from) as string) : `${to.slice(0, 8)}01`;
  if (from > to) from = to;
  return { from, to };
}
