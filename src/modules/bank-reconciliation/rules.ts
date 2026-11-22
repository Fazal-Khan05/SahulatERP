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
  // Sixteen figures before the point at most: anything longer is an account number or an IBAN, not money.
  if (!/^-?\d{1,16}(\.\d{1,4})?$/.test(text)) return "bad";
  return new Decimal(text).times(sign);
}

export type StatementLine = { row: number; date: string; description: string; reference: string | null; amount: Decimal; balance: Decimal | null; fingerprint: string };
export type ReadStatement =
  | { ok: true; lines: StatementLine[]; opening: Decimal | null; closing: Decimal | null; from: string; to: string }
  | { ok: false; problems: string[] };

// A row that gives a balance or a total rather than money moved, by how its description starts.
const OPENING = /^(opening balance|balance b\/?f|brought forward|balance forward)\b/i;
const CLOSING = /^(closing balance|balance c\/?f|carried forward|total|grand total)\b/i;
export const MAX_STATEMENT_LINES = 5000;

/** A statement read from a bank's CSV file: see readStatementRows. */
export function readStatement(csv: string, layout: Layout, columns: ColumnNames = {}): ReadStatement {
  if (csv.includes("�")) return { ok: false, problems: ['The file is not saved as UTF-8. In Excel, save it as "CSV UTF-8 (Comma delimited)" and import it again.'] };
  const parsed = parseCsv(csv);
  if (!parsed.ok) return { ok: false, problems: [parsed.reason] };
  return readStatementRows(parsed.rows, layout, columns);
}

/**
 * A statement read from the rows of a bank's file, a CSV file's or an Excel sheet's, each row in
 * its place (row r + 1 of the file is rows[r]). The heading row is found wherever it is (a bank's
 * file often starts with the account's name and the period); each line needs a day and money in
 * or out, from a Debit and a Credit column or one Amount column (money out less than nil). A line
 * without money that says it is the opening or the closing balance gives that balance. Lines are
 * put oldest first. When the file gives a running balance, every line must follow from the one
 * before: a file read with its columns mixed up is refused, not imported. Nothing is imported when
 * anything is wrong; up to twenty problems are given, each with its row.
 */
