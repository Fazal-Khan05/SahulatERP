import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { impliedRate, readAllocations, readChallan, readPayment, settle, type BillOwed } from "./rules";

const d = (value: string | number) => new Decimal(value);
const SUPPLIER = "11111111-1111-4111-8111-111111111111";
const BRANCH = "22222222-2222-4222-8222-222222222222";
const BANK = "33333333-3333-4333-8333-333333333333";
const head = { date: "2026-11-06", supplierId: SUPPLIER, branchId: BRANCH, accountId: BANK, amount: "3400" };
const bill = (billId: string, owed: string, date = "2026-11-04"): BillOwed => ({ billId, number: `PB-${billId}`, supplierInvoiceNo: "x", date, dueDate: null, payable: d(owed), owed: d(owed) });

describe("a payment as typed", () => {
  it("is read into a draft: the rupees paid, what it settles, and a foreign amount kept for the record", () => {
    const read = readPayment({ ...head, reference: " CHQ 1 ", note: "", foreignCurrency: "usd", foreignAmount: "178.57", allocations: [{ billId: "a", amount: "2400" }, { billId: "b", amount: "" }, { billId: "c", amount: "0.00" }] });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.payment).toMatchObject({ date: "2026-11-06", supplierId: SUPPLIER, branchId: BRANCH, accountId: BANK, reference: "CHQ 1", note: null });
    expect([read.payment.amount.toFixed(2), read.payment.foreign?.currency, read.payment.foreign?.amount.toFixed(2)]).toEqual(["3400.00", "USD", "178.57"]);
    expect(read.payment.allocations.map((line) => `${line.billId}:${line.amount.toFixed(2)}`)).toEqual(["a:2400.00"]);
    const plain = readPayment(head);
    expect(plain.ok && [plain.payment.foreign, plain.payment.allocations]).toEqual([null, []]);
  });

  it("says the first thing that is wrong", () => {
    const reason = (raw: Parameters<typeof readPayment>[0]) => {
      const read = readPayment(raw);
      return read.ok ? "" : read.reason;
    };
    expect(reason({ ...head, date: "6 Nov" })).toBe("Enter the day the money was paid.");
    expect(reason({ ...head, supplierId: "" })).toBe("Choose the supplier.");
    expect(reason({ ...head, accountId: " " })).toBe("Choose the cash or bank account the money left.");
    expect(reason({ ...head, amount: "0" })).toBe("Amount paid: The amount must be more than zero.");
    expect(reason({ ...head, amount: "1,000" })).toContain("Amount paid: Enter the amount as a plain number");
    // A foreign amount needs its currency, and a currency its amount.
    expect(reason({ ...head, foreignAmount: "10" })).toBe("Choose the currency the supplier was paid in, or clear the foreign amount.");
    expect(reason({ ...head, foreignCurrency: "USD" })).toBe("Amount in USD: Enter the amount.");
    expect(reason({ ...head, allocations: [{ billId: "a", amount: "1" }, { billId: "a", amount: "2" }] })).toBe("A bill is on the payment twice.");
    expect(reason({ ...head, allocations: [{ billId: "a", amount: "1.234" }] })).toBe("Bill 1: Use at most 2 digits after the point.");
  });

  it("settles no more than two hundred bills at once", () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ billId: `b${index}`, amount: "1" }));
    expect(readAllocations(rows(200)).ok).toBe(true);
    expect(readAllocations(rows(201)).ok).toBe(false);
  });
});

describe("what a sum of money settles", () => {
  const owed = [bill("a", "2400"), bill("b", "3900")];
  const worked = (available: string, on: string, allocations: [string, string][], what: Parameters<typeof settle>[4] = "the payment") => {
    const result = settle(d(available), on, allocations.map(([billId, amount]) => ({ billId, amount: d(amount) })), owed, what);
    return result.ok ? `${result.settled.toFixed(2)} settled, ${result.left.toFixed(2)} left` : result.reason;
  };

  it("is what is set against bills, and the rest is left over as an advance", () => {
    expect(worked("3400", "2026-11-06", [["a", "2400"], ["b", "1000"]])).toBe("3400.00 settled, 0.00 left");
    expect(worked("50000", "2026-11-01", [])).toBe("0.00 settled, 50000.00 left");
    expect(worked("5000", "2026-11-06", [["a", "2400"]])).toBe("2400.00 settled, 2600.00 left");
  });

  it("is never more than is owed on a bill, nor more than the money there is", () => {
    expect(worked("5000", "2026-11-06", [["a", "2400.01"]])).toBe("PB-a: 2400.00 is still owed on it, so 2400.01 cannot be set against it.");
    expect(worked("3000", "2026-11-06", [["a", "2400"], ["b", "1000"]])).toBe("3400.00 is set against bills, more than the payment: 3000.00.");
    expect(worked("0", "2026-11-06", [["a", "1"]], "what is left of the advance")).toBe("1.00 is set against bills, more than what is left of the advance: 0.00.");
    expect(worked("10", "2026-11-06", [["z", "1"]])).toContain("is not an unpaid bill of this supplier in this branch");
  });

  it("never settles a bill on a day before the bill's own: money paid earlier is an advance", () => {
    expect(worked("100", "2026-11-03", [["a", "100"]])).toContain("PB-a is dated 04-11-2026, after this day. Money paid before a bill is an advance");
    expect(worked("100", "2026-11-04", [["a", "100"]])).toBe("100.00 settled, 0.00 left");
  });

  it("shows what a unit of the foreign currency cost, for the record", () => {
    expect(impliedRate(d(50000), d("178.57")).toFixed()).toBe("280.0022");
  });
});

describe("a challan as typed", () => {
  const challan = { kind: "income_tax", paidOn: "2026-11-10", accountId: BANK, challanNo: " IT-1 ", entryIds: ["e1", "e2", "e1", ""] };

  it("is read as one kind of tax, a day, an account, its number and the entries it paid, each once", () => {
    const read = readChallan(challan);
    expect(read.ok && read.challan).toEqual({ kind: "income_tax", paidOn: "2026-11-10", accountId: BANK, challanNo: "IT-1", note: null, entryIds: ["e1", "e2"] });
  });

  it("says the first thing that is wrong", () => {
    const reason = (over: Record<string, unknown>) => {
      const read = readChallan({ ...challan, ...over });
      return read.ok ? "" : read.reason;
    };
    expect(reason({ kind: "customs" })).toBe("Choose which tax the challan paid.");
    expect(reason({ paidOn: "" })).toBe("Enter the day the challan was paid.");
    expect(reason({ accountId: "" })).toBe("Choose the cash or bank account the money left.");
    expect(reason({ challanNo: " " })).toBe("Enter the number on the challan (the CPR number).");
    expect(reason({ entryIds: [] })).toBe("Tick the amounts withheld that this challan paid.");
  });
});
