import { OPENING_FILE_COLUMNS } from "@/modules/inventory/rules";
import { ITEM_COLUMNS } from "@/modules/items/rules";
import { ACCOUNT_COLUMNS, PARTY_COLUMNS } from "@/modules/opening/rules";
import { importColumns } from "@/modules/parties/rules";
import type { ModuleKey, Permission } from "@/modules/tenant/rules";
import { DATA_IMPORT_KINDS, type DataImportKind } from "./schema";

// Step 49: bringing a company in from the system it used before, under Settings, Import data.
// Pure rules: no database here.
//
// Any old system will do. Its list of customers (or suppliers, items, stock, unpaid invoices,
// trial balance) is saved from it as an Excel or CSV file; the file's columns are matched to
// ours, by the person importing, once per kind of file (the match is remembered); the file is
// checked row by row and shows every problem in words; then all of it goes in, or none. What
// goes in goes through the command that imports that kind from its own screen, reading a CSV
// made here in our own layout, so there is one way in for each kind, with one set of checks.

export { DATA_IMPORT_KINDS, type DataImportKind };
export const isDataImportKind = (value: unknown): value is DataImportKind => typeof value === "string" && (DATA_IMPORT_KINDS as readonly string[]).includes(value);

/** One of our columns: `also` are headings other systems give it, offered as a first guess. */
export type ImportColumn = { key: string; header: string; required: boolean; also: readonly string[] };

export type ImportKind = {
  kind: DataImportKind;
  title: string;
  /** What one row is, for counts: "customer", "customers". */
  one: string;
  many: string;
  about: string;
  /** What has to be in place before this kind can be imported. */
  before: string | null;
  columns: readonly ImportColumn[];
  /** The module that must be switched on; null for the books, which are always on. */
  module: ModuleKey | null;
  /** Who may import it: the command checks this too. */
  permission: Permission;
  /** Opening stock asks for the day it was counted, and a warehouse unless the file names them. */
  stock: boolean;
  /** The opening balances go onto the draft opening entry, which has to be started first. */
  opening: boolean;
};

const withRequired = (columns: readonly { key: string; header: string }[], required: readonly string[], also: Record<string, readonly string[]> = {}): ImportColumn[] =>
  columns.map((column) => ({ key: column.key, header: column.header, required: required.includes(column.key), also: also[column.key] ?? [] }));

const PARTY_ALSO = (who: "Customer" | "Supplier"): Record<string, readonly string[]> => ({
  code: [`${who} code`, "Party code", "Account code", "A/C code"],
  name: [`${who} name`, "Party name", "Party", who, "Account title"],
  contactName: ["Contact", "Contact name"],
  phone: ["Phone no", "Phone number", "Mobile", "Mobile no", "Cell", "Cell no", "Tel"],
  email: ["Email address", "E-mail"],
  address: ["Address 1", "Address line 1"],
  ntn: ["NTN no", "NTN number"],
  strn: ["STRN no", "Sales tax registration no", "GST no"],
  creditLimit: ["Credit limit amount"],
  creditDays: ["Credit period", "Payment terms days"],
});

