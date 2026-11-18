import Decimal from "decimal.js";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { parseBillAmount } from "@/modules/supplier-bills/rules";
import type { WithholdingKind } from "@/modules/tax/rules";

// Pure rules for paying suppliers. No I/O.
//
// A payment is typed as a supplier, a branch, the cash or bank account the money leaves, a
// date, the rupees paid, and what it settles of which posted bills. Whatever it does not
// settle is an advance. A payment abroad also says which currency and how much of it the
// rupees bought, for the record only. Everything is decimal.js.

export const PAYMENT_STATUSES = ["draft", "posted", "cancelled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = { draft: "Draft", posted: "Posted", cancelled: "Cancelled" };

/** A payment can settle this many bills at once. */
export const MAX_PAYMENT_BILLS = 200;

const NIL = new Decimal(0);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const isNil = (typed: string) => /^0+(\.0+)?$/.test(typed);

export type RawAllocation = { billId?: unknown; amount?: unknown };
export type Allocation = { billId: string; amount: Decimal };

/** What is set against bills, as typed: a bill left empty or at nil is not paid. */
export function readAllocations(rows: readonly RawAllocation[] | undefined): { ok: true; allocations: Allocation[] } | { ok: false; reason: string } {
  const allocations: Allocation[] = [];
  for (const row of rows ?? []) {
    const billId = text(row.billId);
    const typed = text(row.amount);
    if (billId === "" || typed === "" || isNil(typed)) continue;
    const parsed = parseBillAmount(typed);
    if (!parsed.ok) return { ok: false, reason: `Bill ${allocations.length + 1}: ${parsed.reason}` };
    if (allocations.some((line) => line.billId === billId)) return { ok: false, reason: "A bill is on the payment twice." };
    allocations.push({ billId, amount: parsed.amount });
  }
  if (allocations.length > MAX_PAYMENT_BILLS) return { ok: false, reason: `A payment can settle at most ${MAX_PAYMENT_BILLS} bills.` };
  return { ok: true, allocations };
}

export type RawPayment = {
  date?: unknown;
  supplierId?: unknown;
  branchId?: unknown;
  accountId?: unknown;
  reference?: unknown;
  note?: unknown;
  amount?: unknown;
  foreignCurrency?: unknown;
  foreignAmount?: unknown;
  allocations?: readonly RawAllocation[];
};

export type PaymentDraft = {
  date: string;
  supplierId: string;
  branchId: string;
  accountId: string;
  reference: string | null;
  note: string | null;
  amount: Decimal;
  foreign: { currency: string; amount: Decimal } | null;
  allocations: Allocation[];
};

/** Cleans what was typed for a payment, or gives the first thing that is wrong in plain words. */
export function readPayment(raw: RawPayment): { ok: true; payment: PaymentDraft } | { ok: false; reason: string } {
  if (!isIsoDate(raw.date)) return { ok: false, reason: "Enter the day the money was paid." };
  const supplierId = text(raw.supplierId);
  if (supplierId === "") return { ok: false, reason: "Choose the supplier." };
  const branchId = text(raw.branchId);
  if (branchId === "") return { ok: false, reason: "Choose the branch the payment belongs to." };
  const accountId = text(raw.accountId);
  if (accountId === "") return { ok: false, reason: "Choose the cash or bank account the money left." };
  const reference = cleanText(raw.reference);
  if (reference.length > 60) return { ok: false, reason: "The cheque number or reference: use at most 60 characters." };
  const note = cleanText(raw.note);
  if (note.length > 500) return { ok: false, reason: "Note: use at most 500 characters." };
  const amount = parseBillAmount(raw.amount);
  if (!amount.ok) return { ok: false, reason: `Amount paid: ${amount.reason}` };

  const currency = text(raw.foreignCurrency).toUpperCase();
  const foreignTyped = text(raw.foreignAmount);
  let foreign: PaymentDraft["foreign"] = null;
  if (currency !== "" || foreignTyped !== "") {
    if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, reason: "Choose the currency the supplier was paid in, or clear the foreign amount." };
    const parsed = parseBillAmount(foreignTyped);
    if (!parsed.ok) return { ok: false, reason: `Amount in ${currency}: ${parsed.reason}` };
    foreign = { currency, amount: parsed.amount };
  }
  const read = readAllocations(raw.allocations);
  if (!read.ok) return read;
  return { ok: true, payment: { date: raw.date, supplierId, branchId, accountId, reference: reference === "" ? null : reference, note: note === "" ? null : note, amount: amount.amount, foreign, allocations: read.allocations } };
}

