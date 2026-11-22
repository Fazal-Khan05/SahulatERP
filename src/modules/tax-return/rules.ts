import Decimal from "decimal.js";
import type { Cell, ReportRow, ReportTable } from "@/modules/reports/rules";
import { PROVINCE_LABELS, type Province } from "@/modules/parties/rules";

// Step 46: the monthly sales tax return's annexes. Pure rules: the period, the layout of each
// annex, what is missing for a clean file, and how each annex sits beside the ledger. No tax is
// worked out here: every amount is what posting stored, added up.
//
// THE LAYOUTS. FBR gives the exact upload templates only to a signed-in registered taxpayer
// (IRIS); none is in this repository. The columns below follow FBR's published filing guide and
// S.R.O. 55(I)/2025 and 578(I)/2025 as far as those go, and are to be checked against the
// templates downloaded from IRIS before the first return is filed from them. Each annex's
// columns are one list here, so a heading or its place is changed in one line.

export const ANNEX_KEYS = ["annex-c", "annex-c1", "annex-a", "annex-b", "annex-h1"] as const;
export type AnnexKey = (typeof ANNEX_KEYS)[number];

export const ANNEXES: Record<AnnexKey, { title: string; about: string }> = {
  "annex-c": { title: "Annex-C: domestic sales", about: "Every line of the month's posted invoices and credit notes, with its sales tax, further tax and extra tax." },
  "annex-c1": { title: "Annex-C1: payments received", about: "The money set against sales invoices in the month, with how it was paid." },
  "annex-a": { title: "Annex-A: domestic purchases", about: "Every line of the month's posted supplier bills and debit notes, with the input tax." },
  "annex-b": { title: "Annex-B: imports", about: "The month's shipments by goods declaration, with the sales tax paid at import." },
  "annex-h1": { title: "Annex-H1: stock statement", about: "Stock by HS code at cost: opening, imported, purchased, supplied and closing." },
};

export const isAnnexKey = (value: unknown): value is AnnexKey => typeof value === "string" && (ANNEX_KEYS as readonly string[]).includes(value);

// ── The period: one calendar month ──────────────────────────────────────────────────────────────