export const IMPORT_KINDS: Record<DataImportKind, ImportKind> = {
  customers: {
    kind: "customers",
    title: "Customers",
    one: "customer",
    many: "customers",
    about: "Your customer list: names, codes, tax numbers, credit terms and how to reach them. One row per customer.",
    before: null,
    columns: withRequired(importColumns("customer"), ["name"], PARTY_ALSO("Customer")),
    module: "sales",
    permission: "customer.manage",
    stock: false,
    opening: false,
  },
  suppliers: {
    kind: "suppliers",
    title: "Suppliers",
    one: "supplier",
    many: "suppliers",
    about: "Your supplier list: names, codes, tax numbers and how to reach them. One row per supplier.",
    before: null,
    columns: withRequired(importColumns("supplier"), ["name"], PARTY_ALSO("Supplier")),
    module: "purchasing",
    permission: "supplier.manage",
    stock: false,
    opening: false,
  },
  items: {
    kind: "items",
    title: "Items",
    one: "item",
    many: "items",
    about: "What you buy and sell: code, name, category, the unit it is counted in, a second unit it comes in, and its selling and retail prices. One row per item.",
    before: "The units and categories the file names must be on the list first (Items, Units and categories); the import names any that are missing.",
    columns: withRequired(ITEM_COLUMNS, ["code", "name", "unit"], {
      code: ["Item code", "Product code", "SKU", "Stock code"],
      name: ["Item name", "Product name", "Item description", "Stock item"],
      category: ["Item category", "Item group", "Stock group", "Group"],
      unit: ["UOM", "Unit of measure", "Base unit"],
      defaultPrice: ["Sale price", "Sales price", "Sale rate"],
      retailPrice: ["Retail rate", "MRP"],
    }),
    module: "inventory",
    permission: "item.manage",
    stock: false,
    opening: false,
  },
  opening_stock: {
    kind: "opening_stock",
    title: "Opening stock",
    one: "line of stock",
    many: "lines of stock",
    about: "How much of each item each warehouse held on the day the books open here, and what one cost. It comes in as a draft for each warehouse, which you look over and post.",
    before: "The items must be on the list first (import them above). Each warehouse named in the file must exist.",
    columns: withRequired(OPENING_FILE_COLUMNS, ["code", "quantity", "cost"], {
      code: ["Item code", "Product code", "SKU", "Stock code"],
      quantity: ["Qty", "Closing qty", "Balance qty", "Closing quantity", "Stock qty", "Quantity in hand"],
      cost: ["Rate", "Cost", "Cost price", "Average cost", "Avg cost", "Purchase rate"],
      warehouse: ["Godown", "Location", "Store", "Warehouse name"],
    }),
    module: "inventory",
    permission: "stock_adjustment.manage",
    stock: true,
    opening: false,
  },
  customer_balances: {
    kind: "customer_balances",
    title: "What customers owe",
    one: "unpaid invoice",
    many: "unpaid invoices",
    about: "Every invoice a customer had not paid in full when the books open here, with what is still unpaid on it. Recovery, receipts and ageing then work on each one as they do on invoices made here.",
    before: "The customers must be on the list first, and the opening entry started (Settings, Opening balances).",
    columns: withRequired(PARTY_COLUMNS.receivable, ["party", "documentNumber", "documentDate", "amount"], {
      party: ["Customer name", "Customer code", "Party", "Party name", "Account title"],
      documentNumber: ["Invoice no", "Inv no", "Bill no", "Reference", "Ref no", "Voucher no"],
      documentDate: ["Date", "Inv date", "Bill date"],
      dueDate: ["Due on"],
      amount: ["Balance", "Outstanding", "Amount due", "Pending amount", "Unpaid"],
    }),
    module: null,
    permission: "opening.manage",
    stock: false,
    opening: true,
  },
  supplier_balances: {
    kind: "supplier_balances",
    title: "What you owe suppliers",
    one: "unpaid bill",
    many: "unpaid bills",
    about: "Every supplier's bill you had not paid in full when the books open here, with what is still unpaid on it. Aged payables then shows each one by its date, as it does bills entered here.",
    before: "The suppliers must be on the list first, and the opening entry started (Settings, Opening balances).",
    columns: withRequired(PARTY_COLUMNS.payable, ["party", "documentNumber", "documentDate", "amount"], {
      party: ["Supplier name", "Supplier code", "Party", "Party name", "Account title"],
      documentNumber: ["Bill no", "Invoice no", "Inv no", "Reference", "Ref no", "Voucher no"],
      documentDate: ["Date", "Bill date", "Invoice date"],
      dueDate: ["Due on"],
      amount: ["Balance", "Outstanding", "Amount due", "Pending amount", "Unpaid"],
    }),
    module: null,
    permission: "opening.manage",
    stock: false,
    opening: true,
  },
  ledger_balances: {
    kind: "ledger_balances",
    title: "Trial balance",
    one: "account balance",
    many: "account balances",
    about: "What every other account stood at when the books open here: cash, bank, loans, fixed assets, capital. Stock, what customers owe and what you owe suppliers come from the files above, not from this one.",
    before: "Each account must be in your chart of accounts (Settings, Accounts), by its code here, and the opening entry started.",
    columns: withRequired(ACCOUNT_COLUMNS, ["debit", "credit"], {
      code: ["Code", "A/C code", "Ledger code", "GL code"],
      name: ["Account", "Account title", "Ledger", "Ledger name", "Particulars", "Head of account"],
      debit: ["Dr", "Debit balance", "Closing debit", "Debit amount"],
      credit: ["Cr", "Credit balance", "Closing credit", "Credit amount"],
    }),
    module: null,
    permission: "opening.manage",
    stock: false,
    opening: true,
  },
};

