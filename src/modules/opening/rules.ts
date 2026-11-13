import Decimal from "decimal.js";
import { readCsvTable, type CsvColumn } from "@/lib/csv-table";
import { parseAmount } from "@/lib/money";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import type { ControlType, JournalLineInput } from "@/modules/ledger/rules";

// Pure rules for opening balances. No I/O.
//
// A company brings its books with it: what every account stood at, each unpaid customer invoice
// and each unpaid supplier bill. Together they become one journal on the opening date. Whatever
// the debits and credits differ by goes to opening balance equity, so the journal always
// balances; that account shows what is still missing (stock, which is brought in item by item
// later, is the usual reason) and should end at nil.

export const OPENING_KINDS = ["account", "receivable", "payable"] as const;
export type OpeningKind = (typeof OPENING_KINDS)[number];
export const isOpeningKind = (value: unknown): value is OpeningKind => typeof value === "string" && (OPENING_KINDS as readonly string[]).includes(value);
export type PartyKind = Exclude<OpeningKind, "account">;

export const OPENING_STATUSES = ["draft", "posted", "reversed"] as const;
export type OpeningStatus = (typeof OPENING_STATUSES)[number];

/** What each kind of line is called on screen and in messages. */
export const KIND_WORDS = {
  receivable: { party: "customer", document: "invoice", many: "receivables" },
  payable: { party: "supplier", document: "bill", many: "payables" },
} as const;

/** A draft can hold this many lines in all. */
export const MAX_OPENING_LINES = 5000;
export const OPENING_IMPORT_MAX_ROWS = 2000;
export const OPENING_IMPORT_MAX_BYTES = 800 * 1024;

/**
 * Why an account cannot have a line of its own in the opening entry, by what the account is
 * for, or null when it can. These are the accounts whose balance is made up of other records.
 */
export function accountLineRefusal(controlType: string | null): string | null {
  switch (controlType as ControlType | null) {
    case "ar":
      return "is entered customer by customer, invoice by invoice, under Receivables. Its total is worked out from those.";
    case "ap":
      return "is entered supplier by supplier, bill by bill, under Payables. Its total is worked out from those.";
    case "inventory":
    case "goods_in_transit":
    case "grni":
      return "is brought in item by item when stock is set up, not here. Until then its value shows in Opening balance equity.";
    case "customer_advances":
    case "supplier_advances":
    case "cheques_in_hand":
      return "is kept by its own records and cannot be opened here yet.";
    case "opening_equity":
      return "is the balancing account: it takes whatever the other lines differ by, by itself.";
    default:
      return null;
  }
}

/** The accounts the opening journal itself may not touch; the database holds the same list. */
export const OPENING_BLOCKED_CONTROLS = ["inventory", "customer_advances", "supplier_advances", "grni", "goods_in_transit", "cheques_in_hand"] as const satisfies readonly ControlType[];

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * A date as people write it in a file: 2026-06-30, or day first as 30-06-2026 or 30/06/2026.
 * Returns it as 2026-06-30, or null when it is not a real date. Month-first dates are not
 * guessed at: 06/30/2026 is refused.
 */