export type ReturnPeriod = { month: string; from: string; to: string; label: string };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The month asked for ("2026-11"), or the month before today's when none or a bad one is given. */
export function readReturnPeriod(month: unknown, today: string): ReturnPeriod {
  let year = Number(today.slice(0, 4));
  let index = Number(today.slice(5, 7)) - 2; // the month before today's, from 0
  if (index < 0) {
    index = 11;
    year -= 1;
  }
  if (typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    year = Number(month.slice(0, 4));
    index = Number(month.slice(5, 7)) - 1;
  }
  const mm = String(index + 1).padStart(2, "0");
  const last = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  return { month: `${year}-${mm}`, from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, "0")}`, label: `${MONTHS[index]} ${year}` };
}

/** The month before and the month after, for the links beside the period. */
export function neighbouringMonths(period: ReturnPeriod): { previous: string; next: string } {
  const year = Number(period.month.slice(0, 4));
  const index = Number(period.month.slice(5, 7)) - 1;
  const at = (y: number, i: number) => `${y}-${String(i + 1).padStart(2, "0")}`;
  return { previous: index === 0 ? at(year - 1, 11) : at(year, index - 1), next: index === 11 ? at(year + 1, 0) : at(year, index + 1) };
}

// ── The rows, as the database functions give them ───────────────────────────────────────────────

export type AnnexCRow = {
  docKind: "invoice" | "credit_note";
  number: string;
  date: string;
  buyerName: string | null;
  buyerNtn: string | null;
  buyerCnic: string | null;
  buyerStrn: string | null;
  buyerRegistered: boolean;
  buyerProvince: string | null;
  originalNumber: string | null;
  originalDate: string | null;
  lineNo: number;
  hsCode: string | null;
  description: string;
  saleType: string | null;
  taxKind: string;
  taxRate: Decimal;
  quantity: Decimal;
  uom: string | null;
  value: Decimal;
  retailValue: Decimal | null;
  salesTax: Decimal;
  extraTax: Decimal;
  furtherTax: Decimal;
  sroScheduleNo: string | null;
  sroItemSerial: string | null;
  total: Decimal;
};

export type AnnexC1Row = {
  receiptNumber: string;
  receiptDate: string;
  method: "cash" | "bank" | "cheque";
  chequeNumber: string | null;
  chequeBank: string | null;
  reference: string | null;
  buyerName: string | null;
  buyerNtn: string | null;
  buyerCnic: string | null;
  buyerStrn: string | null;
  buyerRegistered: boolean;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceTotal: Decimal;
  invoiceTax: Decimal;
  amount: Decimal;
  allocatedOn: string;
};

export type AnnexARow = {
  docKind: "bill" | "debit_note";
  number: string;
  supplierInvoiceNo: string | null;
  date: string;
  supplierName: string;
  supplierNtn: string | null;
  supplierCnic: string | null;
  supplierStrn: string | null;
  supplierRegistered: boolean;
  supplierProvince: string | null;
  originalNumber: string | null;
  originalDate: string | null;
  lineNo: number;
  lineKind: "goods" | "expense";
  hsCode: string | null;
  description: string | null;
  taxRate: Decimal | null;
  quantity: Decimal | null;
  uom: string | null;
  value: Decimal;
  salesTax: Decimal;
  stWithheld: Decimal;
  total: Decimal;
};

export type AnnexBRow = {
  shipmentNumber: string;
  gdNumber: string | null;
  gdDate: string | null;
  port: string | null;
  origin: string | null;
  supplierName: string;
  hsCodes: string | null;
  customsValue: Decimal | null;
  salesTax: Decimal;
  incomeTax: Decimal;
  allocatedOn: string;
  firstSpreading: boolean;
};

export type AnnexH1Row = {
  itemCode: string | null;
  itemName: string;
  hsCode: string | null;
  uom: string | null;
  taxRate: Decimal | null;
  openingQuantity: Decimal;
  openingValue: Decimal;
  importedQuantity: Decimal;
  importedValue: Decimal;
  purchasedQuantity: Decimal;
  purchasedValue: Decimal;
  suppliedQuantity: Decimal;
  suppliedValue: Decimal;
  otherQuantity: Decimal;
  otherValue: Decimal;
  closingQuantity: Decimal;
  closingValue: Decimal;
};

export type LedgerRow = { control: "output_tax" | "further_tax" | "input_tax" | "wht_sales_tax"; sourceType: string; debit: Decimal; credit: Decimal };

export type TaxReturn = {
  period: ReturnPeriod;
  /** The province the company supplies from, once it has said. */
  province: Province | null;
  c: AnnexCRow[];
  c1: AnnexC1Row[];
  a: AnnexARow[];
  b: AnnexBRow[];
  h1: AnnexH1Row[];
  ledger: LedgerRow[];
};

// ── Small words ─────────────────────────────────────────────────────────────────────────────────

const ZERO = new Decimal(0);
const sum = <T>(rows: T[], pick: (row: T) => Decimal | null) => rows.reduce((total, row) => total.plus(pick(row) ?? ZERO), ZERO);

/** A day as FBR's files write it: DD-MM-YYYY. */
export const fbrDate = (iso: string | null): string | null => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : null);
/** A rate as FBR writes it. Rates are stored as percentages: 18 is "18%". */
export const fbrRate = (rate: Decimal | null): string | null => (rate === null ? null : `${rate.toDecimalPlaces(4).toString()}%`);
const partyType = (registered: boolean) => (registered ? "Registered" : "Unregistered");
const provinceLabel = (value: string | null): string | null => (value && value in PROVINCE_LABELS ? PROVINCE_LABELS[value as Province] : value);
const METHOD_LABELS = { cash: "Cash", bank: "Bank transfer", cheque: "Cheque" } as const;

type Column<Row> = { label: string; numeric: boolean; value: (row: Row, at: number, ctx: { province: Province | null }) => Cell; total?: (rows: Row[]) => Decimal };

function tableOf<Row>(title: string, period: ReturnPeriod, columns: Column<Row>[], rows: Row[], ctx: { province: Province | null }, notes: string[]): ReportTable {
  const lines: ReportRow[] = rows.map((row, at) => ({ kind: "line", depth: 0, cells: columns.map((column) => column.value(row, at, ctx)) }));
  if (rows.length > 0 && columns.some((column) => column.total)) {
    lines.push({ kind: "grand", depth: 0, cells: columns.map((column, at) => (column.total ? column.total(rows) : at === 0 ? "Total" : null)) });
  }
  return { title, period: period.label, columns: columns.map(({ label, numeric }) => ({ label, numeric })), rows: lines, notes };
}

const sr = <Row>(): Column<Row> => ({ label: "Sr.", numeric: false, value: (_row, at) => String(at + 1) });

// ── Annex-C ─────────────────────────────────────────────────────────────────────────────────────

/** Credit notes take away: +1 for an invoice, -1 for a credit note. */
const signC = (row: AnnexCRow) => (row.docKind === "credit_note" ? -1 : 1);
const netC = (pick: (row: AnnexCRow) => Decimal) => (rows: AnnexCRow[]) => sum(rows, (row) => pick(row).times(signC(row)));

export const ANNEX_C_COLUMNS: Column<AnnexCRow>[] = [
  sr(),
  { label: "Buyer NTN", numeric: false, value: (r) => r.buyerNtn },
  { label: "Buyer CNIC", numeric: false, value: (r) => r.buyerCnic },
  { label: "Buyer STRN", numeric: false, value: (r) => r.buyerStrn },
  { label: "Buyer Name", numeric: false, value: (r) => r.buyerName },
  { label: "Buyer Type", numeric: false, value: (r) => partyType(r.buyerRegistered) },
  { label: "Sale Origination Province of Supplier", numeric: false, value: (_r, _at, ctx) => provinceLabel(ctx.province) },
  { label: "Destination of Supply", numeric: false, value: (r) => provinceLabel(r.buyerProvince) },
  { label: "Document Type", numeric: false, value: (r) => (r.docKind === "credit_note" ? "Credit Note" : "Sale Invoice") },
  { label: "Document Number", numeric: false, value: (r) => r.number },
  { label: "Document Date", numeric: false, value: (r) => fbrDate(r.date) },
  { label: "HS Code", numeric: false, value: (r) => r.hsCode },
  { label: "Sale Type", numeric: false, value: (r) => r.saleType },
  { label: "Rate", numeric: false, value: (r) => (r.taxKind === "exempt" ? "Exempt" : fbrRate(r.taxRate)) },
  { label: "Description", numeric: false, value: (r) => r.description },
  { label: "Quantity", numeric: true, value: (r) => r.quantity },
  { label: "UOM", numeric: false, value: (r) => r.uom },
  { label: "Value of Sales Excluding Sales Tax", numeric: true, value: (r) => r.value, total: netC((r) => r.value) },
  { label: "Fixed / Notified Value or Retail Price", numeric: true, value: (r) => r.retailValue },
  { label: "Sales Tax / FED in ST Mode", numeric: true, value: (r) => r.salesTax, total: netC((r) => r.salesTax) },
  { label: "Extra Tax", numeric: true, value: (r) => r.extraTax, total: netC((r) => r.extraTax) },
  { label: "ST Withheld at Source", numeric: true, value: () => null },
  { label: "SRO No. / Schedule No.", numeric: false, value: (r) => r.sroScheduleNo },
  { label: "Item Sr. No.", numeric: false, value: (r) => r.sroItemSerial },
  { label: "Further Tax", numeric: true, value: (r) => r.furtherTax, total: netC((r) => r.furtherTax) },
  { label: "Total Value of Sales", numeric: true, value: (r) => r.total, total: netC((r) => r.total) },
  { label: "Original Invoice Number", numeric: false, value: (r) => r.originalNumber },
  { label: "Original Invoice Date", numeric: false, value: (r) => fbrDate(r.originalDate) },
];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What would be sent back by FBR, or needs a look, before Annex-C is uploaded. */
export function annexCProblems(rows: AnnexCRow[], province: Province | null): string[] {
  const problems: string[] = [];
  if (rows.length > 0 && !province) problems.push("The province the company supplies from is not set. Set it on the sales tax return page.");
  const docs = new Map<string, AnnexCRow>();
  for (const row of rows) docs.set(row.number, row);
  const unnamed = [...docs.values()].filter((d) => !d.buyerRegistered && !d.buyerCnic && !d.buyerNtn).length;
  if (unnamed > 0) problems.push(`${count(unnamed, "document is", "documents are")} to an unregistered buyer with no CNIC or NTN.`);
  const noStrn = [...docs.values()].filter((d) => d.buyerRegistered && !d.buyerStrn && !d.buyerNtn).length;
  if (noStrn > 0) problems.push(`${count(noStrn, "document is", "documents are")} to a registered buyer with no STRN or NTN.`);
  const noHs = rows.filter((r) => !r.hsCode).length;
  if (noHs > 0) problems.push(`${count(noHs, "line has", "lines have")} no HS code.`);
  const noUom = rows.filter((r) => !r.uom).length;
  if (noUom > 0) problems.push(`${count(noUom, "line has", "lines have")} no unit of measure.`);
  const noType = rows.filter((r) => !r.saleType).length;
  if (noType > 0) problems.push(`${count(noType, "line has", "lines have")} no sale type.`);
  const noRetail = rows.filter((r) => r.taxKind === "third_schedule" && r.retailValue === null).length;
  if (noRetail > 0) problems.push(`${count(noRetail, "Third Schedule line has", "Third Schedule lines have")} no retail price.`);
  return problems;
}

const LAYOUT_NOTE = "The columns follow FBR's published guide; check them against the template downloaded from IRIS before the first filing.";

export function annexCTable(data: TaxReturn): ReportTable {
  return tableOf(ANNEXES["annex-c"].title, data.period, ANNEX_C_COLUMNS, data.c, data, [
    ...annexCProblems(data.c, data.province),
    "Credit notes are listed with their own amounts and taken away in the totals.",
    "Sales tax withheld by a buyer who is a withholding agent is not recorded yet, so that column is empty.",
    LAYOUT_NOTE,
  ]);
}

// ── Annex-C1 ────────────────────────────────────────────────────────────────────────────────────

export const ANNEX_C1_COLUMNS: Column<AnnexC1Row>[] = [
  sr(),
  { label: "Buyer NTN", numeric: false, value: (r) => r.buyerNtn },
  { label: "Buyer CNIC", numeric: false, value: (r) => r.buyerCnic },
  { label: "Buyer STRN", numeric: false, value: (r) => r.buyerStrn },
  { label: "Buyer Name", numeric: false, value: (r) => r.buyerName },
  { label: "Buyer Type", numeric: false, value: (r) => partyType(r.buyerRegistered) },
  { label: "Invoice Number", numeric: false, value: (r) => r.invoiceNumber },
  { label: "Invoice Date", numeric: false, value: (r) => fbrDate(r.invoiceDate) },
  { label: "Invoice Value Including Tax", numeric: true, value: (r) => r.invoiceTotal },
  { label: "Sales Tax on Invoice", numeric: true, value: (r) => r.invoiceTax },
  { label: "Payment Received", numeric: true, value: (r) => r.amount, total: (rows) => sum(rows, (r) => r.amount) },
  { label: "Payment Date", numeric: false, value: (r) => fbrDate(r.receiptDate) },
  { label: "Mode of Payment", numeric: false, value: (r) => METHOD_LABELS[r.method] },
  { label: "Instrument Number", numeric: false, value: (r) => r.chequeNumber },
  { label: "Bank", numeric: false, value: (r) => r.chequeBank },
  { label: "Receipt Number", numeric: false, value: (r) => r.receiptNumber },
  { label: "Reference", numeric: false, value: (r) => r.reference },
  { label: "Set Against the Invoice On", numeric: false, value: (r) => fbrDate(r.allocatedOn) },
];

export function annexC1Table(data: TaxReturn): ReportTable {
  const cash = sum(data.c1.filter((r) => r.method === "cash"), (r) => r.amount);
  return tableOf(ANNEXES["annex-c1"].title, data.period, ANNEX_C1_COLUMNS, data.c1, data, [
    ...(cash.gt(0) ? [`Of this, ${cash.toFixed(2)} was received in cash. Section 73 asks for payment through a bank above its limit.`] : []),
    "A payment is listed in the month it was set against the invoice; money received ahead is listed when it is used.",
    LAYOUT_NOTE,
  ]);
}

// ── Annex-A ─────────────────────────────────────────────────────────────────────────────────────

const signA = (row: AnnexARow) => (row.docKind === "debit_note" ? -1 : 1);
const netA = (pick: (row: AnnexARow) => Decimal) => (rows: AnnexARow[]) => sum(rows, (row) => pick(row).times(signA(row)));

export const ANNEX_A_COLUMNS: Column<AnnexARow>[] = [
  sr(),
  { label: "Supplier NTN", numeric: false, value: (r) => r.supplierNtn },
  { label: "Supplier CNIC", numeric: false, value: (r) => r.supplierCnic },
  { label: "Supplier STRN", numeric: false, value: (r) => r.supplierStrn },
  { label: "Supplier Name", numeric: false, value: (r) => r.supplierName },
  { label: "Supplier Type", numeric: false, value: (r) => partyType(r.supplierRegistered) },
  { label: "Sale Origination Province of Supplier", numeric: false, value: (r) => provinceLabel(r.supplierProvince) },
  { label: "Document Type", numeric: false, value: (r) => (r.docKind === "debit_note" ? "Debit Note" : "Purchase Invoice") },
  { label: "Document Number", numeric: false, value: (r) => r.supplierInvoiceNo ?? r.number },
  { label: "Our Number", numeric: false, value: (r) => r.number },
  { label: "Document Date", numeric: false, value: (r) => fbrDate(r.date) },
  { label: "HS Code", numeric: false, value: (r) => r.hsCode },
  { label: "Purchase Type", numeric: false, value: (r) => (r.lineKind === "goods" ? "Goods" : "Services or expense") },
  { label: "Rate", numeric: false, value: (r) => fbrRate(r.taxRate) },
  { label: "Description", numeric: false, value: (r) => r.description },
  { label: "Quantity", numeric: true, value: (r) => r.quantity },
  { label: "UOM", numeric: false, value: (r) => r.uom },
  { label: "Value of Purchases Excluding Sales Tax", numeric: true, value: (r) => r.value, total: netA((r) => r.value) },
  { label: "Sales Tax / FED in ST Mode", numeric: true, value: (r) => r.salesTax, total: netA((r) => r.salesTax) },
  { label: "ST Withheld as Withholding Agent", numeric: true, value: (r) => (r.stWithheld.isZero() ? null : r.stWithheld), total: (rows) => sum(rows, (r) => r.stWithheld) },
  { label: "Total Value of Purchases", numeric: true, value: (r) => r.total, total: netA((r) => r.total) },
  { label: "Original Invoice Number", numeric: false, value: (r) => r.originalNumber },
  { label: "Original Invoice Date", numeric: false, value: (r) => fbrDate(r.originalDate) },
];

export function annexATable(data: TaxReturn): ReportTable {
  const taxed = data.a.filter((r) => r.salesTax.gt(0));
  const noStrn = new Set(taxed.filter((r) => !r.supplierStrn).map((r) => r.number)).size;
  return tableOf(ANNEXES["annex-a"].title, data.period, ANNEX_A_COLUMNS, data.a, data, [
    ...(noStrn > 0 ? [`${count(noStrn, "document carries", "documents carry")} input tax from a supplier with no STRN on its record now.`] : []),
    "In IRIS the purchases are not uploaded: each supplier's invoice appears there once the supplier has declared it, and is claimed. Use this list to tick them off.",
    "The supplier's numbers are as they stand on its record today. Debit notes are taken away in the totals.",
    LAYOUT_NOTE,
  ]);
}

// ── Annex-B ─────────────────────────────────────────────────────────────────────────────────────

export const ANNEX_B_COLUMNS: Column<AnnexBRow>[] = [
  sr(),
  { label: "GD Number", numeric: false, value: (r) => r.gdNumber },
  { label: "GD Date", numeric: false, value: (r) => fbrDate(r.gdDate) },
  { label: "Port", numeric: false, value: (r) => r.port },
  { label: "Origin", numeric: false, value: (r) => r.origin },
  { label: "Supplier", numeric: false, value: (r) => r.supplierName },
  { label: "HS Code(s)", numeric: false, value: (r) => r.hsCodes },
  { label: "Value of Imports", numeric: true, value: (r) => (r.firstSpreading ? r.customsValue : null), total: (rows) => sum(rows, (r) => (r.firstSpreading ? r.customsValue : null)) },
  { label: "Sales Tax Paid at Import", numeric: true, value: (r) => r.salesTax, total: (rows) => sum(rows, (r) => r.salesTax) },
  { label: "Income Tax Paid at Import", numeric: true, value: (r) => r.incomeTax, total: (rows) => sum(rows, (r) => r.incomeTax) },
  { label: "Shipment", numeric: false, value: (r) => r.shipmentNumber },
  { label: "Taken into the Books On", numeric: false, value: (r) => fbrDate(r.allocatedOn) },
];

export function annexBTable(data: TaxReturn): ReportTable {
  const noGd = data.b.filter((r) => !r.gdNumber || !r.gdDate).length;
  return tableOf(ANNEXES["annex-b"].title, data.period, ANNEX_B_COLUMNS, data.b, data, [
    ...(noGd > 0 ? [`${count(noGd, "shipment has", "shipments have")} no goods declaration number or date.`] : []),
    "In IRIS the goods declarations are not uploaded: they come from Customs and are claimed. Use this list to tick them off.",
    "A shipment is listed in the month its charges were spread, which is when the tax paid at import reached the books; a charge that came late is a row of its own.",
    LAYOUT_NOTE,
  ]);
}

// ── Annex-H1 ────────────────────────────────────────────────────────────────────────────────────

/** The stock statement by HS code, unit and rate: FBR asks for goods, not for our item codes. */
export type H1Group = Omit<AnnexH1Row, "itemName"> & { description: string; items: number };

export function groupH1(rows: AnnexH1Row[]): H1Group[] {
  const groups = new Map<string, H1Group>();
  for (const row of rows) {
    const key = JSON.stringify([row.hsCode, row.uom, row.taxRate?.toString() ?? null]);
    const group = groups.get(key);
    if (!group) {
      const { itemName, ...rest } = row;
      groups.set(key, { ...rest, description: itemName, items: 1 });
      continue;
    }
    group.items += 1;
    group.description = `${group.items} items`;
    for (const field of ["openingQuantity", "openingValue", "importedQuantity", "importedValue", "purchasedQuantity", "purchasedValue", "suppliedQuantity", "suppliedValue", "otherQuantity", "otherValue", "closingQuantity", "closingValue"] as const) {
      group[field] = group[field].plus(row[field]);
    }
  }
  return [...groups.values()];
}

const h1Value = (label: string, pick: (r: H1Group) => Decimal): Column<H1Group> => ({ label, numeric: true, value: pick, total: (rows) => sum(rows, pick) });

export const ANNEX_H1_COLUMNS: Column<H1Group>[] = [
  sr(),
  { label: "HS Code", numeric: false, value: (r) => r.hsCode },
  { label: "Description", numeric: false, value: (r) => r.description },
  { label: "UOM", numeric: false, value: (r) => r.uom },
  { label: "Sales Tax Rate", numeric: false, value: (r) => fbrRate(r.taxRate) },
  { label: "Opening Quantity", numeric: true, value: (r) => r.openingQuantity },
  h1Value("Opening Value", (r) => r.openingValue),
  { label: "Imported Quantity", numeric: true, value: (r) => r.importedQuantity },
  h1Value("Imported Value", (r) => r.importedValue),
  { label: "Purchased Quantity", numeric: true, value: (r) => r.purchasedQuantity },
  h1Value("Purchased Value", (r) => r.purchasedValue),
  { label: "Supplied Quantity", numeric: true, value: (r) => r.suppliedQuantity },
  h1Value("Supplied Value (at Cost)", (r) => r.suppliedValue),
  { label: "Other Quantity", numeric: true, value: (r) => r.otherQuantity },
  h1Value("Other Value", (r) => r.otherValue),
  { label: "Closing Quantity", numeric: true, value: (r) => r.closingQuantity },
  h1Value("Closing Value", (r) => r.closingValue),
];

export function annexH1Table(data: TaxReturn): ReportTable {
  const noHs = data.h1.filter((r) => !r.hsCode).length;
  return tableOf(ANNEXES["annex-h1"].title, data.period, ANNEX_H1_COLUMNS, groupH1(data.h1), data, [
    ...(noHs > 0 ? [`Items with no HS code (${noHs}) are listed together on a row without one.`] : []),
    "Every value is what the stock is carried at (cost), as S.R.O. 55(I)/2025 asks. Supplied is net of what customers sent back; purchased is net of what went back to suppliers.",
    "Other is stock counts and adjustments. Opening and what came in, less what was supplied, plus other, is closing.",
    LAYOUT_NOTE,
  ]);
}

export function annexTable(data: TaxReturn, key: AnnexKey): ReportTable {
  if (key === "annex-c") return annexCTable(data);
  if (key === "annex-c1") return annexC1Table(data);
  if (key === "annex-a") return annexATable(data);
  if (key === "annex-b") return annexBTable(data);
  return annexH1Table(data);
}

/**
 * The annex as a bare sheet for upload: the headings and the rows, with no title above and no
 * total or note below.
 */
export function annexSheet(table: ReportTable): { columns: ReportTable["columns"]; rows: Cell[][] } {
  return { columns: table.columns, rows: table.rows.filter((row) => row.kind === "line").map((row) => row.cells) };
}

/** The bare sheet as CSV: no commas inside numbers, every decimal the books hold. */
export function annexCsv(table: ReportTable): string {
  const cell = (value: Cell): string => {
    if (value === null) return "";
    if (typeof value !== "string") return value.toFixed(4).replace(/0{1,2}$/, "");
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const sheet = annexSheet(table);
  const lines = [sheet.columns.map((column) => column.label), ...sheet.rows];
  return `﻿${lines.map((line) => line.map((value) => cell(value)).join(",")).join("\r\n")}\r\n`;
}

// ── Beside the ledger ───────────────────────────────────────────────────────────────────────────

export type ReconLine = {
  label: string;
  /** What the annex adds up to. */
  annex: Decimal;
  /** What the period's journals of the same documents put on the account. */
  ledger: Decimal;
  /** What other journals (by hand, opening entries) put on the same account in the period. */
  other: Decimal;
  agrees: boolean;
};

/**
 * Each annex set beside the books. An annex agrees when its total is what the journals of its
 * own documents put on the account; anything else on the account in the period (a journal by
 * hand, say) is shown beside it, since the return must explain it too.
 */
export function reconcile(data: TaxReturn): ReconLine[] {
  const net = (control: LedgerRow["control"], sources: string[] | null, credit: boolean) =>
    data.ledger
      .filter((row) => row.control === control && (sources === null ? true : sources.includes(row.sourceType)))
      .reduce((total, row) => total.plus(credit ? row.credit.minus(row.debit) : row.debit.minus(row.credit)), ZERO);
  const line = (label: string, annex: Decimal, control: LedgerRow["control"], sources: string[], credit: boolean, others: string[] = []): ReconLine => {
    const ledger = net(control, sources, credit);
    const all = net(control, null, credit);
    const elsewhere = net(control, others, credit);
    return { label, annex, ledger, other: all.minus(ledger).minus(elsewhere), agrees: annex.equals(ledger) };
  };
  const purchases = ["supplier_bill", "supplier_return"];
  const imports = ["landed_cost"];
  return [
    line("Output tax (Annex-C: sales tax and extra tax)", netC((r) => r.salesTax.plus(r.extraTax))(data.c), "output_tax", ["sales_invoice", "credit_note"], true),
    line("Further tax (Annex-C)", netC((r) => r.furtherTax)(data.c), "further_tax", ["sales_invoice", "credit_note"], true),
    line("Input tax on purchases (Annex-A)", netA((r) => r.salesTax)(data.a), "input_tax", purchases, false, imports),
    line("Input tax paid at import (Annex-B)", sum(data.b, (r) => r.salesTax), "input_tax", imports, false, purchases),
    line("Sales tax withheld from suppliers (Annex-A)", sum(data.a, (r) => r.stWithheld), "wht_sales_tax", ["supplier_bill"], true),
  ];
}