/** A posted bill that is still owed something. */
export type BillOwed = { billId: string; number: string; supplierInvoiceNo: string; date: string; dueDate: string | null; payable: Decimal; owed: Decimal };

/**
 * What a sum of money settles: each amount against a bill that is still owed at least that
 * much, dated on or before the day; in all no more than the money there is. What is left over
 * is an advance (of a payment), stays an advance (of one being set against bills), or stays a
 * credit with the supplier (of goods sent back, Step 27).
 */
export function settle(available: Decimal, on: string, allocations: readonly Allocation[], owed: readonly BillOwed[], what: "the payment" | "what is left of the advance" | "what is left of the credit"): { ok: true; settled: Decimal; left: Decimal } | { ok: false; reason: string } {
  let settled = NIL;
  for (const wanted of allocations) {
    const bill = owed.find((row) => row.billId === wanted.billId);
    if (!bill) return { ok: false, reason: "A bill on the payment is not an unpaid bill of this supplier in this branch. Reload the page." };
    if (bill.date > on) {
      const dated = `${bill.number} is dated ${bill.date.split("-").reverse().join("-")}, after this day.`;
      if (what === "what is left of the credit") return { ok: false, reason: `${dated} A credit is set against a bill on or after the bill's day.` };
      return { ok: false, reason: `${dated} Money paid before a bill is an advance: leave the bill out, and set the advance against it once the bill's day has come.` };
    }
    if (wanted.amount.gt(bill.owed)) return { ok: false, reason: `${bill.number}: ${bill.owed.toFixed(2)} is still owed on it, so ${wanted.amount.toFixed(2)} cannot be set against it.` };
    settled = settled.plus(wanted.amount);
  }
  if (settled.gt(available)) return { ok: false, reason: `${settled.toFixed(2)} is set against bills, more than ${what}: ${available.toFixed(2)}.` };
  return { ok: true, settled, left: available.minus(settled) };
}

/** How many rupees one unit of the foreign currency cost, for showing only; never stored or used in the books. */
export function impliedRate(amount: Decimal, foreignAmount: Decimal): Decimal {
  return amount.div(foreignAmount).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

// ── Challans ────────────────────────────────────────────────────────────────────────────────────

export type RawChallan = { kind?: unknown; paidOn?: unknown; accountId?: unknown; challanNo?: unknown; note?: unknown; entryIds?: readonly unknown[] };
export type ChallanDraft = { kind: WithholdingKind; paidOn: string; accountId: string; challanNo: string; note: string | null; entryIds: string[] };

const KINDS: readonly WithholdingKind[] = ["income_tax", "sales_tax", "provincial_sales_tax"];

/** Cleans what was typed for a challan: one kind of tax, a day, an account, the challan's number and the entries it paid. */
export function readChallan(raw: RawChallan): { ok: true; challan: ChallanDraft } | { ok: false; reason: string } {
  const kind = KINDS.find((known) => known === raw.kind);
  if (!kind) return { ok: false, reason: "Choose which tax the challan paid." };
  if (!isIsoDate(raw.paidOn)) return { ok: false, reason: "Enter the day the challan was paid." };
  const accountId = text(raw.accountId);
  if (accountId === "") return { ok: false, reason: "Choose the cash or bank account the money left." };
  const challanNo = cleanText(raw.challanNo);
  if (challanNo === "") return { ok: false, reason: "Enter the number on the challan (the CPR number)." };
  if (challanNo.length > 60) return { ok: false, reason: "The challan number: use at most 60 characters." };
  const note = cleanText(raw.note);
  if (note.length > 500) return { ok: false, reason: "Note: use at most 500 characters." };
  const entryIds = [...new Set((raw.entryIds ?? []).map(text).filter((id) => id !== ""))];
  if (entryIds.length === 0) return { ok: false, reason: "Tick the amounts withheld that this challan paid." };
  if (entryIds.length > 500) return { ok: false, reason: "A challan can pay at most 500 amounts at once." };
  return { ok: true, challan: { kind, paidOn: raw.paidOn, accountId, challanNo, note: note === "" ? null : note, entryIds } };
}
