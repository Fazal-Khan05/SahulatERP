import Decimal from "decimal.js";
import { formatIsoDate, isIsoDate } from "@/modules/currencies/rules";
import type { ReportRow, ReportTable } from "@/modules/reports/rules";
import { marginPercent, plainQuantity } from "@/modules/stock-reports/rules";
import type { Permission } from "@/modules/tenant/rules";

// Pure rules for the sales analysis reports. No I/O.
//
// Every figure is read from what the postings stored: the lines of posted invoices, less the
// lines of posted credit notes, before sales tax. Nothing here works an amount out again; the
// reports only add up, sort and set their total beside the Sales account in the books.

export const SALES_REPORTS = {
  "sales-by-customer": {
    title: "Sales by customer",
    about: "What each customer bought in a period: invoices less credit notes, largest first.",
    group: "customer",
  },
  "sales-by-item": {
    title: "Sales by item",
    about: "What was sold of each item in a period, with the quantity: invoices less credit notes, largest first.",
    group: "item",
  },
  "sales-by-salesperson": {
    title: "Sales by salesperson",
    about: "What each salesperson sold in a period. A line shared between salespeople counts each person's share.",
    group: "salesperson",
  },
  "sales-by-city": {
    title: "Sales by city",
    about: "What was sold to the customers of each city in a period, by the city on the customer's main address.",
    group: "city",
  },
  "sales-by-month": {
    title: "Sales by month",
    about: "What was sold in each calendar month of a period, largest month first.",
    group: "month",
  },
  "sales-register": {
    title: "Sales register",
    about: "Every posted invoice and credit note of a period, one line each, in date order.",
    group: null,
  },
} as const satisfies Record<string, { title: string; about: string; group: SalesGroup | null }>;

export type SalesGroup = "customer" | "item" | "salesperson" | "city" | "month";
export type SalesReportKey = keyof typeof SALES_REPORTS;
export const isSalesReportKey = (value: unknown): value is SalesReportKey => typeof value === "string" && Object.hasOwn(SALES_REPORTS, value);

/** Who reads the sales analysis: the owner, an accountant, an auditor and the sales manager. A salesperson sees only their own orders and invoices, never a company's sales. */
export const SALES_REPORT_PERMISSION = "sales_report.read" satisfies Permission;

/** What a sales report was asked for. */
export type SalesFilter = { from: string; to: string; branchId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/** The filter from the address. With no dates: the fiscal year so far, as at today. A period the wrong way round is turned round. */
export function readSalesFilter(raw: Record<string, unknown>, defaults: { yearStart: string; today: string }): SalesFilter {
  const to = isIsoDate(one(raw.to)) ? (one(raw.to) as string) : defaults.today;
  let from = isIsoDate(one(raw.from)) ? (one(raw.from) as string) : defaults.yearStart;
  if (from > to) from = to;
  const branch = one(raw.branch);
  return { from, to, branchId: typeof branch === "string" && UUID.test(branch) ? branch.toLowerCase() : null };
}

export function salesFilterQuery(filter: SalesFilter, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ from: filter.from, to: filter.to });
  if (filter.branchId) query.set("branch", filter.branchId);
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return query.toString();
}

const ZERO = new Decimal(0);
const sum = (values: readonly Decimal[]) => values.reduce((total, value) => total.plus(value), ZERO);
const period = (filter: SalesFilter) => `${formatIsoDate(filter.from)} to ${formatIsoDate(filter.to)}`;
const percent = (value: Decimal | null) => (value === null ? null : `${value.toFixed(1)}%`);

/** One group's sales in a period. `cost` is null for a reader who may not see what goods cost. */
export type SalesRow = { label: string; detail: string | null; quantity: Decimal | null; unit: string | null; amount: Decimal; cost: Decimal | null };

