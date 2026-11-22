import Decimal from "decimal.js";
import { formatIsoDate, isIsoDate } from "@/modules/currencies/rules";
import type { Cell, ReportRow, ReportTable } from "@/modules/reports/rules";
import type { WithholdingKind } from "@/modules/tax/rules";
import type { Permission } from "@/modules/tenant/rules";

// Pure rules for the buying reports (Step 29). No I/O.
//
// Every figure is read from what the postings stored: posted supplier bills and what payments
// and returns took off them, the journal lines kept against each supplier, and the tax withheld
// on bills with the challans it was paid under. Nothing here works a rate or an amount out
// again; the reports only add up, sort and age, and set their totals beside the books.

export const PURCHASE_REPORTS = {
  "aged-payables": {
    title: "Aged payables",
    about: "What is owed on each supplier's bills on a day, by how long it has been due, with what was paid ahead or is owed back, against the books.",
    permission: "supplier_bill.read",
    period: false,
    dated: true,
    bySupplier: true,
  },
  "supplier-statement": {
    title: "Supplier statement",
    about: "Everything in the books for one supplier in a period: bills, payments and goods sent back, with what was owed before and after.",
    permission: "supplier_bill.read",
    period: true,
    dated: true,
    bySupplier: true,
  },
  "withholding-register": {
    title: "Withholding register",
    about: "Every amount of tax withheld from suppliers in a period, with the challan it was paid under, and what is still to be paid over against the books.",
    permission: "supplier_bill.read",
    period: true,
    dated: true,
    bySupplier: true,
  },
  "section-165": {
    title: "Statement of tax withheld (section 165)",
    about: "The income tax withheld from suppliers in a period, payee by payee, set out for the statement FBR asks for each quarter.",
    permission: "supplier_bill.read",
    period: true,
    dated: true,
    bySupplier: false,
  },
  grni: {
    title: "Goods received, not yet billed",
    about: "Goods that have arrived and have no supplier bill yet, at what they cost, against the account in the books.",
    permission: "purchase_order.read",
    period: false,
    dated: false,
    bySupplier: false,
  },
} as const satisfies Record<string, { title: string; about: string; permission: Permission; period: boolean; dated: boolean; bySupplier: boolean }>;

export type PurchaseReportKey = keyof typeof PURCHASE_REPORTS;
export const isPurchaseReportKey = (value: unknown): value is PurchaseReportKey => typeof value === "string" && Object.hasOwn(PURCHASE_REPORTS, value);

/** What a buying report was asked for. `from` is used by the reports over a period; the others are as at `to`. */
export type PurchaseFilter = { from: string; to: string; branchId: string | null; supplierId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (value: unknown) => (Array.isArray(value) ? value[0] : value);
const id = (value: unknown) => {
  const v = one(value);
  return typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null;
};

/** The filter from the address. With no dates: the fiscal year so far, as at today. A period the wrong way round is turned round. */
export function readPurchaseFilter(raw: Record<string, unknown>, defaults: { yearStart: string; today: string }): PurchaseFilter {
  const to = isIsoDate(one(raw.to)) ? (one(raw.to) as string) : defaults.today;
  let from = isIsoDate(one(raw.from)) ? (one(raw.from) as string) : defaults.yearStart;
  if (from > to) from = to;
  return { from, to, branchId: id(raw.branch), supplierId: id(raw.supplier) };
}

export function purchaseFilterQuery(filter: PurchaseFilter, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ from: filter.from, to: filter.to });
  if (filter.branchId) query.set("branch", filter.branchId);
  if (filter.supplierId) query.set("supplier", filter.supplierId);
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return query.toString();
}

const ZERO = new Decimal(0);
const sum = (values: readonly Decimal[]) => values.reduce((total, value) => total.plus(value), ZERO);
const blankIfZero = (value: Decimal): Cell => (value.isZero() ? null : value);
const asAt = (date: string) => `As at the end of ${formatIsoDate(date)}`;
const period = (filter: PurchaseFilter) => `${formatIsoDate(filter.from)} to ${formatIsoDate(filter.to)}`;
const DAY = 86_400_000;

