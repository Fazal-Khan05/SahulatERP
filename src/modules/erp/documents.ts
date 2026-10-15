import { outstanding } from "./engine";
import { D, formatQuantity, money } from "./money";
import type { Document, Receipt, Workspace } from "./types";

/** Everything the standard template needs, resolved from the workspace. Pure data so it renders on the server and in the browser. */
export type DocumentView = {
  kind: string;
  title: string;
  number: string;
  date: string;
  dueDate?: string;
  status: string;
  partyLabel: string;
  /** `taxStatus` is printed when the invoice-time tax snapshot says the buyer was not registered for sales tax. */
  party: { name: string; address: string; taxId: string; email: string; taxStatus?: string };
  meta: { label: string; value: string }[];
  /** `currency` is set only where a line or total is not in the document currency (a USD bill on a PKR payment, the PKR equivalent). */
  lines: { description: string; detail: string; quantity: string; unit: string; rate: string; discount: string; taxRate: string; amount: string; currency?: string }[];
  totals: { label: string; value: string; emphasis?: boolean; credit?: boolean; currency?: string }[];
  notes: string;
  currency: string;
};

export const printableKinds = ["quotation", "sales_order", "delivery", "sales_invoice", "credit_note", "purchase_order", "goods_receipt", "supplier_invoice", "supplier_return", "receipt"] as const;
export type PrintableKind = typeof printableKinds[number];

const titles: Record<string, string> = {
  quotation: "Quotation", sales_order: "Sales order", delivery: "Delivery note", sales_invoice: "Sales invoice", credit_note: "Credit note",
  purchase_order: "Purchase order", goods_receipt: "Goods receipt note", supplier_invoice: "Supplier bill", supplier_return: "Supplier return", receipt: "Receipt",
};
export const documentTitle = (kind: string) => titles[kind] ?? kind.replaceAll("_", " ");
/** The name a document shows: the typed name for walk-in sales/purchases, otherwise the saved party's name. */
export const documentPartyName = (w: Pick<Workspace, "parties">, doc: Pick<Document, "partyId" | "partyName">) => doc.partyName || w.parties.find(p => p.id === doc.partyId)?.name || "—";
/** Shared accounts that take documents for people the user chose not to save. */
export const walkInName = (type: "customer" | "supplier") => type === "customer" ? "Walk-in customer" : "Walk-in supplier";

const isSales = (kind: string) => ["quotation", "sales_order", "delivery", "sales_invoice", "credit_note"].includes(kind);

export function documentView(w: Workspace, doc: Document): DocumentView {
  const party = w.parties.find(p => p.id === doc.partyId);
  const warehouse = w.warehouses.find(x => x.id === doc.warehouseId);
  const source = w.documents.find(x => x.id === doc.parentId);
  const salesperson = doc.lines.map(l => w.employees.find(e => e.id === l.employeeId)?.name).find(Boolean);
  const lines = doc.lines.map(l => {
    const item = w.items.find(i => i.id === l.itemId);
    const net = D(l.quantity).mul(l.price).mul(D(100).minus(l.discount)).div(100);
    return { description: item?.name ?? "Product", detail: item?.sku ?? "", quantity: formatQuantity(l.quantity), unit: item?.unit ?? "", rate: money(l.price), discount: l.discount, taxRate: l.taxRate, amount: money(net) };
  });
  const taxByRate = new Map<string, ReturnType<typeof D>>();
  for (const l of doc.lines) {
    const net = D(l.quantity).mul(l.price).mul(D(100).minus(l.discount)).div(100);
    taxByRate.set(l.taxRate, (taxByRate.get(l.taxRate) ?? D(0)).plus(net.mul(l.taxRate).div(100)));
  }
  const totals: DocumentView["totals"] = [{ label: "Subtotal", value: money(doc.net) }];
  for (const [rate, amount] of taxByRate) if (!amount.isZero()) totals.push({ label: `Sales tax ${D(rate).toString()}%`, value: money(amount) });
  totals.push({ label: "Total", value: money(doc.total), emphasis: true });
  // Foreign-currency documents also state the PKR value at the document's own rate, the amount the ledger posts.
  if (doc.currency !== "PKR") totals.push({ label: "Total in PKR", value: money(D(doc.total).mul(doc.fxRate)), currency: "PKR" });
  if (doc.kind === "sales_invoice" || doc.kind === "supplier_invoice") {
    if (!D(doc.paid).isZero()) totals.push({ label: "Paid", value: `− ${money(doc.paid)}` });
    if (!D(doc.returned).isZero()) totals.push({ label: "Returns / credits", value: `− ${money(doc.returned)}` });
    const balance = D(outstanding(doc));
    totals.push(balance.lt(0) ? { label: doc.kind === "sales_invoice" ? "Customer credit" : "Credit with supplier", value: money(balance.negated()), emphasis: true, credit: true } : { label: "Balance due", value: money(balance), emphasis: true });
  }
  const meta: DocumentView["meta"] = [];
  if (warehouse && w.warehouses.length > 1) meta.push({ label: "Warehouse", value: warehouse.name });
  if (party) meta.push({ label: "Terms", value: `${party.terms} days` });
  if (salesperson) meta.push({ label: "Salesperson", value: salesperson });
  if (source) meta.push({ label: "Reference", value: source.number });
  if (doc.currency !== "PKR") meta.push({ label: "Exchange rate", value: `1 ${doc.currency} = ${D(doc.fxRate).toString()} PKR` });
  return {
    kind: doc.kind, title: documentTitle(doc.kind), number: doc.number, date: doc.date, dueDate: doc.dueDate, status: doc.status,
    partyLabel: isSales(doc.kind) ? "Bill to" : "Supplier",
    // Tax details come from the snapshot taken when the invoice was submitted (credit notes inherit it), so a reprint
    // shows the buyer's registration as it was then; documents without a snapshot show the party's current details.
    party: doc.partyName ? { name: doc.partyName, address: "", taxId: "", email: "" } : {
      name: party?.name ?? "—", address: party?.city ?? "", email: party?.email ?? "",
      taxId: doc.taxSnapshot ? doc.taxSnapshot.taxId : party?.taxId ?? "",
      ...(doc.taxSnapshot && !doc.taxSnapshot.registered ? { taxStatus: "Unregistered for sales tax" } : {}),
    },
    meta, lines, totals, notes: doc.notes, currency: doc.currency,
  };
}