/** "2026-11" as "November 2026". */
export function monthLabel(month: string): string {
  const [year, number] = month.split("-");
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[Number(number) - 1] ?? number} ${year}`;
}

/** The sales of the books for the period set beside what the report adds up to; null where the reader cannot see the books. */
function againstBooks(total: Decimal, books: Decimal | null, width: number): { rows: ReportRow[]; notes: string[] } {
  if (books === null) return { rows: [], notes: [] };
  const difference = total.minus(books);
  const fill = (label: string, value: Decimal): ReportRow => ({ kind: "total", depth: 0, cells: [label, ...Array.from({ length: width - 2 }, () => null), value] });
  return {
    rows: [fill("Sales in the books for the period", books), fill("Difference", difference)],
    notes: difference.isZero() ? [] : ["The sales above and the Sales account in the books do not agree. An entry made to the Sales account by hand would do this; please report it."],
  };
}

/**
 * Sales by customer, item, salesperson, city or month: largest first, with a total. The cost,
 * profit and margin are there only when `cost` is given on the rows (the reader may see costs).
 * `books` is the Sales account in the books for the same period and branch.
 */
export function salesBreakdownTable(report: Exclude<SalesReportKey, "sales-register">, rows: readonly SalesRow[], books: Decimal | null, filter: SalesFilter): ReportTable {
  const spec = SALES_REPORTS[report];
  const withCost = rows.some((row) => row.cost !== null);
  const item = spec.group === "item";
  const heading = { customer: "Customer", item: "Item", salesperson: "Salesperson", city: "City", month: "Month" }[spec.group as SalesGroup];
  const sorted = [...rows].sort((a, b) => b.amount.comparedTo(a.amount) || a.label.localeCompare(b.label));
  const columns = [
    { label: heading, numeric: false },
    ...(item ? [{ label: "Name", numeric: false }, { label: "Quantity sold", numeric: true }] : []),
    { label: "Sales", numeric: true },
    ...(withCost ? [{ label: "Cost of goods sold", numeric: true }, { label: "Profit", numeric: true }, { label: "Margin", numeric: true }] : []),
  ];
  const amount = sum(sorted.map((row) => row.amount));
  const cost = sum(sorted.map((row) => row.cost ?? ZERO));
  const cells = (label: string, detail: string | null, quantity: string | null, sales: Decimal, spent: Decimal | null) => [
    label,
    ...(item ? [detail ?? "", quantity ?? ""] : []),
    sales,
    ...(withCost ? [spent, spent === null ? null : sales.minus(spent), spent === null ? null : percent(marginPercent(sales, spent))] : []),
  ];
  const body = sorted.map((row): ReportRow => ({ kind: "line", depth: 0, cells: cells(row.label, row.detail, row.quantity === null ? null : `${plainQuantity(row.quantity)} ${row.unit ?? ""}`.trim(), row.amount, row.cost) }));
  const compare = againstBooks(amount, books, columns.length - (withCost ? 3 : 0));
  // The difference sits under the Sales column, with the cost columns left empty.
  const padded = compare.rows.map((row) => ({ ...row, cells: [...row.cells, ...(withCost ? [null, null, null] : [])] }));
  return {
    title: spec.title,
    period: period(filter),
    columns,
    rows: [...body, { kind: "grand", depth: 0, cells: cells("Total", null, null, amount, withCost ? cost : null) }, ...padded],
    notes: [
      "Sales are the invoices' values before sales tax, less what credit notes took back, by the date of each document." + (withCost ? " The cost is what those goods left stock at, less what came back onto the shelf." : ""),
      ...(spec.group === "salesperson" ? ["A sale with no salesperson is shown under that heading. Where a line is shared, each person has the share written on it."] : []),
      ...compare.notes,
    ],
  };
}

/** One posted invoice or credit note. A credit note's amounts are negative. */
export type RegisterRow = { date: string; kind: "invoice" | "credit_note"; number: string; customer: string; salesperson: string; amount: Decimal; tax: Decimal; total: Decimal };

/** Every invoice and credit note of a period, one line each, with totals; the amount total is set beside the books. */
export function salesRegisterTable(rows: readonly RegisterRow[], books: Decimal | null, filter: SalesFilter): ReportTable {
  const amount = sum(rows.map((row) => row.amount));
  const tax = sum(rows.map((row) => row.tax));
  const total = sum(rows.map((row) => row.total));
  const compare = againstBooks(amount, books, 7);
  return {
    title: SALES_REPORTS["sales-register"].title,
    period: period(filter),
    columns: [
      { label: "Date", numeric: false },
      { label: "Document", numeric: false },
      { label: "Customer", numeric: false },
      { label: "Salesperson", numeric: false },
      { label: "Amount", numeric: true },
      { label: "Sales tax", numeric: true },
      { label: "Total", numeric: true },
    ],
    rows: [
      ...rows.map((row): ReportRow => ({ kind: "line", depth: 0, cells: [formatIsoDate(row.date), `${row.kind === "invoice" ? "Invoice" : "Credit note"} ${row.number}`, row.customer, row.salesperson, row.amount, row.tax.isZero() ? null : row.tax, row.total] })),
      { kind: "grand", depth: 0, cells: ["Total", null, null, null, amount, tax, total] },
      // The books hold sales before tax, so the comparison is with the Amount column.
      ...compare.rows.map((row) => ({ ...row, cells: [row.cells[0], null, null, null, row.cells[row.cells.length - 1], null, null] })),
    ],
    notes: ["Amounts are before sales tax. Credit notes are shown as minus, so the totals are what was sold less what was taken back.", ...compare.notes],
  };
}