export function readStatementRows(rows: readonly (readonly string[])[], layout: Layout, columns: ColumnNames = {}): ReadStatement {
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
  for (let r = 0; r < Math.min(rows.length, 30) && headingAt === -1; r++) {
    const cells = rows[r].map(plain);
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
  for (let r = headingAt + 1; r < rows.length && problems.length < 20; r++) {
    const cells = rows[r];
    if (cells.every((cell) => blank(cell))) continue;
    const row = r + 1;
    const cell = (role: Role) => (at[role] === undefined ? undefined : cells[at[role]!]);
    const description = (cell("description") ?? "").replace(/\u0000/g, "").trim().replace(/\s+/g, " ");
    const money = (role: Role) => readBankAmount(cell(role));
    const out = money("out");
    const into = money("in");
    const signed = money("amount");
    const balance = money("balance");
    // An opening or closing balance, or a total, whatever it has in the money columns.
    if (OPENING.test(description) || CLOSING.test(description)) {
      if (balance !== null && balance !== "bad") {
        if (OPENING.test(description)) opening = balance;
        else closing = balance;
      }
      continue;
    }
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
      // A row with no day and no money (a note the bank adds) is passed over; a dated one is a mistake.
      if (date === null && blank(cell("date"))) {
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
    const reference = blank(cell("reference")) ? null : cell("reference")!.replace(/\u0000/g, "").trim().slice(0, 60) || null;
    read.push({ row, date, description, reference, amount, balance });
  }
  if (problems.length === 0 && read.length === 0) problems.push("The file has no lines with money in or out.");
  if (read.length > MAX_STATEMENT_LINES) problems.push(`Import at most ${MAX_STATEMENT_LINES.toLocaleString("en")} lines at a time.`);
  if (problems.length > 0) return { ok: false, problems };

  // Oldest first: a bank that lists the newest first is read the other way round.
  if (read[0].date > read[read.length - 1].date) read.reverse();
  if (read.every((line) => line.balance !== null)) {
    const breaks = (lines: typeof read) => {
      const found: string[] = [];
      for (let i = 1; i < lines.length && found.length < 20; i++) {
        if (!lines[i - 1].balance!.plus(lines[i].amount).eq(lines[i].balance!)) {
          found.push(`Row ${lines[i].row}: the balance does not follow from the line before (${lines[i - 1].balance!.toFixed(2)} and ${lines[i].amount.toFixed(2)} is not ${lines[i].balance!.toFixed(2)}). Check that money in and money out are the right columns.`);
        }
      }
      return found;
    };
    let found = breaks(read);
    // A newest-first file whose lines are all of one day cannot be told by its days: by its balances.
    if (found.length > 0 && read[0].date === read[read.length - 1].date && breaks([...read].reverse()).length === 0) {
      read.reverse();
      found = [];
    }
    if (found.length > 0) return { ok: false, problems: found };
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
  // Entries by amount: a statement line is only ever compared with entries of its own amount.
  const byAmount = new Map<string, BookLine[]>();
  for (const book of bookLines) byAmount.set(book.amount.toFixed(4), [...(byAmount.get(book.amount.toFixed(4)) ?? []), book]);
  const same = (bank: BankLine) => byAmount.get(bank.amount.toFixed(4)) ?? [];
  for (const bank of bankLines) {
    const candidates = same(bank).filter((book) => !usedBook.has(book.id) && Math.abs(days(bank.date, book.date)) <= 45 && names(bank, book));
    if (candidates.length === 1) {
      pairs.push({ statementId: bank.id, journalLineId: candidates[0].id, rule: "reference" });
      usedBank.add(bank.id);
      usedBook.add(candidates[0].id);
    }
  }
  const near = (bank: BankLine, book: BookLine) => book.amount.eq(bank.amount) && days(bank.date, book.date) >= -3 && days(bank.date, book.date) <= 10;
  const bankLeft = bankLines.filter((bank) => !usedBank.has(bank.id));
  const bankByAmount = new Map<string, BankLine[]>();
  for (const bank of bankLeft) bankByAmount.set(bank.amount.toFixed(4), [...(bankByAmount.get(bank.amount.toFixed(4)) ?? []), bank]);
  for (const bank of bankLeft) {
    const candidates = same(bank).filter((book) => !usedBook.has(book.id) && near(bank, book));
    if (candidates.length !== 1) continue;
    const rivals = (bankByAmount.get(bank.amount.toFixed(4)) ?? []).filter((other) => !usedBank.has(other.id) && near(other, candidates[0]));
    if (rivals.length !== 1) continue;
    pairs.push({ statementId: bank.id, journalLineId: candidates[0].id, rule: "amount_date" });
    usedBank.add(bank.id);
    usedBook.add(candidates[0].id);
  }
  return pairs;
}

// ── The reconciliation ──────────────────────────────────────────────────────────────────────────

export type ReconcileLine = { id: string; date: string; amount: Decimal; matchId: string | null };
/** A statement line as the reconciliation needs it: with the running balance the bank gave, if it gave one. */
export type ReconcileBankLine = ReconcileLine & { balance: Decimal | null };

export type Reconciliation = {
  asAt: string;
  /** The day the first statement starts: entries in the books before it are brought forward. */
  startsOn: string;
  /** What the bank says the account held before its first statement; worked out from the books when no statement says. */
  bankOpening: Decimal;
  openingFromBooks: boolean;
  /** The books before the first statement, and what of it the bank had not yet shown then (matched to later lines). */
  booksAtStart: Decimal;
  inTransitAtStart: Decimal;
  /** What the bank says the account held on the day: the running balance of its last line, or its lines added up when the files give none. */
  bankBalance: Decimal;
  bankBalanceGiven: boolean;
  /** The bank's balance less what its imported lines add up to: a statement missing, or a line lost. Nil when nothing is missing. */
  missingFromStatements: Decimal;
  bookBalance: Decimal;
  /** Entries in the books the bank has not shown by the day: unmatched since the start, or matched to a later line. */
  unmatchedBooks: Decimal;
  /** Statement lines to the day not in the books by the day. */
  unmatchedBank: Decimal;
  /** The books, less what the bank has not shown yet, plus what the books do not have yet. */
  adjustedBooks: Decimal;
  /** The bank less the books reconciled: nil when every rupee is explained. */
  difference: Decimal;
};

/**
 * One bank account's reconciliation on a day, against what the bank itself says it held.
 *
 * A match is settled on the day when every line of it, on both sides, is dated on or before the
 * day. Entries in the books before the first statement are taken to be in the bank's opening
 * balance, except those matched to a later statement line: those were on their way (a cheque
 * written in October and presented in November). The bank's balance on the day is the running
 * balance its last line gives; when its files give none, it is the opening plus its lines, which
 * cannot show a missing statement (said so on the screen).
 */
export function reconcile(
  asAt: string,
  statement: { startsOn: string; opening: Decimal | null },
  bankLines: readonly ReconcileBankLine[],
  bookLines: readonly ReconcileLine[],
): Reconciliation {
  const sum = (lines: readonly ReconcileLine[]) => lines.reduce((t, line) => t.plus(line.amount), ZERO);
  const unsettled = new Set<string>();
  for (const line of [...bankLines, ...bookLines]) if (line.matchId && line.date > asAt) unsettled.add(line.matchId);
  const settled = (line: ReconcileLine) => line.matchId !== null && !unsettled.has(line.matchId);
  const before = bookLines.filter((line) => line.date < statement.startsOn);
  const booksAtStart = sum(before);
  const inTransitAtStart = sum(before.filter((line) => line.matchId !== null));
  const bankOpening = statement.opening ?? booksAtStart.minus(inTransitAtStart);
  const shown = bankLines.filter((line) => line.date <= asAt);
  const added = bankOpening.plus(sum(shown));
  const last = shown.at(-1);
  const bankBalance = last?.balance ?? added;
  const bookBalance = sum(bookLines.filter((line) => line.date <= asAt));
  const unmatchedBooks = sum(bookLines.filter((line) => line.date <= asAt && (line.date >= statement.startsOn || line.matchId !== null) && !settled(line)));
  const unmatchedBank = sum(shown.filter((line) => !settled(line)));
  const adjustedBooks = bookBalance.minus(unmatchedBooks).plus(unmatchedBank);
  return {
    asAt,
    startsOn: statement.startsOn,
    bankOpening,
    openingFromBooks: statement.opening === null,
    booksAtStart,
    inTransitAtStart,
    bankBalance,
    bankBalanceGiven: last?.balance !== null && last !== undefined,
    missingFromStatements: bankBalance.minus(added),
    bookBalance,
    unmatchedBooks,
    unmatchedBank,
    adjustedBooks,
    difference: bankBalance.minus(adjustedBooks),
  };
}