// ── Reading a file's rows ───────────────────────────────────────────────────────────────────────

/** The headings a file can have: upper or lower case, spaces, dots and slashes do not count. */
export const plainHeading = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const blank = (value: string | undefined): boolean => value === undefined || value.replace(/[\s​-‍⁠﻿]/g, "") === "";
const filledCount = (cells: readonly string[]): number => cells.filter((cell) => !blank(cell)).length;

/**
 * Which row holds the headings, as an index into `rows`: old systems put the company's name, the
 * report's name and the date above them. It is the first of the first fifty rows that has at
 * least three quarters as many cells filled as the fullest of them (and at least two), or the
 * first row with anything in it. Only a guess: the screen shows it, and it can be changed.
 */
export function findHeadingRow(rows: readonly (readonly string[])[]): number {
  const top = rows.slice(0, 50);
  const widest = Math.max(0, ...top.map(filledCount));
  const enough = Math.max(2, Math.ceil((widest * 3) / 4));
  const found = top.findIndex((cells) => filledCount(cells) >= enough);
  if (found !== -1) return found;
  return Math.max(0, rows.findIndex((cells) => filledCount(cells) > 0));
}

/** The headings in a row, a blank heading called by its column's letter, as a spreadsheet does. */
export function headingsOf(row: readonly string[]): string[] {
  const cells = [...row];
  while (cells.length > 0 && blank(cells[cells.length - 1])) cells.pop();
  return cells.map((cell, index) => (blank(cell) ? `Column ${columnLetter(index)}` : cell.trim().replace(/\s+/g, " ").slice(0, 80)));
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Which of the file's columns each of ours is read from: an index into its headings, or none. */
export type ColumnMapping = Record<string, number | null>;
/** Whether one of our columns is read from the file. */
const read = (mapping: ColumnMapping, key: string): boolean => typeof mapping[key] === "number";

/**
 * A first guess at the mapping: the heading this kind was read from last time, else a heading
 * that is ours, else one another system gives it. Only a guess: it is shown, and changed, before
 * anything is read. No heading is offered for two of our columns.
 */
export function suggestMapping(kind: ImportKind, headings: readonly string[], remembered: Record<string, string> | null): ColumnMapping {
  const plain = headings.map(plainHeading);
  const taken = new Set<number>();
  const mapping: ColumnMapping = {};
  const pick = (candidates: readonly string[]): number | null => {
    for (const candidate of candidates) {
      const at = plain.findIndex((heading, index) => heading !== "" && heading === plainHeading(candidate) && !taken.has(index));
      if (at !== -1) return at;
    }
    return null;
  };
  // Remembered headings first, for every column, so a guess never takes one of them.
  for (const column of kind.columns) {
    const at = remembered && typeof remembered[column.key] === "string" ? pick([remembered[column.key]]) : null;
    mapping[column.key] = at;
    if (at !== null) taken.add(at);
  }
  for (const column of kind.columns) {
    if (mapping[column.key] !== null) continue;
    const at = pick([column.header, column.key]) ?? pick(column.also);
    mapping[column.key] = at;
    if (at !== null) taken.add(at);
  }
  return mapping;
}

/**
 * The mapping as the form sent it (`map_<our key>` = the index of the file's column, or empty for
 * none), checked: a column of the file read as two of ours, or one of ours that must be read and
 * is not, is refused in words.
 */
export function readMapping(kind: ImportKind, raw: (key: string) => unknown, headings: readonly string[]): { ok: true; mapping: ColumnMapping } | { ok: false; reason: string } {
  const mapping: ColumnMapping = {};
  const usedBy = new Map<number, string>();
  for (const column of kind.columns) {
    const value = raw(`map_${column.key}`);
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") {
      mapping[column.key] = null;
      continue;
    }
    const index = Number(text);
    if (!Number.isInteger(index) || index < 0 || index >= headings.length) return { ok: false, reason: `Choose again which column of the file holds "${column.header}".` };
    const other = usedBy.get(index);
    if (other) return { ok: false, reason: `The column "${headings[index]}" is chosen for both "${other}" and "${column.header}". Choose one column of the file for each.` };
    usedBy.set(index, column.header);
    mapping[column.key] = index;
  }
  const missing = kind.columns.filter((column) => column.required && mapping[column.key] === null);
  if (missing.length > 0) {
    return { ok: false, reason: `Choose the column of the file that holds ${missing.map((column) => `"${column.header}"`).join(missing.length === 2 ? " and " : ", ")}: ${missing.length === 1 ? "it is" : "they are"} needed.` };
  }
  return { ok: true, mapping };
}

