import Decimal from "decimal.js";
import { parseAmount } from "@/lib/money";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";

// Pure rules for receipts and cheques. No I/O.
//
// A receipt is money from one customer: how much, how it came (cash, into a bank account, or
// as a cheque), and which unpaid invoices it pays. Whatever it does not set against an invoice
// is the customer's advance. The database posts it and checks everything again; these
// functions read what was typed and say what a receipt will do, for the screens and the tests.

export const RECEIPT_METHODS = ["cash", "bank", "cheque"] as const;
export type ReceiptMethod = (typeof RECEIPT_METHODS)[number];
export const METHOD_LABELS: Record<ReceiptMethod, string> = { cash: "Cash", bank: "Bank transfer or deposit", cheque: "Cheque" };
export const isReceiptMethod = (value: unknown): value is ReceiptMethod => typeof value === "string" && (RECEIPT_METHODS as readonly string[]).includes(value);

export const RECEIPT_STATUSES = ["draft", "posted", "bounced", "cancelled"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export const STATUS_LABELS: Record<ReceiptStatus, string> = { draft: "Draft", posted: "Posted", bounced: "Bounced", cancelled: "Cancelled" };

export const CHEQUE_STAGES = ["received", "deposited", "cleared", "bounced"] as const;
export type ChequeStage = (typeof CHEQUE_STAGES)[number];
export const STAGE_LABELS: Record<ChequeStage, string> = { received: "In hand", deposited: "Deposited", cleared: "Cleared", bounced: "Bounced" };

/** A receipt can name this many invoices. */
export const MAX_RECEIPT_LINES = 200;

/** An invoice or an opening balance a receipt can pay, and how much of it. */
export type Allocation = { kind: "invoice" | "opening"; id: string; amount: Decimal };

export type ReceiptDraft = {
  date: string;
  customerId: string;
  method: ReceiptMethod;
  /** The cash or bank account; nothing for a cheque, which says so when it is deposited. */
  accountId: string | null;
  amount: Decimal;
  bankCharges: Decimal;
  reference: string | null;
  note: string | null;
  branchId: string | null;
  cheque: { number: string; bank: string; date: string } | null;
  allocations: Allocation[];
};

export type RawReceipt = {
  date?: unknown;
  customerId?: unknown;
  method?: unknown;
  accountId?: unknown;
  amount?: unknown;
  bankCharges?: unknown;
  reference?: unknown;
  note?: unknown;
  branchId?: unknown;
  chequeNumber?: unknown;
  chequeBank?: unknown;
  chequeDate?: unknown;
  /** One entry per invoice offered; an amount left empty pays nothing of it. */
  allocations?: readonly { kind?: unknown; id?: unknown; amount?: unknown; label?: string }[];
};

const typed = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Reads what a set of rows pays, each an invoice and an amount; rows with no amount are left out. */
export function readAllocations(rows: RawReceipt["allocations"]): { ok: true; allocations: Allocation[] } | { ok: false; reason: string } {
  const allocations: Allocation[] = [];
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    const text = typed(row.amount);
    if (text === "") continue;
    const at = row.label ?? "An invoice";
    const parsed = parseAmount(text);
    if (!parsed.ok) return { ok: false, reason: `${at}: ${parsed.reason}` };
    // Nothing set against an invoice is the same as leaving its amount empty.
    if (parsed.amount.isZero()) continue;
    const kind = row.kind === "opening" ? "opening" : row.kind === "invoice" ? "invoice" : null;
    const id = typed(row.id);
    if (kind === null || id === "") return { ok: false, reason: `${at}: that invoice is not one this receipt can pay.` };
    if (seen.has(`${kind}:${id}`)) return { ok: false, reason: `${at} is named twice.` };
    seen.add(`${kind}:${id}`);
    allocations.push({ kind, id, amount: parsed.amount });
  }
  if (allocations.length > MAX_RECEIPT_LINES) return { ok: false, reason: `A receipt can pay at most ${MAX_RECEIPT_LINES} invoices. Enter the rest on a second receipt.` };
  return { ok: true, allocations };
}

/** The sum of what a set of rows pays. */
export function allocated(allocations: readonly Pick<Allocation, "amount">[]): Decimal {
  return allocations.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
}

