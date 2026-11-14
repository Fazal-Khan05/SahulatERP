import Decimal from "decimal.js";
import type { SalesKind, SalesStatus } from "@/modules/sales/rules";

// Pure rules for printing a sales document and making its PDF. No I/O.
//
// The printed page and the PDF show the same things, worked out here once: the title, which
// columns there are, the file's name and the amount in words.

/** Whether a document can be printed, as the customer would receive it. A draft has no number yet. */
export function printable(status: SalesStatus): boolean {
  return status === "submitted" || status === "cancelled";
}

/**
 * The heading on the page. An invoice of a company registered for sales tax is a sales tax
 * invoice (Sales Tax Act 1990, s.23); otherwise each kind is called what the app calls it.
 */
export function printTitle(kind: SalesKind, taxed: boolean): string {
  switch (kind) {
    case "quotation":
      return "Quotation";
    case "order":
      return "Sales order";
    case "delivery":
      return "Delivery note";
    case "invoice":
      return taxed ? "Sales tax invoice" : "Invoice";
  }
}

/** A delivery note is a goods document: it shows what and how much, never what it sells for. */
export function showsPrices(kind: SalesKind): boolean {
  return kind !== "delivery";
}

/** The PDF's file name: the document's number, which is made only of letters, digits and dashes. */
export function pdfFileName(number: string): string {
  return `${number.replace(/[^A-Za-z0-9-]/g, "")}.pdf`;
}

const ONES = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** 1 to 99. */
function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10]}`;
}

/** 1 to 999. */
function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds > 0 ? `${ONES[hundreds]} Hundred` : "", rest > 0 ? belowHundred(rest) : ""].filter(Boolean).join(" ");
}

/**
 * A whole number in words, grouped the way Pakistan writes amounts: thousand, lakh, crore. A
 * number of a hundred crore or more is said as so many crore ("One Thousand Two Hundred Crore").
 */
function wholeInWords(n: Decimal): string {
  if (n.isZero()) return ONES[0];
  const parts: string[] = [];
  const crore = n.divToInt(10_000_000);
  let rest = n.minus(crore.times(10_000_000)).toNumber();
  if (crore.gt(0)) parts.push(`${wholeInWords(crore)} Crore`);
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`);
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest > 0) parts.push(belowThousand(rest));
  return parts.join(" ");
}

/**
 * An amount in Pakistani rupees in words, as invoices here print it under the total:
 * "Rupees One Lakh Twenty-Five Thousand Only", "Rupees Ten and Fifty Paisa Only". Rounded to the
 * paisa. Null for any other currency, or an amount below zero.
 */
export function amountInWords(amount: Decimal, currency: string): string | null {
  if (currency !== "PKR" || amount.isNegative() || !amount.isFinite()) return null;
  const paisaTotal = amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).times(100);
  const rupees = paisaTotal.divToInt(100);
  const paisa = paisaTotal.minus(rupees.times(100)).toNumber();
  const words = `Rupees ${wholeInWords(rupees)}`;
  return paisa > 0 ? `${words} and ${belowHundred(paisa)} Paisa Only` : `${words} Only`;
}

/** A quantity as people write it: no trailing zeros. */
export function plainQuantity(quantity: Decimal): string {
  return quantity.toFixed(4).replace(/\.?0+$/, "");
}

/** What a printed line needs, a part of the stored line. */
export type LineToPrint = {
  itemCode: string;
  description: string;
  unitCode: string;
  quantity: Decimal;
  unitPrice: Decimal;
  discountPercent: Decimal | null;
  taxKind: string | null;
  taxRate: Decimal;
  taxAmount: Decimal;
  furtherTaxAmount: Decimal;
  extraTaxAmount: Decimal;
  value: Decimal;
  total: Decimal;
};

export type PrintedColumn = { label: string; numeric: boolean };
export type PrintedTotal = { label: string; amount: string; strong: boolean };
/** The lines and totals of a printed document, already in words and figures, for the page and the PDF alike. */
export type PrintedTable = { columns: PrintedColumn[]; rows: string[][]; totals: PrintedTotal[] };

/**
 * The table a printed document shows. Without prices it is what and how much. With prices, a
 * company that charges sales tax shows each line's value, rate and tax, as a sales tax invoice
 * must (Sales Tax Act 1990, s.23); one that does not shows the amount alone. A column that would
 * be empty on every line (discount, further tax, extra tax) is left out.
 */
export function printedTable(input: {
  lines: readonly LineToPrint[];
  prices: boolean;
  taxed: boolean;
  pricesIncludeTax: boolean;
  currency: string;
  totals: { value: Decimal; tax: Decimal; furtherTax: Decimal; extraTax: Decimal; total: Decimal };
  formatAmount: (amount: Decimal) => string;
}): PrintedTable {
  const { lines, formatAmount: money } = input;
  const quantity = (line: LineToPrint) => `${plainQuantity(line.quantity)} ${line.unitCode}`;
  if (!input.prices) {
    return {
      columns: [
        { label: "Item", numeric: false },
        { label: "Description", numeric: false },
        { label: "Quantity", numeric: true },
      ],
      rows: lines.map((line) => [line.itemCode, line.description, quantity(line)]),
      totals: [],
    };
  }
  const discount = lines.some((line) => line.discountPercent !== null && !line.discountPercent.isZero());
  const further = input.taxed && lines.some((line) => !line.furtherTaxAmount.isZero());
  const extra = input.taxed && lines.some((line) => !line.extraTaxAmount.isZero());
  const columns: PrintedColumn[] = [
    { label: "Item", numeric: false },
    { label: "Description", numeric: false },
    { label: "Quantity", numeric: true },
    { label: input.taxed && input.pricesIncludeTax ? "Price incl. tax" : "Price", numeric: true },
  ];
  if (discount) columns.push({ label: "Discount", numeric: true });
  if (input.taxed) {
    columns.push({ label: "Value excl. tax", numeric: true }, { label: "Rate", numeric: true }, { label: "Sales tax", numeric: true });
    if (further) columns.push({ label: "Further tax", numeric: true });
    if (extra) columns.push({ label: "Extra tax", numeric: true });
  }
  columns.push({ label: "Amount", numeric: true });

  const rows = lines.map((line) => {
    const row = [line.itemCode, line.description, quantity(line), money(line.unitPrice)];
    if (discount) row.push(line.discountPercent === null || line.discountPercent.isZero() ? "" : `${line.discountPercent.toFixed()}%`);
    if (input.taxed) {
      row.push(money(line.value), line.taxKind === "exempt" ? "Exempt" : `${line.taxRate.toFixed()}%`, money(line.taxAmount));
      if (further) row.push(line.furtherTaxAmount.isZero() ? "" : money(line.furtherTaxAmount));
      if (extra) row.push(line.extraTaxAmount.isZero() ? "" : money(line.extraTaxAmount));
    }
    row.push(money(line.total));
    return row;
  });

  const totals: PrintedTotal[] = [];
  if (input.taxed) {
    totals.push({ label: "Value excluding sales tax", amount: money(input.totals.value), strong: false });
    totals.push({ label: "Sales tax", amount: money(input.totals.tax), strong: false });
    if (!input.totals.furtherTax.isZero()) totals.push({ label: "Further tax", amount: money(input.totals.furtherTax), strong: false });
    if (!input.totals.extraTax.isZero()) totals.push({ label: "Extra tax", amount: money(input.totals.extraTax), strong: false });
  }
  totals.push({ label: `Total (${input.currency})`, amount: money(input.totals.total), strong: true });
  return { columns, rows, totals };
}