// ── Aged payables ───────────────────────────────────────────────────────────────────────────────

export const AGE_BANDS = ["Not yet due", "1 to 30 days", "31 to 60 days", "61 to 90 days", "Over 90 days"] as const;

/** Which band an amount due on a day falls in, on another day: 0 while it is not yet due (or is due that day), then by how many days it is overdue. */
export function ageBand(due: string, on: string): number {
  const days = Math.round((Date.parse(`${on}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY);
  if (days <= 0) return 0;
  if (days <= 30) return 1;
  if (days <= 60) return 2;
  if (days <= 90) return 3;
  return 4;
}

/** Something still owed to a supplier on the day of the report: a posted bill, or a bill that was unpaid when the books were opened. */
export type OwedItem = { supplierId: string; supplierName: string; document: string; reference: string | null; date: string; due: string; owed: Decimal };
/** What a supplier holds of the company's on that day: money paid ahead of a bill, and credit for goods sent back that no bill has taken yet. */
export type SupplierCredit = { supplierId: string; supplierName: string; advances: Decimal; credits: Decimal };

/**
 * Aged payables. One line for each supplier; with `detail`, each thing owed is listed under its
 * supplier. `books` is Trade payables less Advances to suppliers in the books on the same day,
 * for the same branch and supplier; null where there is nothing to compare with.
 */
export function agedPayablesTable(items: readonly OwedItem[], credits: readonly SupplierCredit[], books: Decimal | null, filter: PurchaseFilter, detail: boolean, notes: string[] = []): ReportTable {
  const suppliers = new Map<string, { name: string; items: OwedItem[]; bands: Decimal[]; held: Decimal }>();
  const of = (supplierId: string, name: string) => {
    const found = suppliers.get(supplierId) ?? { name, items: [], bands: AGE_BANDS.map(() => ZERO), held: ZERO };
    suppliers.set(supplierId, found);
    return found;
  };
  for (const item of items) {
    const supplier = of(item.supplierId, item.supplierName);
    const band = ageBand(item.due, filter.to);
    supplier.items.push(item);
    supplier.bands[band] = supplier.bands[band].plus(item.owed);
  }
  for (const credit of credits) {
    const held = credit.advances.plus(credit.credits);
    if (!held.isZero()) of(credit.supplierId, credit.supplierName).held = held;
  }
  const rows: ReportRow[] = [];
  const totals = AGE_BANDS.map(() => ZERO);
  let held = ZERO;
  for (const supplier of [...suppliers.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const owed = sum(supplier.bands);
    if (detail) {
      rows.push({ kind: "heading", depth: 0, cells: [supplier.name, null, null, ...AGE_BANDS.map(() => null), null, null, null] });
      for (const item of supplier.items) {
        const band = ageBand(item.due, filter.to);
        rows.push({ kind: "line", depth: 1, cells: [item.reference ? `${item.document} (${item.reference})` : item.document, formatIsoDate(item.date), formatIsoDate(item.due), ...AGE_BANDS.map((_, index) => (index === band ? item.owed : null)), item.owed, null, null] });
      }
    }
    rows.push({ kind: detail ? "total" : "line", depth: 0, cells: [detail ? `Total, ${supplier.name}` : supplier.name, null, null, ...supplier.bands.map(blankIfZero), owed, blankIfZero(supplier.held), owed.minus(supplier.held)] });
    supplier.bands.forEach((band, index) => (totals[index] = totals[index].plus(band)));
    held = held.plus(supplier.held);
  }
  const owed = sum(totals);
  const net = owed.minus(held);
  rows.push({ kind: "grand", depth: 0, cells: ["Total", null, null, ...totals, owed, held, net] });
  if (books !== null) {
    rows.push({ kind: "total", depth: 0, cells: ["Trade payables less advances to suppliers, in the books", null, null, ...AGE_BANDS.map(() => null), null, null, books] });
    const difference = net.minus(books);
    rows.push({ kind: "total", depth: 0, cells: ["Difference", null, null, ...AGE_BANDS.map(() => null), null, null, difference] });
    if (!difference.isZero()) notes = [...notes, "What is owed on bills and what the books hold for suppliers do not agree. An entry made to a supplier's account by hand would do this; please report it."];
  }
  return {
    title: PURCHASE_REPORTS["aged-payables"].title,
    period: asAt(filter.to),
    columns: [
      { label: "Supplier", numeric: false },
      { label: "Dated", numeric: false },
      { label: "Due", numeric: false },
      ...AGE_BANDS.map((label) => ({ label, numeric: true })),
      { label: "Owed on bills", numeric: true },
      { label: "Paid ahead or owed back", numeric: true },
      { label: "Net owed", numeric: true },
    ],
    rows,
    notes: ["A bill is aged from the day it is due; one with no due date, from its own date.", ...notes],
  };
}

// ── Supplier statement ──────────────────────────────────────────────────────────────────────────

/** One entry in the books for a supplier: above nothing where the company owes more because of it, below where it owes less. */
export type StatementLine = { date: string; document: string; details: string; amount: Decimal };

/** Everything in the books for one supplier in a period, with what was owed to it before and after. */
export function supplierStatementTable(supplierName: string | null, opening: Decimal, lines: readonly StatementLine[], filter: PurchaseFilter): ReportTable {
  const columns = [
    { label: "Date", numeric: false },
    { label: "Document", numeric: false },
    { label: "Details", numeric: false },
    { label: "Billed", numeric: true },
    { label: "Paid or sent back", numeric: true },
    { label: "Owed to the supplier", numeric: true },
  ];
  const title = PURCHASE_REPORTS["supplier-statement"].title;
  if (supplierName === null) return { title, period: period(filter), columns, rows: [], notes: ["Choose a supplier to see its statement."] };
  let balance = opening;
  const rows: ReportRow[] = lines.map((line) => {
    balance = balance.plus(line.amount);
    return { kind: "line", depth: 0, cells: [formatIsoDate(line.date), line.document, line.details, line.amount.gt(0) ? line.amount : null, line.amount.lt(0) ? line.amount.neg() : null, balance] };
  });
  const billed = sum(lines.filter((line) => line.amount.gt(0)).map((line) => line.amount));
  const paid = sum(lines.filter((line) => line.amount.lt(0)).map((line) => line.amount.neg()));
  return {
    title: `${title}: ${supplierName}`,
    period: period(filter),
    columns,
    rows: [{ kind: "heading", depth: 0, cells: ["", "Owed before", "", null, null, opening] }, ...rows, { kind: "grand", depth: 0, cells: ["", "Owed after", "", billed, paid, balance] }],
    notes: balance.lt(0) ? ["The supplier holds more of the company's money than it is owed: an advance, or credit for goods sent back."] : [],
  };
}

// ── Tax withheld ────────────────────────────────────────────────────────────────────────────────

export const KIND_WORDS: Record<WithholdingKind, string> = { income_tax: "Income tax", sales_tax: "Sales tax", provincial_sales_tax: "Provincial sales tax" };
const KINDS: readonly WithholdingKind[] = ["income_tax", "sales_tax", "provincial_sales_tax"];

export type WithheldEntry = {
  date: string;
  kind: WithholdingKind;
  supplierName: string;
  supplierType: string;
  ntn: string | null;
  cnic: string | null;
  billNumber: string;
  supplierInvoiceNo: string;
  label: string;
  legalReference: string;
  onActiveList: boolean;
  base: Decimal;
  rate: Decimal;
  amount: Decimal;
  challanNo: string | null;
  paidOn: string | null;
};

/** What is still to be paid over on a day, kind by kind, and what the withholding payable accounts hold in the books that day. */
export type WithheldPosition = { unpaid: Record<WithholdingKind, Decimal>; books: Record<WithholdingKind, Decimal> };

/**
 * The withholding register: every amount withheld in the period, by kind of tax, with the
 * challan it was paid under. With `position`, what is still to be paid over at the end of the
 * period is set beside the withholding payable accounts in the books; they must agree.
 */
export function withholdingRegisterTable(entries: readonly WithheldEntry[], position: WithheldPosition | null, filter: PurchaseFilter): ReportTable {
  const rows: ReportRow[] = [];
  const blank = (label: string, amount: Decimal, kind: ReportRow["kind"]): ReportRow => ({ kind, depth: 0, cells: ["", label, null, null, null, null, null, null, null, amount, null, null] });
  for (const kind of KINDS) {
    const mine = entries.filter((entry) => entry.kind === kind);
    if (mine.length === 0) continue;
    rows.push({ kind: "heading", depth: 0, cells: [KIND_WORDS[kind], null, null, null, null, null, null, null, null, null, null, null] });
    for (const entry of mine) {
      rows.push({
        kind: "line",
        depth: 0,
        cells: [formatIsoDate(entry.date), entry.supplierName, entry.ntn ?? entry.cnic, entry.billNumber, entry.supplierInvoiceNo, entry.label, entry.onActiveList ? "Yes" : "No", entry.base, entry.rate, entry.amount, entry.challanNo, entry.paidOn ? formatIsoDate(entry.paidOn) : null],
      });
    }
    rows.push(blank(`Total, ${KIND_WORDS[kind].toLowerCase()}`, sum(mine.map((entry) => entry.amount)), "total"));
  }
  rows.push(blank("Withheld in the period", sum(entries.map((entry) => entry.amount)), "grand"));
  const notes: string[] = [];
  if (position) {
    rows.push({ kind: "heading", depth: 0, cells: [`Still to be paid to the government, ${asAt(filter.to).toLowerCase()}`, null, null, null, null, null, null, null, null, null, null, null] });
    for (const kind of KINDS) {
      if (position.unpaid[kind].isZero() && position.books[kind].isZero()) continue;
      rows.push(blank(KIND_WORDS[kind], position.unpaid[kind], "line"));
    }
    const unpaid = sum(KINDS.map((kind) => position.unpaid[kind]));
    const books = sum(KINDS.map((kind) => position.books[kind]));
    rows.push(blank("Withheld and not yet paid over", unpaid, "grand"));
    rows.push(blank("Withholding payable accounts in the books", books, "total"));
    rows.push(blank("Difference", unpaid.minus(books), "total"));
    if (!unpaid.eq(books)) notes.push("What is still to be paid over and the withholding payable accounts in the books do not agree. An entry made to those accounts by hand would do this; please report it.");
  } else {
    notes.push("Shown for one branch or one supplier: challans are for the whole company, so what is still to be paid over is not set beside the books here.");
  }
  return {
    title: PURCHASE_REPORTS["withholding-register"].title,
    period: period(filter),
    columns: [
      { label: "Withheld on", numeric: false },
      { label: "Supplier", numeric: false },
      { label: "NTN or CNIC", numeric: false },
      { label: "Bill", numeric: false },
      { label: "Their invoice", numeric: false },
      { label: "Line of the tax tables", numeric: false },
      { label: "On the Active Taxpayers List", numeric: false },
      { label: "Amount it is on", numeric: true },
      { label: "Rate %", numeric: true },
      { label: "Tax withheld", numeric: true },
      { label: "Challan (CPR)", numeric: false },
      { label: "Paid on", numeric: false },
    ],
    rows,
    notes,
  };
}

/** The income tax withheld in a period, payee by payee, in the order FBR's quarterly statement asks for it. */
export function section165Table(entries: readonly WithheldEntry[], filter: PurchaseFilter, typeLabels: Record<string, string>): ReportTable {
  const mine = entries.filter((entry) => entry.kind === "income_tax");
  return {
    title: PURCHASE_REPORTS["section-165"].title,
    period: period(filter),
    columns: [
      { label: "Section", numeric: false },
      { label: "NTN", numeric: false },
      { label: "CNIC", numeric: false },
      { label: "Name of the payee", numeric: false },
      { label: "Status", numeric: false },
      { label: "On the Active Taxpayers List", numeric: false },
      { label: "Bill", numeric: false },
      { label: "Their invoice", numeric: false },
      { label: "Date", numeric: false },
      { label: "Amount on which tax was withheld", numeric: true },
      { label: "Rate %", numeric: true },
      { label: "Tax withheld", numeric: true },
      { label: "CPR number", numeric: false },
      { label: "CPR date", numeric: false },
    ],
    rows: [
      ...mine.map((entry): ReportRow => ({
        kind: "line",
        depth: 0,
        cells: [entry.legalReference, entry.ntn, entry.cnic, entry.supplierName, typeLabels[entry.supplierType] ?? entry.supplierType, entry.onActiveList ? "Yes" : "No", entry.billNumber, entry.supplierInvoiceNo, formatIsoDate(entry.date), entry.base, entry.rate, entry.amount, entry.challanNo, entry.paidOn ? formatIsoDate(entry.paidOn) : null],
      })),
      { kind: "grand", depth: 0, cells: ["", null, null, "Total", null, null, null, null, null, sum(mine.map((entry) => entry.base)), null, sum(mine.map((entry) => entry.amount)), null, null] },
    ],
    notes: [
      "Choose the quarter as the period. The date is the day of the bill, when the tax was recorded as withheld.",
      "Set out for copying into the statement FBR asks for under section 165. Check the columns against the form in IRIS before filing; this has not been checked by a tax adviser.",
      ...(mine.some((entry) => entry.challanNo === null) ? ["Some of this tax has not been paid over yet: it has no CPR number."] : []),
    ],
  };
}

// ── Goods received, not yet billed ──────────────────────────────────────────────────────────────

export type GrniLine = { receiptNumber: string; date: string; supplierName: string; orderNumber: string; itemCode: string; description: string; unitCode: string; quantity: Decimal; value: Decimal };

/** Goods that have arrived and have no bill yet, as they stand now, against Goods received not invoiced in the books. */
export function grniTable(lines: readonly GrniLine[], total: Decimal, books: Decimal): ReportTable {
  const difference = total.minus(books);
  return {
    title: PURCHASE_REPORTS.grni.title,
    period: "As it stands now",
    columns: [
      { label: "Goods received", numeric: false },
      { label: "Arrived on", numeric: false },
      { label: "Supplier", numeric: false },
      { label: "Order", numeric: false },
      { label: "Item", numeric: false },
      { label: "Description", numeric: false },
      { label: "Quantity", numeric: true },
      { label: "Value", numeric: true },
    ],
    rows: [
      ...lines.map((line): ReportRow => ({ kind: "line", depth: 0, cells: [line.receiptNumber, formatIsoDate(line.date), line.supplierName, line.orderNumber, line.itemCode, line.description, `${line.quantity.toFixed(4).replace(/\.?0+$/, "")} ${line.unitCode}`, line.value] })),
      { kind: "grand", depth: 0, cells: ["", null, null, null, null, "Total", null, total] },
      { kind: "total", depth: 0, cells: ["", null, null, null, null, "Goods received not invoiced, in the books", null, books] },
      { kind: "total", depth: 0, cells: ["", null, null, null, null, "Difference", null, difference] },
    ],
    notes: difference.isZero() ? [] : ["The goods waiting for a bill and the account in the books do not agree; please report it."],
  };
}
