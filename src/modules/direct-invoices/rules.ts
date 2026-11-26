import { isIsoDate } from "@/modules/currencies/rules";
import { readDraft, type Draft, type RawDocument } from "@/modules/sales/rules";

// One-step "New invoice" (batch A): what is typed for an invoice to a customer on the list, made
// in one go as its order, its delivery and its invoice. The goods, the customer and the
// salespeople are read exactly as a sales order's are; nothing else is typed.

export type RawDirectInvoice = Omit<RawDocument, "kind" | "validUntil"> & { reason?: unknown };

export type DirectInvoice = { order: Draft; reason: string | null };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function readDirectInvoice(raw: RawDirectInvoice, today: string): { ok: true; invoice: DirectInvoice } | { ok: false; reason: string } {
  if (isIsoDate(raw.date) && raw.date > today) return { ok: false, reason: "An invoice is dated today or earlier, never on a day that has not come." };
  const read = readDraft({ ...raw, kind: "order", validUntil: "" });
  if (!read.ok) return read;
  if (read.draft.lines.length === 0) return { ok: false, reason: "Enter at least one line: what the customer is buying." };
  const reason = text(raw.reason);
  return { ok: true, invoice: { order: read.draft, reason: reason === "" ? null : reason } };
}

/** What making the invoice came to: posted; left as an order for the owner to approve; or made but not posted, for stock that is short. */
export type DirectInvoiceOutcome =
  | { status: "posted"; invoiceId: string; invoiceNumber: string; orderNumber: string }
  | { status: "on_hold"; orderId: string; message: string }
  | { status: "short"; invoiceId: string; orderNumber: string; message: string };

/** Where the form goes next: the posted invoice, the order waiting for approval, or the draft invoice with what is short. */
export function nextPage(outcome: DirectInvoiceOutcome): string {
  // The order's page says it waits for approval and why; the draft invoice's page says what is short.
  return `/sales/${outcome.status === "on_hold" ? outcome.orderId : outcome.invoiceId}`;
}
