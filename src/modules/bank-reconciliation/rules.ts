import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { parseCsv } from "@/lib/csv";
import { isIsoDate } from "@/modules/currencies/rules";

// Step 35: reading a bank's statement file, matching it with the books, and the reconciliation's
// figures. Pure rules: no database here.

const ZERO = new Decimal(0);

// ── Reading the bank's file ─────────────────────────────────────────────────────────────────────

/** What a column of a statement is for. */
export type Role = "date" | "description" | "reference" | "out" | "in" | "amount" | "balance";

/**
 * How a file is read: by the names the bank's export gives its columns. HBL, Meezan and UBL are
 * read by the names their internet banking exports use (as known on 2026-11-18, to be confirmed
 * against a real file of each: docs/later/step-35.md); "auto" knows all of them; "columns" is the
 * company's own naming of each column, for any other bank.
 */
export const LAYOUTS = ["auto", "hbl", "meezan", "ubl", "columns"] as const;
export type Layout = (typeof LAYOUTS)[number];
export const LAYOUT_LABELS: Record<Layout, string> = {
  auto: "Read the columns by their names",
  hbl: "HBL",
  meezan: "Meezan Bank",
  ubl: "UBL",
  columns: "Name the columns yourself",
};
export const isLayout = (value: unknown): value is Layout => typeof value === "string" && (LAYOUTS as readonly string[]).includes(value);

type Names = Partial<Record<Role, readonly string[]>>;
const KNOWN: Record<Exclude<Layout, "columns">, Names> = {
  hbl: {
    date: ["transaction date", "txn date", "date"],
    description: ["transaction details", "narration", "description"],
    reference: ["cheque no", "cheque number", "instrument no"],
    out: ["debit", "withdrawal"],
    in: ["credit", "deposit"],
    balance: ["balance", "running balance"],
  },
  meezan: {
    date: ["date", "transaction date"],
    description: ["description", "narration", "particulars"],
    reference: ["cheque no", "chq no", "cheque number"],
    out: ["debit", "withdrawal"],
    in: ["credit", "deposit"],
    balance: ["balance"],
  },
  ubl: {
    date: ["txn date", "transaction date", "date"],
    description: ["particulars", "description", "narration"],
    reference: ["instrument no", "cheque no", "ref no"],
    out: ["withdrawal", "withdrawals", "debit"],
    in: ["deposit", "deposits", "credit"],
    balance: ["balance"],
  },
  auto: {
    date: ["transaction date", "txn date", "tran date", "posting date", "date", "value date"],
    description: ["transaction details", "description", "narration", "particulars", "details", "remarks"],
    reference: ["cheque no", "cheque number", "chq no", "instrument no", "instrument number", "reference", "ref no", "ref"],
    out: ["debit", "withdrawal", "withdrawals", "debit amount", "paid out", "dr"],
    in: ["credit", "deposit", "deposits", "credit amount", "paid in", "cr"],
    amount: ["amount", "transaction amount"],
    balance: ["balance", "running balance", "available balance"],
  },
};

/** The company's own naming of a file's columns: each role to the heading in the file. */
export type ColumnNames = Partial<Record<Role, string>>;

const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const blank = (value: string | undefined) => value === undefined || value.replace(/[\s​-‍⁠﻿]/g, "") === "";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A day as a bank writes it: 05/11/2026 or 05-11-2026 (day first, as in Pakistan), 05-Nov-2026,
 * 5 Nov 2026, 05/11/26, 2026-11-05, or an Excel day number. Null when it is none of these.
 */
export function readBankDate(input: string): string | null {
  const text = input.trim();
  let year: number, month: number, day: number;
  let m: RegExpMatchArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text))) [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text))) [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3].length === 2 ? `20${m[3]}` : m[3])];
  else if ((m = /^(\d{1,2})[\s/.-]([A-Za-z]{3,9})[\s/.,-]*(\d{2}|\d{4})$/.exec(text))) {
    const at = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (at === -1) return null;
    [day, month, year] = [Number(m[1]), at + 1, Number(m[3].length === 2 ? `20${m[3]}` : m[3])];
  } else if ((m = /^(\d{5})$/.exec(text)) && Number(m[1]) > 30000 && Number(m[1]) < 80000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Number(m[1]) * 86_400_000);
    [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  } else return null;
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * An amount as a bank writes it: 1,234.56, (1,234.56) or -1,234.56 for less than nil, with Cr or
 * Dr after it, Rs before it. Blank or a dash is nothing (null); anything else that is not an
 * amount is "bad".
 */
