import Decimal from "decimal.js";
import { readBankAmount, readBankDate } from "@/modules/bank-reconciliation/rules";
import { readRupees, type Expense } from "@/modules/cash-bank/rules";
import { isIsoDate } from "@/modules/currencies/rules";

// Daily expenses: what is typed on the quick form or in a sheet, cleaned, or what is wrong with
// it in plain words. No I/O. An entry becomes an ordinary expense of one line (toExpense), which
// the cash and bank module records.

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const tidy = (value: unknown) => text(value).replace(/\s+/g, " ");

/** Said on the quick form and the upload page: a daily expense withholds nothing. */
export const NOTHING_WITHHELD = "No tax is withheld on a daily expense. When tax must be withheld from a supplier, record it under Cash and bank, Expenses, New expense.";

export const MAX_NOTE = 200;

export type RawDailyExpense = { date?: unknown; whatForId?: unknown; amount?: unknown; paidFromId?: unknown; paidTo?: unknown; note?: unknown; branchId?: unknown };
export type DailyExpense = { date: string; whatForId: string; amount: Decimal; paidFromId: string; paidTo: string | null; note: string | null; branchId: string | null };

/** One entry of the quick form: the day, what it was for, how much, and the account it was paid from. Who was paid and a note are optional. */
export function readDailyExpense(raw: RawDailyExpense, today: string): { ok: true; expense: DailyExpense } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date." };
  if (raw.date > today) return { ok: false, reason: "That date has not come yet." };
  const whatForId = text(raw.whatForId);
  if (whatForId === "") return { ok: false, reason: "Choose what it was for." };
  const amount = readRupees(raw.amount);
  if (!amount.ok) return amount;
  const paidFromId = text(raw.paidFromId);
  if (paidFromId === "") return { ok: false, reason: "Choose the cash or bank account it was paid from." };
  const paidTo = tidy(raw.paidTo);
  if (paidTo !== "" && (paidTo.length < 2 || paidTo.length > 120)) return { ok: false, reason: "Who was paid: from 2 to 120 characters, or leave it empty." };
  const note = tidy(raw.note);
  if (note.length === 1) return { ok: false, reason: "The note: use at least 2 characters, or leave it empty." };
  if (note.length > MAX_NOTE) return { ok: false, reason: `The note: use at most ${MAX_NOTE} characters.` };
  const branchId = text(raw.branchId);
  return { ok: true, expense: { date: raw.date, whatForId, amount: amount.amount, paidFromId, paidTo: paidTo || null, note: note || null, branchId: branchId || null } };
}

/**
 * The expense a daily entry is: one line charged to the account chosen, described by the note or,
 * without one, by the account's name; paid to whoever was named or to nobody; nothing withheld.
 */
export function toExpense(entry: DailyExpense, whatForName: string): Expense {
  return {
    date: entry.date,
    accountId: entry.paidFromId,
    supplierId: null,
    payee: entry.paidTo,
    branchId: entry.branchId,
    reference: null,
    memo: null,
    incomeTaxCode: null,
    provincialTaxCode: null,
    lines: [{ accountId: entry.whatForId, description: entry.note ?? whatForName, amount: entry.amount }],
  };
}

// ── The list, day by day ────────────────────────────────────────────────────────────────────────

/** The most days the list shows at once. */
export const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;