export function readDate(value: unknown): string | null {
  const typed = text(value);
  if (isIsoDate(typed)) return typed;
  const dayFirst = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(typed);
  if (!dayFirst) return null;
  const iso = `${dayFirst[3]}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

export type AccountLine = { accountId: string; debit: Decimal; credit: Decimal };

/** One account's opening balance as typed: a debit or a credit above zero, not both. */
export function readAmounts(raw: { debit?: unknown; credit?: unknown }): { ok: true; debit: Decimal; credit: Decimal } | { ok: false; reason: string } {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  if (text(raw.debit) !== "") {
    const parsed = parseAmount(raw.debit);
    if (!parsed.ok) return { ok: false, reason: `Debit: ${parsed.reason}` };
    debit = parsed.amount;
  }
  if (text(raw.credit) !== "") {
    const parsed = parseAmount(raw.credit);
    if (!parsed.ok) return { ok: false, reason: `Credit: ${parsed.reason}` };
    credit = parsed.amount;
  }
  if (debit.isZero() && credit.isZero()) return { ok: false, reason: "Enter a debit or a credit. An account with no balance needs no line." };
  if (!debit.isZero() && !credit.isZero()) return { ok: false, reason: "Enter a debit or a credit, not both: the balance the account stood at." };
  return { ok: true, debit, credit };
}

export type PartyLine = { partyId: string; documentNumber: string; documentDate: string; dueDate: string | null; amount: Decimal };

/**
 * One unpaid invoice or bill as typed: its own number, its original date (before the opening
 * date), when it falls due if that is known, and what is still unpaid on it.
 */
export function readDocument(
  raw: { documentNumber?: unknown; documentDate?: unknown; dueDate?: unknown; amount?: unknown },
  kind: PartyKind,
  openingDate: string,
): { ok: true; document: Omit<PartyLine, "partyId"> } | { ok: false; reason: string } {
  const words = KIND_WORDS[kind];
  const documentNumber = cleanText(raw.documentNumber);
  if (documentNumber === "") return { ok: false, reason: `Enter the ${words.document}'s number.` };
  if (documentNumber.length > 40) return { ok: false, reason: `The ${words.document}'s number: use at most 40 characters.` };
  const documentDate = readDate(raw.documentDate);
  if (!documentDate) return { ok: false, reason: `Enter the ${words.document}'s date, such as 30-06-2026.` };
  if (documentDate >= openingDate) return { ok: false, reason: `The ${words.document}'s date must be before the opening date. One dated on or after it is entered as an ordinary ${words.document}.` };
  let dueDate: string | null = null;
  if (text(raw.dueDate) !== "") {
    dueDate = readDate(raw.dueDate);
    if (!dueDate) return { ok: false, reason: "Enter the due date as a date, such as 30-07-2026, or leave it empty." };
    if (dueDate < documentDate) return { ok: false, reason: `The due date cannot be before the ${words.document}'s date.` };
  }
  const amount = parseAmount(raw.amount);
  if (!amount.ok) return { ok: false, reason: `Amount unpaid: ${amount.reason}` };
  if (amount.amount.isZero()) return { ok: false, reason: `Amount unpaid: it must be more than zero. A paid ${words.document} is left out.` };
  return { ok: true, document: { documentNumber, documentDate, dueDate, amount: amount.amount } };
}

// ── Reading import files ────────────────────────────────────────────────────────────────────────

/** One row that cannot be imported. `row` is its row in the file as a spreadsheet numbers it. */
export type ImportProblem = { row: number; name: string; problems: string[] };

const ACCOUNT_COLUMNS: readonly CsvColumn<"code" | "name" | "debit" | "credit">[] = [
  { key: "code", header: "Account code" },
  { key: "name", header: "Account name" },
  { key: "debit", header: "Debit" },
  { key: "credit", header: "Credit" },
];

/** One account as an import knows it: `refusal` is why it cannot carry a line of its own, if it cannot. */
export type KnownAccount = { id: string; code: string; name: string; refusal: string | null };
/** What an import looks accounts up by: the code, or without one the exact name in lower case. */
export type AccountLookup = { byCode: ReadonlyMap<string, KnownAccount>; byName: ReadonlyMap<string, KnownAccount> };

export type AccountImportRead = { status: "unreadable"; reason: string } | { status: "read"; lines: { row: number; line: AccountLine }[]; problems: ImportProblem[] };

/**
 * Reads a trial balance: one row per account, by its code (or, without a code, its exact name),
 * with a debit or a credit. Rows with neither are skipped: a trial balance lists accounts that
 * stand at nil. An account named twice is a problem on the later row. A row whose name is not
 * the name of the account its code belongs to is a problem too: a file from another system
 * carries that system's codes, and the same code can mean something else here.
 */
export function readAccountImport(csv: string, known: AccountLookup): AccountImportRead {
  const table = readCsvTable(csv, ACCOUNT_COLUMNS, "debit", OPENING_IMPORT_MAX_ROWS);
  if (!table.ok) return { status: "unreadable", reason: table.reason };
  const lines: { row: number; line: AccountLine }[] = [];
  const problems: ImportProblem[] = [];
  const seen = new Map<string, number>();
  for (const { row, raw, extra } of table.rows) {
    const code = cleanText(raw.code).toUpperCase();
    const name = cleanText(raw.name);
    const label = [code, name].filter(Boolean).join(" ").slice(0, 120);
    const zero = (value: string | undefined) => text(value) === "" || /^0+(\.0+)?$/.test(text(value));
    if (zero(raw.debit) && zero(raw.credit) && !extra) continue;
    const found: string[] = [];
    if (extra) found.push("This row has more cells than the file has columns. Check for a stray comma.");
    const account = code !== "" ? known.byCode.get(code) : known.byName.get(name.toLowerCase());
    if (code === "" && name === "") found.push("Give the account's code.");
    else if (!account) found.push(code !== "" ? `No account has the code ${code}. Add it under Settings, Accounts, or correct the code.` : `No account is named "${name}". Give its code instead.`);
    else if (code !== "" && name !== "" && name.toLowerCase() !== account.name.toLowerCase()) {
      found.push(`Code ${code} is "${account.name}" here, but the file calls it "${name}". Correct the code, or remove the name if the code is right.`);
    } else if (account.refusal) found.push(`${account.code} ${account.name} ${account.refusal}`);
    const amounts = readAmounts(raw);
    if (!amounts.ok) found.push(amounts.reason);
    if (account) {
      const first = seen.get(account.id);
      if (first !== undefined) found.push(`The same account is in row ${first}.`);
      else seen.set(account.id, row);
    }
    if (found.length > 0) problems.push({ row, name: label, problems: found });
    else if (account && amounts.ok) lines.push({ row, line: { accountId: account.id, debit: amounts.debit, credit: amounts.credit } });
  }
  return { status: "read", lines, problems };
}

