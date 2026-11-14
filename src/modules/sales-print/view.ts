import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { PROVINCE_LABELS, type Province } from "@/modules/parties/rules";
import { KIND_LABELS } from "@/modules/sales/rules";
import type { PrintableDocument } from "./queries";
import { printedTable, type PrintedTable } from "./rules";

// What a printed sales document says, worked out once for the printed page and the PDF. No I/O.

export type PrintView = {
  title: string;
  number: string;
  /** Set on a cancelled document: it is printed, marked as cancelled, with the reason. */
  cancelled: string | null;
  /** Under the company's name: its tax numbers. */
  seller: string[];
  buyerHeading: string;
  buyer: string[];
  /** Date, due date and the rest, as label and value. */
  facts: [string, string][];
  table: PrintedTable;
  words: string | null;
  notes: string | null;
  /** A delivery note is signed for when the goods are handed over. */
  signatures: string[];
};

const isProvince = (value: string | null): value is Province => value !== null && value in PROVINCE_LABELS;

export function printView(printable: PrintableDocument): PrintView {
  const { document, seller, buyer } = printable;
  const facts: [string, string][] = [["Date", formatIsoDate(document.date)]];
  if (document.validUntil) facts.push(["Valid until", formatIsoDate(document.validUntil)]);
  if (document.dueDate) facts.push(["Due", formatIsoDate(document.dueDate)]);
  if (document.customerReference) facts.push(["Your reference", document.customerReference]);
  if (document.source?.number) facts.push([KIND_LABELS[document.source.kind], document.source.number]);
  if (document.kind === "delivery") facts.push(["From", document.warehouseName]);

  const buyerLines = [
    buyer.address ?? "",
    isProvince(buyer.province) ? PROVINCE_LABELS[buyer.province] : "",
    buyer.ntn ? `NTN ${buyer.ntn}` : "",
    buyer.strn ? `STRN ${buyer.strn}` : "",
    buyer.cnic ? `CNIC ${buyer.cnic}` : "",
  ].filter((line) => line !== "");

  return {
    title: printable.title,
    number: document.number,
    cancelled: document.status === "cancelled" ? (document.cancelReason ?? "") : null,
    seller: [seller.ntn ? `NTN ${seller.ntn}` : "", seller.strn ? `STRN ${seller.strn}` : ""].filter((line) => line !== ""),
    buyerHeading: document.kind === "delivery" ? "Deliver to" : document.kind === "invoice" ? "Bill to" : "For",
    buyer: [buyer.name, ...buyerLines],
    facts,
    table: printedTable({
      lines: document.lines,
      prices: printable.prices,
      taxed: document.taxed,
      pricesIncludeTax: document.pricesIncludeTax,
      currency: document.currency,
      totals: document.totals,
      formatAmount,
    }),
    words: printable.words,
    notes: document.notes,
    signatures: document.kind === "delivery" ? ["Delivered by", "Received by (name, signature and stamp)"] : [],
  };
}
