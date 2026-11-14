import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { allocated, readAllocations, readReason, readReceipt, receiptPosting, suggestAllocation, type RawReceipt } from "./rules";

const d = (value: string) => new Decimal(value);
const D = "2026-11-15";
const cashReceipt: RawReceipt = { date: D, customerId: "c", method: "cash", accountId: "a", amount: "6000" };
const refused = (raw: RawReceipt) => (readReceipt(raw) as { reason?: string }).reason;
const posting = (raw: RawReceipt) => {
  const read = readReceipt(raw);
  if (!read.ok) throw new Error(read.reason);
  return receiptPosting(read.draft).map((line) => `${line.account} ${line.debit.toFixed(2)} / ${line.credit.toFixed(2)}`);
};

describe("what is typed for a receipt", () => {
  it("reads cash against invoices, leaving empty and zero rows out", () => {
    const read = readReceipt({ ...cashReceipt, note: "  Collected at  the shop ", allocations: [{ kind: "invoice", id: "i1", amount: "5000" }, { kind: "invoice", id: "i2", amount: "" }, { kind: "opening", id: "o1", amount: "500.50" }, { kind: "invoice", id: "", amount: "0" }] });
    if (!read.ok) throw new Error(read.reason);
    expect(read.draft).toMatchObject({ method: "cash", accountId: "a", cheque: null, branchId: null, reference: null, note: "Collected at the shop" });
    expect(read.draft.allocations.map((row) => `${row.kind} ${row.id} ${row.amount.toFixed(2)}`)).toEqual(["invoice i1 5000.00", "opening o1 500.50"]);
    expect(allocated(read.draft.allocations).toFixed(2)).toBe("5500.50");
    expect(read.draft.bankCharges.toFixed()).toBe("0");
  });

  it("says what is wrong in plain words", () => {
    expect(refused({ ...cashReceipt, date: "15-11-2026" })).toBe("Enter the date the money was received.");
    expect(refused({ ...cashReceipt, customerId: "" })).toBe("Choose the customer.");
    expect(refused({ ...cashReceipt, method: "barter" })).toBe("Choose how the money came: cash, bank or cheque.");
    expect(refused({ ...cashReceipt, amount: "0" })).toBe("Enter the amount received, above zero.");
    expect(refused({ ...cashReceipt, amount: "6,000" })).toBe("Amount received: Enter the amount as a plain number without commas, such as 500000.");
    expect(refused({ ...cashReceipt, accountId: "" })).toBe("Choose the cash account the money went into.");
    expect(refused({ ...cashReceipt, method: "bank", accountId: "" })).toBe("Choose the bank account the money went into.");
    expect(refused({ ...cashReceipt, method: "bank", bankCharges: "6000" })).toBe("The bank's charges must be less than the amount received.");
    expect(refused({ ...cashReceipt, allocations: [{ kind: "invoice", id: "i1", amount: "4000" }, { kind: "invoice", id: "i2", amount: "2000.01" }] })).toBe(
      "The invoices come to more than the amount received. Lower what is set against them, or raise the amount.",
    );
    expect(refused({ ...cashReceipt, allocations: [{ kind: "invoice", id: "i1", amount: "1" }, { kind: "invoice", id: "i1", amount: "2", label: "SI-1" }] })).toBe("SI-1 is named twice.");
    expect(refused({ ...cashReceipt, allocations: [{ kind: "invoice", id: "i1", amount: "-5", label: "SI-1" }] })).toBe("SI-1: Enter the amount as a plain number without commas, such as 500000.");
    expect(refused({ ...cashReceipt, allocations: [{ kind: "credit", id: "i1", amount: "5", label: "SI-1" }] })).toBe("SI-1: that invoice is not one this receipt can pay.");
  });

  it("reads a cheque with its number, bank and date, and no account until it is deposited", () => {
    const read = readReceipt({ date: D, customerId: "c", method: "cheque", accountId: "a", amount: "2000", bankCharges: "25", chequeNumber: " 00451872 ", chequeBank: "Meezan Bank", chequeDate: "2026-11-20" });
    if (!read.ok) throw new Error(read.reason);
    expect(read.draft).toMatchObject({ method: "cheque", accountId: null, cheque: { number: "00451872", bank: "Meezan Bank", date: "2026-11-20" } });
    // What the bank keeps on a cheque is said when it clears, not when it is received.
    expect(read.draft.bankCharges.toFixed()).toBe("0");
    expect(refused({ date: D, customerId: "c", method: "cheque", amount: "2000" })).toBe("Enter the cheque number, in up to 40 characters.");
    expect(refused({ date: D, customerId: "c", method: "cheque", amount: "2000", chequeNumber: "1" })).toBe("Enter the bank the cheque is drawn on, in up to 80 characters.");
    expect(refused({ date: D, customerId: "c", method: "cheque", amount: "2000", chequeNumber: "1", chequeBank: "HBL" })).toBe("Enter the date written on the cheque.");
  });

  it("says what a receipt will post", () => {
    // Cash, part against invoices and the rest kept as the customer's advance.
    expect(posting({ ...cashReceipt, allocations: [{ kind: "invoice", id: "i1", amount: "5500" }] })).toEqual(["cash 6000.00 / 0.00", "ar 0.00 / 5500.00", "customer_advances 0.00 / 500.00"]);
    // Into the bank, less what the bank kept.
    expect(posting({ date: D, customerId: "c", method: "bank", accountId: "b", amount: "2000", bankCharges: "50", allocations: [{ kind: "invoice", id: "i3", amount: "2000" }] })).toEqual([
      "bank 1950.00 / 0.00",
      "bank_charges 50.00 / 0.00",
      "ar 0.00 / 2000.00",
    ]);
    // A cheque: in hand, in full.
    expect(posting({ date: D, customerId: "c", method: "cheque", amount: "2000", chequeNumber: "1", chequeBank: "HBL", chequeDate: D, allocations: [{ kind: "invoice", id: "i2", amount: "2000" }] })).toEqual([
      "cheques_in_hand 2000.00 / 0.00",
      "ar 0.00 / 2000.00",
    ]);
    // Nothing set against an invoice: all of it is an advance.
    expect(posting(cashReceipt)).toEqual(["cash 6000.00 / 0.00", "customer_advances 0.00 / 6000.00"]);
    // Every posting balances.
    for (const raw of [cashReceipt, { ...cashReceipt, method: "bank", bankCharges: "12.5" }]) {
      const read = readReceipt(raw);
      if (!read.ok) throw new Error(read.reason);
      const lines = receiptPosting(read.draft);
      expect(lines.reduce((sum, line) => sum.plus(line.debit).minus(line.credit), d("0")).toFixed()).toBe("0");
    }
  });

  it("offers the oldest invoices first, until the amount runs out", () => {
    const items = [
      { kind: "opening" as const, id: "o1", outstanding: d("1200") },
      { kind: "invoice" as const, id: "i1", outstanding: d("5000") },
      { kind: "invoice" as const, id: "i2", outstanding: d("3000") },
    ];
    const show = (amount: string) => {
      const { allocations, left } = suggestAllocation(d(amount), items);
      return `${allocations.map((row) => `${row.id} ${row.amount.toFixed()}`).join(", ")} | ${left.toFixed()} over`;
    };
    expect(show("6000")).toBe("o1 1200, i1 4800 | 0 over");
    expect(show("1200")).toBe("o1 1200 | 0 over");
    expect(show("10000")).toBe("o1 1200, i1 5000, i2 3000 | 800 over");
    expect(show("0")).toBe(" | 0 over");
  });

  it("reads rows and reasons typed for later acts", () => {
    expect(readAllocations([{ kind: "invoice", id: "i1", amount: "" }])).toEqual({ ok: true, allocations: [] });
    expect(readReason("  Insufficient   funds ", "why the cheque bounced")).toEqual({ ok: true, reason: "Insufficient funds" });
    expect(readReason("no", "why the cheque bounced")).toEqual({ ok: false, reason: "Say why the cheque bounced, in 3 to 300 characters." });
  });
});