export function readBankAmount(input: string | undefined): Decimal | null | "bad" {
  if (blank(input) || /^\s*-+\s*$/.test(input!)) return null;
  let text = input!.trim().replace(/^(rs\.?|pkr)\s*/i, "");
  let sign = 1;
  if (/^\(.*\)$/.test(text)) [text, sign] = [text.slice(1, -1), -1];
  const side = /\s*(cr|dr)\.?$/i.exec(text);
  if (side) {
    text = text.slice(0, side.index);
    if (side[1].toLowerCase() === "dr") sign = -sign;
  }
  text = text.replace(/,/g, "").replace(/\s/g, "");
  if (!/^-?\d+(\.\d{1,4})?$/.test(text)) return "bad";
  return new Decimal(text).times(sign);
}

export type StatementLine = { row: number; date: string; description: string; reference: string | null; amount: Decimal; balance: Decimal | null; fingerprint: string };
export type ReadStatement =
  | { ok: true; lines: StatementLine[]; opening: Decimal | null; closing: Decimal | null; from: string; to: string }
  | { ok: false; problems: string[] };

const OPENING = /opening balance|balance b\/?f|brought forward|balance forward/i;
const CLOSING = /closing balance|balance c\/?f|carried forward|total/i;
export const MAX_STATEMENT_LINES = 5000;

/**
 * A statement read from a bank's CSV file. The heading row is found wherever it is (a bank's
 * file often starts with the account's name and the period); each line needs a day and money in
 * or out, from a Debit and a Credit column or one Amount column (money out less than nil). A line
 * without money that says it is the opening or the closing balance gives that balance. Lines are
 * put oldest first. When the file gives a running balance, every line must follow from the one
 * before: a file read with its columns mixed up is refused, not imported. Nothing is imported when
 * anything is wrong; up to twenty problems are given, each with its row.
 */