const PARTY_COLUMNS = {
  receivable: [
    { key: "party", header: "Customer" },
    { key: "documentNumber", header: "Invoice number" },
    { key: "documentDate", header: "Invoice date" },
    { key: "dueDate", header: "Due date" },
    { key: "amount", header: "Amount unpaid" },
  ],
  payable: [
    { key: "party", header: "Supplier" },
    { key: "documentNumber", header: "Bill number" },
    { key: "documentDate", header: "Bill date" },
    { key: "dueDate", header: "Due date" },
    { key: "amount", header: "Amount unpaid" },
  ],
} as const satisfies Record<PartyKind, readonly CsvColumn<"party" | "documentNumber" | "documentDate" | "dueDate" | "amount">[]>;

/** What an import looks customers or suppliers up by: a code beats a name; both in lower case. */
export type PartyLookup = { byCode: ReadonlyMap<string, string>; byName: ReadonlyMap<string, string> };

export type PartyImportRead = { status: "unreadable"; reason: string } | { status: "read"; lines: { row: number; line: PartyLine }[]; problems: ImportProblem[] };

/**
 * Whether a file's dates could be read day first or month first with nothing to tell which.
 * 03/04/2026 is 3 April day first and 4 March month first. One date with a first part above 12
 * anywhere in the file settles it as day first; dates written year first are never in doubt.
 */
export function dateOrderUnproven(cells: readonly unknown[]): boolean {
  let doubtful = false;
  for (const cell of cells) {
    const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text(cell));
    if (!parts) continue;
    if (Number(parts[1]) > 12) return false;
    if (parts[1].padStart(2, "0") !== parts[2].padStart(2, "0")) doubtful = true;
  }
  return doubtful;
}

/**
 * Reads a file of unpaid invoices or bills, one per row, each checked exactly as the form would
 * check it. A file whose dates could be day first or month first is not guessed at. The customer or supplier is given by its code or its exact name. The same number
 * twice for one party is a problem on the later row.
 */
export function readPartyImport(csv: string, kind: PartyKind, openingDate: string, known: PartyLookup): PartyImportRead {
  const words = KIND_WORDS[kind];
  const table = readCsvTable(csv, PARTY_COLUMNS[kind], "party", OPENING_IMPORT_MAX_ROWS);
  if (!table.ok) return { status: "unreadable", reason: table.reason };
  if (dateOrderUnproven(table.rows.flatMap(({ raw }) => [raw.documentDate, raw.dueDate]))) {
    return { status: "unreadable", reason: "The dates in this file could be day first or month first: none has a day above 12 to tell which. Write them year first, as 2026-06-30, and import the file again." };
  }
  const lines: { row: number; line: PartyLine }[] = [];
  const problems: ImportProblem[] = [];
  const seen = new Map<string, number>();
  for (const { row, raw, extra } of table.rows) {
    const found: string[] = [];
    if (extra) found.push("This row has more cells than the file has columns. Check for a stray comma.");
    const typed = cleanText(raw.party);
    const partyId = known.byCode.get(typed.toLowerCase()) ?? known.byName.get(typed.toLowerCase());
    if (typed === "") found.push(`Give the ${words.party}'s code or name.`);
    else if (!partyId) found.push(`No ${words.party} has the code or name "${typed.slice(0, 60)}". Add the ${words.party} first, or correct it.`);
    const read = readDocument(raw, kind, openingDate);
    if (!read.ok) found.push(read.reason);
    if (partyId && read.ok) {
      const key = `${partyId} ${read.document.documentNumber.toLowerCase()}`;
      const first = seen.get(key);
      if (first !== undefined) found.push(`The same ${words.document} of this ${words.party} is in row ${first}.`);
      else seen.set(key, row);
    }
    if (found.length > 0) problems.push({ row, name: [typed, cleanText(raw.documentNumber)].filter(Boolean).join(" ").slice(0, 120), problems: found });
    else if (partyId && read.ok) lines.push({ row, line: { partyId, ...read.document } });
  }
  return { status: "read", lines, problems };
}

// ── The opening journal ─────────────────────────────────────────────────────────────────────────