export function receiptView(w: Workspace, receipt: Receipt): DocumentView {
  const party = w.parties.find(p => p.id === receipt.partyId);
  const lines = receipt.allocations.map(a => {
    const invoice = w.documents.find(d => d.id === a.invoiceId);
    return { description: invoice ? `${documentTitle(invoice.kind)} ${invoice.number}` : "Invoice", detail: invoice ? `Dated ${invoice.date}` : "", quantity: "", unit: "", rate: "", discount: "", taxRate: "", amount: money(a.amount), ...(invoice && invoice.currency !== "PKR" ? { currency: invoice.currency } : {}) };
  });
  const meta: DocumentView["meta"] = [{ label: "Method", value: receipt.method === "cheque" ? `Cheque ${receipt.chequeNo}` : receipt.method === "bank" ? "Bank transfer" : "Cash" }, { label: "Status", value: receipt.status }];
  if (receipt.method === "cheque") meta.push({ label: "Cheque date", value: receipt.dueDate });
  return {
    kind: "receipt", title: party?.type === "supplier" ? "Payment voucher" : "Receipt", number: receipt.number, date: receipt.date, status: receipt.status,
    partyLabel: party?.type === "supplier" ? "Paid to" : "Received from",
    party: { name: party?.name ?? "—", address: party?.city ?? "", taxId: party?.taxId ?? "", email: party?.email ?? "" },
    // The amount paid is PKR; each allocation is in its invoice's currency (they add up to the amount for PKR invoices).
    meta, lines, totals: [{ label: "Amount", value: money(receipt.amount), emphasis: true }], notes: receipt.note, currency: "PKR",
  };
}

/** A realistic sample used by the live branding preview when the company has no invoice yet. */
export function sampleInvoiceView(): DocumentView {
  return {
    kind: "sales_invoice", title: "Sales invoice", number: "INV-2026-0001", date: "2026-10-14", dueDate: "2026-11-13", status: "submitted", partyLabel: "Bill to",
    party: { name: "Al-Noor Electronics", address: "Karachi", taxId: "1234567-8", email: "accounts@alnoor.example" },
    meta: [{ label: "Terms", value: "30 days" }, { label: "Salesperson", value: "Hamza Khan" }],
    lines: [
      { description: "LED Panel Light · 24W", detail: "EL-001", quantity: "100", unit: "pcs", rate: "2400.0000", discount: "0", taxRate: "18", amount: "240000.0000" },
      { description: "Smart Extension Board", detail: "EL-002", quantity: "50", unit: "pcs", rate: "3200.0000", discount: "0", taxRate: "18", amount: "160000.0000" },
    ],
    totals: [{ label: "Subtotal", value: "400000.0000" }, { label: "Sales tax 18%", value: "72000.0000" }, { label: "Total", value: "472000.0000", emphasis: true }, { label: "Balance due", value: "472000.0000", emphasis: true }],
    notes: "Thank you for your business.", currency: "PKR",
  };
}