export function readStatement(csv: string, layout: Layout, columns: ColumnNames = {}): ReadStatement {
  if (csv.includes("�")) return { ok: false, problems: ['The file is not saved as UTF-8. In Excel, save it as "CSV UTF-8 (Comma delimited)" and import it again.'] };
  const parsed = parseCsv(csv);
  if (!parsed.ok) return { ok: false, problems: [parsed.reason] };
  const names: Names =
    layout === "columns"
      ? Object.fromEntries(Object.entries(columns).filter(([, heading]) => !blank(heading)).map(([role, heading]) => [role, [heading!]]))
      : KNOWN[layout];
  if (layout === "columns" && (!names.date || !names.description || !(names.amount || names.out || names.in))) {
    return { ok: false, problems: ["Name the columns that hold the day, the description, and the money (a Debit and a Credit column, or one Amount column)."] };
  }
  // The heading row: the first that names a day column and money columns.
  let headingAt = -1;
  let at: Partial<Record<Role, number>> = {};
  for (let r = 0; r < Math.min(parsed.rows.length, 30) && headingAt === -1; r++) {
    const cells = parsed.rows[r].map(plain);
    const found: Partial<Record<Role, number>> = {};
    for (const role of Object.keys(names) as Role[]) {
      for (const name of names[role] ?? []) {
        const index = cells.indexOf(plain(name));
        if (index !== -1 && !Object.values(found).includes(index)) {
          found[role] = index;
          break;
        }
      }
    }
    if (found.date !== undefined && (found.amount !== undefined || found.out !== undefined || found.in !== undefined)) [headingAt, at] = [r, found];
  }
  if (headingAt === -1) {
    return { ok: false, problems: [layout === "columns" ? "No row of the file has the column names given." : `No row of the file has the columns ${LAYOUT_LABELS[layout]} files have. Choose the bank, or name the columns yourself.`] };
  }

  const problems: string[] = [];
  const read: Omit<StatementLine, "fingerprint">[] = [];
  let opening: Decimal | null = null;
  let closing: Decimal | null = null;
  for (let r = headingAt + 1; r < parsed.rows.length && problems.length < 20; r++) {
    const cells = parsed.rows[r];
    if (cells.every((cell) => blank(cell))) continue;
    const row = r + 1;
    const cell = (role: Role) => (at[role] === undefined ? undefined : cells[at[role]!]);
    const description = (cell("description") ?? "").trim().replace(/\s+/g, " ");
    const money = (role: Role) => readBankAmount(cell(role));
    const out = money("out");
    const into = money("in");
    const signed = money("amount");
    const balance = money("balance");
    if (out === "bad" || into === "bad" || signed === "bad" || balance === "bad") {
      problems.push(`Row ${row}: an amount is not a number.`);
      continue;
    }
    let amount: Decimal | null = null;
    if (signed !== null) amount = signed;
    else if (out !== null && into !== null && !out.isZero() && !into.isZero()) {
      problems.push(`Row ${row}: money both in and out on one line.`);
      continue;
    } else if (into !== null && !into.isZero()) amount = into.abs();
    else if (out !== null && !out.isZero()) amount = out.abs().negated();
    const date = blank(cell("date")) ? null : readBankDate(cell("date")!);
    if (amount === null || amount.isZero()) {
      if (OPENING.test(description) && balance !== null) opening = balance;
      else if (CLOSING.test(description) || (date === null && blank(cell("date")))) {
        if (balance !== null) closing = balance;
      } else problems.push(`Row ${row}: no money in or out.`);
      continue;
    }
    if (date === null) {
      problems.push(`Row ${row}: "${(cell("date") ?? "").trim().slice(0, 20)}" is not a day.`);
      continue;
    }
    if (description.length > 500) {
      problems.push(`Row ${row}: the description is longer than 500 characters.`);
      continue;
    }
    const reference = blank(cell("reference")) ? null : cell("reference")!.trim().slice(0, 60);
    read.push({ row, date, description, reference, amount, balance });
  }
  if (problems.length === 0 && read.length === 0) problems.push("The file has no lines with money in or out.");
  if (read.length > MAX_STATEMENT_LINES) problems.push(`Import at most ${MAX_STATEMENT_LINES.toLocaleString("en")} lines at a time.`);
  if (problems.length > 0) return { ok: false, problems };

  // Oldest first: a bank that lists the newest first is read the other way round.
  if (read[0].date > read[read.length - 1].date) read.reverse();
  if (read.every((line) => line.balance !== null)) {
    for (let i = 1; i < read.length && problems.length < 20; i++) {
      if (!read[i - 1].balance!.plus(read[i].amount).eq(read[i].balance!)) {
        problems.push(`Row ${read[i].row}: the balance does not follow from the line before (${read[i - 1].balance!.toFixed(2)} and ${read[i].amount.toFixed(2)} is not ${read[i].balance!.toFixed(2)}). Check that money in and money out are the right columns.`);
      }
    }
    if (problems.length > 0) return { ok: false, problems };
    opening ??= read[0].balance!.minus(read[0].amount);
    closing ??= read[read.length - 1].balance;
  }

  const seen = new Map<string, number>();
  const lines = read.map((line): StatementLine => {
    const key = [line.date, line.amount.toFixed(4), line.balance?.toFixed(4) ?? "", line.description.toLowerCase(), line.reference ?? ""].join("|");
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { ...line, fingerprint: createHash("sha256").update(`${key}#${occurrence}`).digest("hex") };
  });
  return { ok: true, lines, opening, closing, from: lines[0].date, to: lines[lines.length - 1].date };
}

// ── Matching ────────────────────────────────────────────────────────────────────────────────────

export type BankLine = { id: string; date: string; amount: Decimal; reference: string | null; description: string };
export type BookLine = { id: string; date: string; amount: Decimal; documentNumber: string | null; chequeNumber: string | null };
export type Pair = { statementId: string; journalLineId: string; rule: "reference" | "amount_date" };

const token = (value: string | null) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+(?=\d)/, "");
const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/** Whether a statement line names an entry: its cheque number or its document's number, in the reference or the description. */
function names(bank: BankLine, book: BookLine): boolean {
  const reference = token(bank.reference);
  const words = bank.description.toUpperCase().split(/[^A-Z0-9-]+/).map(token).filter(Boolean);
  const said = (value: string | null) => {
    const wanted = token(value);
    return wanted.length >= 3 && (reference === wanted || words.includes(wanted));
  };
  return said(book.chequeNumber) || said(book.documentNumber);
}

/**
 * The statement lines and entries in the books that are surely the same money, one to one:
 * first those the statement names (by cheque or document number, same amount, within 45 days),
 * then those with the same amount within a few days of each other (from three days before the
 * entry to ten after: a cheque takes days to clear) where neither side has another candidate.
 * Anything else is left for a person to match.
 */