const addDays = (iso: string, days: number) => {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

/**
 * The days the list covers: the thirty up to today unless others are asked for. A day that has
 * not come is today; the two the wrong way round are swapped; more than a year is cut to a year
 * ending on the last day asked for.
 */
export function readRange(from: unknown, to: unknown, today: string): { from: string; to: string; asked: boolean } {
  const asked = isIsoDate(from) || isIsoDate(to);
  let last = isIsoDate(to) && to <= today ? to : today;
  let first = isIsoDate(from) ? (from > today ? today : from) : addDays(last, -(DEFAULT_RANGE_DAYS - 1));
  if (first > last) [first, last] = [last, first];
  if (first < addDays(last, -(MAX_RANGE_DAYS - 1))) first = addDays(last, -(MAX_RANGE_DAYS - 1));
  return { from: first, to: last, asked };
}

export type DayOf<Row> = { date: string; rows: Row[]; total: Decimal; count: number };

/** Rows that arrive newest day first, put under their days, each day with what was spent on it: cancelled expenses are listed and not counted. */
export function groupByDay<Row extends { date: string; total: Decimal; status: "posted" | "cancelled" }>(rows: readonly Row[]): DayOf<Row>[] {
  const days: DayOf<Row>[] = [];
  for (const row of rows) {
    let day = days.at(-1);
    if (!day || day.date !== row.date) {
      day = { date: row.date, rows: [], total: new Decimal(0), count: 0 };
      days.push(day);
    }
    day.rows.push(row);
    if (row.status === "posted") {
      day.total = day.total.plus(row.total);
      day.count += 1;
    }
  }
  return days;
}

// ── A sheet of expenses ─────────────────────────────────────────────────────────────────────────

/** The columns of the sheet, in the template's order. The first four must be there; who was paid and a note may be left out. */
export const SHEET_COLUMNS = ["Date", "What for", "Amount", "Paid from", "Paid to", "Note"] as const;
const NEEDED = 4;
/** The most expenses one sheet enters. */
export const MAX_SHEET_EXPENSES = 200;

export type NamedAccount = { id: string; code: string; name: string };
/** A row of the sheet as it was typed, with its row number in the sheet. */
export type SheetCells = { row: number; date: string; whatFor: string; amount: string; paidFrom: string; paidTo: string; note: string };
export type SheetRow = SheetCells & {
  /** What is wrong with the row, in words; empty when it can be entered. */
  problems: string[];
  /** The entry it would make, when nothing is wrong. */
  expense: DailyExpense | null;
  /** The accounts it was matched to, by name, for the preview. */
  whatForName: string | null;
  paidFromName: string | null;
};
export type ReadSheet = { ok: true; rows: SheetRow[] } | { ok: false; reason: string };

const same = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/** The account a cell names: by its name, its code, or the two together as the chart shows them. */
export function matchAccount(typed: string, accounts: readonly NamedAccount[]): NamedAccount | "none" | "several" {
  const wanted = same(typed);
  const found = accounts.filter((a) => same(a.name) === wanted || same(a.code) === wanted || same(`${a.code} ${a.name}`) === wanted);
  return found.length === 1 ? found[0] : found.length === 0 ? "none" : "several";
}

/** The cells of the sheet under their headings; a file that is not such a sheet says so. */
export function readSheetCells(rows: readonly (readonly string[])[]): { ok: true; cells: SheetCells[] } | { ok: false; reason: string } {
  const headAt = rows.findIndex((row) => row.some((cell) => cell.trim() !== ""));
  const template = `The first row must name the columns: ${SHEET_COLUMNS.join(", ")}. Download the template to see it.`;
  if (headAt === -1) return { ok: false, reason: "The file is empty." };
  const head = rows[headAt].map(same);
  const at = SHEET_COLUMNS.map((name) => head.indexOf(same(name)));
  if (at.slice(0, NEEDED).some((index) => index === -1)) return { ok: false, reason: template };
  const cell = (row: readonly string[], column: number) => (at[column] === -1 ? "" : (row[at[column]] ?? "").trim().replace(/\s+/g, " "));
  const cells: SheetCells[] = [];
  for (let r = headAt + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.some((value) => value.trim() !== "")) continue;
    cells.push({ row: r + 1, date: cell(row, 0), whatFor: cell(row, 1), amount: cell(row, 2), paidFrom: cell(row, 3), paidTo: cell(row, 4), note: cell(row, 5) });
  }
  if (cells.length === 0) return { ok: false, reason: "The sheet has its headings and no expenses under them." };
  if (cells.length > MAX_SHEET_EXPENSES) return { ok: false, reason: `The sheet has ${cells.length} expenses. Enter at most ${MAX_SHEET_EXPENSES} at a time.` };
  return { ok: true, cells };
}

/**
 * Each row of the sheet checked: the day (day first, as in Pakistan, or as Excel keeps a day),
 * the account it was for and the account it was paid from, by name or code, and the amount.
 * Every problem of every row is said, so the sheet is put right in one go.
 */
export function checkSheet(cells: readonly SheetCells[], accounts: { expense: readonly NamedAccount[]; money: readonly NamedAccount[] }, today: string, branchId: string | null): SheetRow[] {
  return cells.map((c) => {
    const problems: string[] = [];
    const date = c.date === "" ? null : readBankDate(c.date);
    if (c.date === "") problems.push("The date is missing.");
    else if (date === null) problems.push(`"${c.date}" is not a date. Write it as 26/11/2026 or 2026-11-26.`);
    else if (date > today) problems.push("That date has not come yet.");
    const whatFor = c.whatFor === "" ? null : matchAccount(c.whatFor, accounts.expense);
    if (whatFor === null) problems.push("What it was for is missing.");
    else if (whatFor === "none") problems.push(`No expense account is called "${c.whatFor}". Use a name from the list on this page.`);
    else if (whatFor === "several") problems.push(`More than one expense account is called "${c.whatFor}". Write its code instead.`);
    const amount = c.amount === "" ? null : readBankAmount(c.amount);
    let rupees: Decimal | null = null;
    if (c.amount === "" || amount === null) problems.push("The amount is missing.");
    else if (amount === "bad" || amount.lte(0) || amount.decimalPlaces() > 2 || amount.gte(1e12)) problems.push(`"${c.amount}" is not an amount. Write rupees above nothing, such as 500 or 1,250.50.`);
    else rupees = amount;
    const paidFrom = c.paidFrom === "" ? null : matchAccount(c.paidFrom, accounts.money);
    if (paidFrom === null) problems.push("The cash or bank account it was paid from is missing.");
    else if (paidFrom === "none") problems.push(`No cash or bank account is called "${c.paidFrom}". Use a name from the list on this page.`);
    else if (paidFrom === "several") problems.push(`More than one cash or bank account is called "${c.paidFrom}". Write its code instead.`);
    if (c.paidTo !== "" && (c.paidTo.length < 2 || c.paidTo.length > 120)) problems.push("Who was paid: from 2 to 120 characters, or leave it empty.");
    if (c.note.length === 1) problems.push("The note: use at least 2 characters, or leave it empty.");
    if (c.note.length > MAX_NOTE) problems.push(`The note: use at most ${MAX_NOTE} characters.`);
    const matchedFor = whatFor !== null && typeof whatFor === "object" ? whatFor : null;
    const matchedFrom = paidFrom !== null && typeof paidFrom === "object" ? paidFrom : null;
    const whole = problems.length === 0 && date !== null && matchedFor !== null && matchedFrom !== null && rupees !== null;
    return {
      ...c,
      problems,
      expense: whole ? { date: date!, whatForId: matchedFor!.id, amount: rupees!, paidFromId: matchedFrom!.id, paidTo: c.paidTo || null, note: c.note || null, branchId } : null,
      whatForName: matchedFor?.name ?? null,
      paidFromName: matchedFrom?.name ?? null,
    };
  });
}