/** The mapping by heading, to remember for the next file of this kind: { "name": "Customer Name" }. */
export function mappingByHeading(mapping: ColumnMapping, headings: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(mapping).flatMap(([key, index]) => (typeof index === "number" && headings[index] !== undefined ? [[key, headings[index]]] : [])));
}

/** At most this many row numbers or ranges to leave out. */
const MAX_LEFT_OUT = 200;

/**
 * Rows to leave out, as typed: "7, 120-125". A total at the bottom of an export, or a line the old
 * system adds, is left out this way rather than edited out of the file.
 */
export function readLeftOut(raw: unknown): { ok: true; rows: Set<number> } | { ok: false; reason: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  const rows = new Set<number>();
  if (text === "") return { ok: true, rows };
  const parts = text.split(/[,;\s]+/).filter((part) => part !== "");
  if (parts.length > MAX_LEFT_OUT) return { ok: false, reason: `Leave out at most ${MAX_LEFT_OUT} rows or ranges at a time.` };
  for (const part of parts) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    const from = match ? Number(match[1]) : NaN;
    const to = match?.[2] ? Number(match[2]) : from;
    if (!match || from < 1 || to < from || to - from > 10_000) return { ok: false, reason: `"${part.slice(0, 20)}" is not a row number or a range of rows, such as 7 or 120-125.` };
    for (let row = from; row <= to; row++) rows.add(row);
  }
  return { ok: true, rows };
}

const csvCell = (value: string): string => (/[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * The file in our own layout, as CSV, for the command that imports this kind: the heading row
 * has our names for the columns read, and every row keeps its place, so a problem named by row is
 * named by the row the file has. Rows above the headings, and rows left out, come through empty.
 */
export function mappedCsv(kind: ImportKind, rows: readonly (readonly string[])[], headingAt: number, mapping: ColumnMapping, leftOut: ReadonlySet<number>): string {
  const used = kind.columns.filter((column) => read(mapping, column.key));
  const lines: string[] = [];
  rows.forEach((cells, index) => {
    if (index < headingAt || leftOut.has(index + 1)) lines.push("");
    else if (index === headingAt) lines.push(used.map((column) => csvCell(column.header)).join(","));
    else lines.push(used.map((column) => csvCell(cells[mapping[column.key] as number] ?? "")).join(","));
  });
  return `${lines.join("\r\n")}\r\n`;
}

/** The first few rows under the headings, read as the mapping says, for the screen to show. */
export function sampleRows(kind: ImportKind, rows: readonly (readonly string[])[], headingAt: number, mapping: ColumnMapping, leftOut: ReadonlySet<number>, count: number): { row: number; cells: string[] }[] {
  const used = kind.columns.filter((column) => read(mapping, column.key));
  const out: { row: number; cells: string[] }[] = [];
  for (let index = headingAt + 1; index < rows.length && out.length < count; index++) {
    if (leftOut.has(index + 1)) continue;
    const cells = used.map((column) => (rows[index][mapping[column.key] as number] ?? "").trim());
    if (cells.every((cell) => cell === "")) continue;
    out.push({ row: index + 1, cells });
  }
  return out;
}

/** The template a kind is imported from: its headings, in order. */
export function templateHeadings(kind: ImportKind): string[] {
  return kind.columns.map((column) => column.header);
}