export function autoMatch(bankLines: readonly BankLine[], bookLines: readonly BookLine[]): Pair[] {
  const pairs: Pair[] = [];
  const usedBank = new Set<string>();
  const usedBook = new Set<string>();
  for (const bank of bankLines) {
    const candidates = bookLines.filter((book) => !usedBook.has(book.id) && book.amount.eq(bank.amount) && Math.abs(days(bank.date, book.date)) <= 45 && names(bank, book));
    if (candidates.length === 1) {
      pairs.push({ statementId: bank.id, journalLineId: candidates[0].id, rule: "reference" });
      usedBank.add(bank.id);
      usedBook.add(candidates[0].id);
    }
  }
  const near = (bank: BankLine, book: BookLine) => book.amount.eq(bank.amount) && days(bank.date, book.date) >= -3 && days(bank.date, book.date) <= 10;
  const bankLeft = bankLines.filter((bank) => !usedBank.has(bank.id));
  const bookLeft = bookLines.filter((book) => !usedBook.has(book.id));
  for (const bank of bankLeft) {
    const candidates = bookLeft.filter((book) => !usedBook.has(book.id) && near(bank, book));
    if (candidates.length !== 1) continue;
    const rivals = bankLeft.filter((other) => !usedBank.has(other.id) && near(other, candidates[0]));
    if (rivals.length !== 1) continue;
    pairs.push({ statementId: bank.id, journalLineId: candidates[0].id, rule: "amount_date" });
    usedBank.add(bank.id);
    usedBook.add(candidates[0].id);
  }
  return pairs;
}

// ── The reconciliation ──────────────────────────────────────────────────────────────────────────

export type ReconcileLine = { id: string; date: string; amount: Decimal; matchId: string | null };

export type Reconciliation = {
  asAt: string;
  /** The day the first statement starts: entries in the books before it are brought forward. */
  startsOn: string;
  bankOpening: Decimal;
  /** True when no statement says what the account held before its first line: the books' figure is taken. */
  openingFromBooks: boolean;
  booksAtStart: Decimal;
  bankBalance: Decimal;
  bookBalance: Decimal;
  /** Entries in the books from the start to the day that no statement line has matched yet. */
  unmatchedBooks: Decimal;
  /** Statement lines to the day not yet matched with the books. */
  unmatchedBank: Decimal;
  /** The books, less what the bank has not shown yet, plus what the books do not have yet. */
  adjustedBooks: Decimal;
  /** The bank less the adjusted books: nil when the account is reconciled. */
  difference: Decimal;
};

/**
 * The reconciliation of one bank account on a day. A match counts only when every line of it is
 * dated on or before the day; otherwise its lines are unmatched as at that day.
 */
export function reconcile(
  asAt: string,
  statement: { startsOn: string; opening: Decimal | null },
  bankLines: readonly ReconcileLine[],
  bookLines: readonly ReconcileLine[],
): Reconciliation {
  const sum = (lines: readonly ReconcileLine[]) => lines.reduce((t, line) => t.plus(line.amount), ZERO);
  const late = new Set<string>();
  for (const line of [...bankLines, ...bookLines]) if (line.matchId && line.date > asAt) late.add(line.matchId);
  for (const line of bookLines) if (line.matchId && line.date < statement.startsOn) late.add(line.matchId);
  const settled = (line: ReconcileLine) => line.matchId !== null && !late.has(line.matchId);
  const booksAtStart = sum(bookLines.filter((line) => line.date < statement.startsOn));
  const bankOpening = statement.opening ?? booksAtStart;
  const bankBalance = bankOpening.plus(sum(bankLines.filter((line) => line.date <= asAt)));
  const bookBalance = sum(bookLines.filter((line) => line.date <= asAt));
  const unmatchedBooks = sum(bookLines.filter((line) => line.date >= statement.startsOn && line.date <= asAt && !settled(line)));
  const unmatchedBank = sum(bankLines.filter((line) => line.date <= asAt && !settled(line)));
  const adjustedBooks = bookBalance.minus(unmatchedBooks).plus(unmatchedBank);
  return {
    asAt,
    startsOn: statement.startsOn,
    bankOpening,
    openingFromBooks: statement.opening === null,
    booksAtStart,
    bankBalance,
    bookBalance,
    unmatchedBooks,
    unmatchedBank,
    adjustedBooks,
    difference: bankBalance.minus(adjustedBooks),
  };
}