export type StoredLine =
  | { kind: "account"; accountId: string; debit: Decimal; credit: Decimal }
  | { kind: "receivable"; customerId: string; amount: Decimal }
  | { kind: "payable"; supplierId: string; amount: Decimal };

const Exact = Decimal.clone({ precision: 60 });

/**
 * The journal an opening entry posts: each account at its balance, trade receivables once per
 * customer, trade payables once per supplier, and one line to opening balance equity for
 * whatever the rest differ by (none when they already agree). `difference` is debits less
 * credits before that last line: what opening balance equity is credited with.
 */
export function openingJournal(
  lines: readonly StoredLine[],
  controls: { receivables: string; payables: string; openingEquity: string },
): { lines: JournalLineInput[]; difference: Decimal } {
  const out: JournalLineInput[] = [];
  const perCustomer = new Map<string, { total: Decimal; count: number }>();
  const perSupplier = new Map<string, { total: Decimal; count: number }>();
  for (const line of lines) {
    if (line.kind === "account") out.push({ accountId: line.accountId, debit: line.debit, credit: line.credit, description: "Opening balance" });
    else if (line.kind === "receivable") {
      const sum = perCustomer.get(line.customerId) ?? { total: new Decimal(0), count: 0 };
      perCustomer.set(line.customerId, { total: sum.total.plus(line.amount), count: sum.count + 1 });
    } else {
      const sum = perSupplier.get(line.supplierId) ?? { total: new Decimal(0), count: 0 };
      perSupplier.set(line.supplierId, { total: sum.total.plus(line.amount), count: sum.count + 1 });
    }
  }
  const of = (count: number, one: string) => `Opening balance: ${count} unpaid ${one}${count === 1 ? "" : "s"}`;
  for (const [customerId, sum] of perCustomer) out.push({ accountId: controls.receivables, debit: sum.total, customerId, description: of(sum.count, "invoice") });
  for (const [supplierId, sum] of perSupplier) out.push({ accountId: controls.payables, credit: sum.total, supplierId, description: of(sum.count, "bill") });
  const debits = out.reduce((sum, line) => sum.plus(line.debit ?? 0), new Exact(0));
  const credits = out.reduce((sum, line) => sum.plus(line.credit ?? 0), new Exact(0));
  const difference = new Decimal(debits.minus(credits).toFixed());
  if (difference.isPositive() && !difference.isZero()) out.push({ accountId: controls.openingEquity, credit: difference, description: "Opening balances: what the other lines differ by" });
  else if (difference.isNegative()) out.push({ accountId: controls.openingEquity, debit: difference.abs(), description: "Opening balances: what the other lines differ by" });
  return { lines: out, difference };
}

// ── Ageing ──────────────────────────────────────────────────────────────────────────────────────

/** How old an unpaid invoice is, in the bands a collector works by. `upTo` is the last day of the band. */
export const AGE_BANDS = [
  { label: "0 to 30 days", upTo: 30 },
  { label: "31 to 60 days", upTo: 60 },
  { label: "61 to 90 days", upTo: 90 },
  { label: "Over 90 days", upTo: Infinity },
] as const;

/** Whole days from one date to another (both as 2026-06-30); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((day(to) - day(from)) / 86_400_000);
}

/** The band an invoice of that age falls in. One dated after `asOf` counts as new. */
export function ageBand(days: number): number {
  const index = AGE_BANDS.findIndex((band) => days <= band.upTo);
  return index === -1 ? AGE_BANDS.length - 1 : index;
}

export type OpenItem = { partyId: string; partyName: string; documentDate: string; amount: Decimal };
export type AgedParty = { partyId: string; partyName: string; bands: Decimal[]; total: Decimal };

/**
 * What each customer (or supplier) owes, by how old it is on `asOf`. Age runs from the
 * invoice's own date, not from the day it was entered here. Parties are in name order.
 */
export function ageOpenItems(items: readonly OpenItem[], asOf: string): { parties: AgedParty[]; bands: Decimal[]; total: Decimal } {
  const zero = () => AGE_BANDS.map(() => new Decimal(0));
  const parties = new Map<string, AgedParty>();
  const bands = zero();
  let total = new Decimal(0);
  for (const item of items) {
    const band = ageBand(daysBetween(item.documentDate, asOf));
    const party = parties.get(item.partyId) ?? { partyId: item.partyId, partyName: item.partyName, bands: zero(), total: new Decimal(0) };
    party.bands[band] = party.bands[band].plus(item.amount);
    party.total = party.total.plus(item.amount);
    parties.set(item.partyId, party);
    bands[band] = bands[band].plus(item.amount);
    total = total.plus(item.amount);
  }
  return { parties: [...parties.values()].sort((a, b) => a.partyName.localeCompare(b.partyName, "en")), bands, total };
}