/** Cleans what was typed for a receipt, or gives the first thing that is wrong in plain words. */
export function readReceipt(raw: RawReceipt): { ok: true; draft: ReceiptDraft } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the date the money was received." };
  const customerId = typed(raw.customerId);
  if (customerId === "") return { ok: false, reason: "Choose the customer." };
  if (!isReceiptMethod(raw.method)) return { ok: false, reason: "Choose how the money came: cash, bank or cheque." };
  const method = raw.method;
  const amount = parseAmount(raw.amount);
  if (!amount.ok) return { ok: false, reason: `Amount received: ${amount.reason}` };
  if (amount.amount.isZero()) return { ok: false, reason: "Enter the amount received, above zero." };

  let bankCharges = new Decimal(0);
  if (method === "bank" && typed(raw.bankCharges) !== "") {
    const charges = parseAmount(raw.bankCharges);
    if (!charges.ok) return { ok: false, reason: `Bank charges: ${charges.reason}` };
    if (charges.amount.gte(amount.amount)) return { ok: false, reason: "The bank's charges must be less than the amount received." };
    bankCharges = charges.amount;
  }
  const accountId = method === "cheque" ? null : typed(raw.accountId);
  if (accountId === "") return { ok: false, reason: method === "cash" ? "Choose the cash account the money went into." : "Choose the bank account the money went into." };

  let cheque: ReceiptDraft["cheque"] = null;
  if (method === "cheque") {
    const number = cleanText(raw.chequeNumber);
    const bank = cleanText(raw.chequeBank);
    if (number === "" || number.length > 40) return { ok: false, reason: "Enter the cheque number, in up to 40 characters." };
    if (bank === "" || bank.length > 80) return { ok: false, reason: "Enter the bank the cheque is drawn on, in up to 80 characters." };
    if (!isIsoDate(raw.chequeDate)) return { ok: false, reason: "Enter the date written on the cheque." };
    cheque = { number, bank, date: raw.chequeDate };
  }
  const reference = cleanText(raw.reference);
  if (reference.length > 60) return { ok: false, reason: "Use at most 60 characters for the reference." };
  const note = cleanText(raw.note);
  if (note.length > 500) return { ok: false, reason: "Use at most 500 characters for the note." };

  const read = readAllocations(raw.allocations);
  if (!read.ok) return read;
  const total = allocated(read.allocations);
  if (total.gt(amount.amount)) return { ok: false, reason: "The invoices come to more than the amount received. Lower what is set against them, or raise the amount." };
  return {
    ok: true,
    draft: {
      date: raw.date,
      customerId,
      method,
      accountId,
      amount: amount.amount,
      bankCharges,
      reference: reference === "" ? null : reference,
      note: note === "" ? null : note,
      branchId: typed(raw.branchId) === "" ? null : typed(raw.branchId),
      cheque,
      allocations: read.allocations,
    },
  };
}

export type OpenItem = { kind: "invoice" | "opening"; id: string; number: string; date: string; dueDate: string; total: Decimal; settled: Decimal; outstanding: Decimal };

/**
 * Sets an amount against what a customer owes, the invoice that fell due first before the next,
 * and says what is left over. This is only what the screen offers: the person may change it.
 */
export function suggestAllocation(amount: Decimal, items: readonly Pick<OpenItem, "kind" | "id" | "outstanding">[]): { allocations: Allocation[]; left: Decimal } {
  let left = Decimal.max(amount, 0);
  const allocations: Allocation[] = [];
  for (const item of items) {
    if (left.lte(0)) break;
    if (item.outstanding.lte(0)) continue;
    const pay = Decimal.min(left, item.outstanding);
    allocations.push({ kind: item.kind, id: item.id, amount: pay });
    left = left.minus(pay);
  }
  return { allocations, left };
}

/**
 * What a receipt will post, as account kinds and amounts: debits to where the money went (and
 * to bank charges), credits to what the customer owed and to the customer's advance. The
 * database posts the same; this is for showing it and for the tests.
 */
export function receiptPosting(draft: Pick<ReceiptDraft, "method" | "amount" | "bankCharges" | "allocations">): { account: "cash" | "bank" | "cheques_in_hand" | "bank_charges" | "ar" | "customer_advances"; debit: Decimal; credit: Decimal }[] {
  const zero = new Decimal(0);
  const paid = allocated(draft.allocations);
  const charges = draft.method === "bank" ? draft.bankCharges : zero;
  const lines: ReturnType<typeof receiptPosting> = [{ account: draft.method === "cheque" ? "cheques_in_hand" : draft.method, debit: draft.amount.minus(charges), credit: zero }];
  if (charges.gt(0)) lines.push({ account: "bank_charges", debit: charges, credit: zero });
  if (paid.gt(0)) lines.push({ account: "ar", debit: zero, credit: paid });
  if (draft.amount.gt(paid)) lines.push({ account: "customer_advances", debit: zero, credit: draft.amount.minus(paid) });
  return lines;
}

/** A reason typed for cancelling a receipt or for a bounced cheque: 3 to 300 characters. */
export function readReason(raw: unknown, what: string): { ok: true; reason: string } | { ok: false; reason: string } {
  const reason = cleanText(raw);
  if (reason.length < 3 || reason.length > 300) return { ok: false, reason: `Say ${what}, in 3 to 300 characters.` };
  return { ok: true, reason };
}
