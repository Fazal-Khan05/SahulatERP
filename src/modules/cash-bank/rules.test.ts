import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { figureExpense, readCancel, readExpense, readNewAccount, readTransfer } from "./rules";

// The figures are those of docs/examples/step-34.md. Checked by Claude, not an accountant.

const d = (value: string | number) => new Decimal(value);
const TODAY = "2026-11-17";
const services = { rate: d(14), rateNonAtl: d(28), base: "gross_amount" as const };

describe("what an expense comes to", () => {
  it("acceptance: 50,000 of repairs in Punjab, from a supplier not on the list", () => {
    const f = figureExpense([d(30000), d(20000)], d(16), services, false)!;
    expect([f.amount, f.provincial, f.total, f.incomeTax, f.withheld, f.paid].map((x) => x.toFixed(2))).toEqual(["50000.00", "8000.00", "58000.00", "16240.00", "24240.00", "33760.00"]);
    expect(f.shares.map((x) => x.toFixed(2))).toEqual(["4800.00", "3200.00"]);
  });

  it("withholds at the lower rate from a supplier on the Active Taxpayers List", () => {
    const f = figureExpense([d(50000)], d(16), services, true)!;
    expect([f.incomeTax, f.paid].map((x) => x.toFixed(2))).toEqual(["8120.00", "41880.00"]);
  });

  it("lets the last line take what is left of the province's tax", () => {
    const f = figureExpense([d(100), d(100), d(100)], d(15), null, false)!;
    expect(f.provincial.toFixed(2)).toBe("45.00");
    expect(f.shares.map((x) => x.toFixed(2))).toEqual(["15.00", "15.00", "15.00"]);
    const odd = figureExpense([d(33.33), d(33.33), d(33.34)], d(16), null, false)!;
    // Shared by largest part cut off: never below nil, even where the last line is tiny.
    const tiny = figureExpense([d(100.03), d(100.03), d(100.03), d(0.01)], d(16), null, false)!;
    expect(tiny.shares.every((x) => x.gte(0))).toBe(true);
    expect(tiny.shares.reduce((sum, x) => sum.plus(x), d(0)).toFixed(2)).toBe(tiny.provincial.toFixed(2));
    // docs/examples/step-34.md, case D: 16.00 shared 5.33, 5.33 and 5.34 (the largest part cut off).
    expect(odd.shares.map((x) => x.toFixed(2))).toEqual(["5.33", "5.33", "5.34"]);
  });

  it("withholds nothing with no tax line, and refuses an income tax line worked out on sales tax", () => {
    const f = figureExpense([d(1200)], null, null, false)!;
    expect([f.total, f.withheld, f.paid].map((x) => x.toFixed(2))).toEqual(["1200.00", "0.00", "1200.00"]);
    expect(figureExpense([d(100)], null, { rate: d(20), rateNonAtl: null, base: "sales_tax" }, false)).toBeNull();
  });
});

describe("what is typed", () => {
  it("reads an expense and says what is wrong, one thing at a time", () => {
    const base = { date: TODAY, accountId: "a", payee: "Tea stall", lines: [{ accountId: "x", description: "Tea", amount: "1,200" }, {}] };
    const read = readExpense(base, TODAY);
    expect(read.ok && read.expense.lines.map((l) => l.amount.toFixed())).toEqual(["1200"]);
    const reason = (over: Record<string, unknown>) => {
      const r = readExpense({ ...base, ...over }, TODAY);
      return r.ok ? "ok" : r.reason;
    };
    expect(reason({ date: "2026-11-18" })).toBe("That date has not come yet.");
    expect(reason({ payee: "" })).toBe("Choose the supplier, or name who was paid.");
    expect(reason({ supplierId: "s" })).toBe("Choose the supplier or name who was paid, not both.");
    expect(reason({ incomeTaxCode: "income_tax.services.other" })).toBe("Tax is withheld from a supplier on the list: choose the supplier.");
    expect(reason({ lines: [] })).toBe("Enter at least one line: what the money was spent on.");
    expect(reason({ lines: [{ accountId: "x", description: "Tea", amount: "0" }] })).toBe("Line 1: Enter an amount above nothing.");
  });

  it("reads a transfer, a new account and a cancellation", () => {
    expect(readTransfer({ fromId: "a", toId: "a", date: TODAY, amount: "1" }, TODAY)).toEqual({ ok: false, reason: "Money is moved between two different accounts." });
    const t = readTransfer({ fromId: "a", toId: "b", date: TODAY, amount: "15,000.50", reference: " Cheque 1001 " }, TODAY);
    expect(t.ok && [t.transfer.amount.toFixed(2), t.transfer.reference]).toEqual(["15000.50", "Cheque 1001"]);
    expect(readNewAccount({ kind: "cash", name: "Petty cash", bankName: "HBL" })).toEqual({ ok: false, reason: "A cash account has no bank or account number." });
    expect(readNewAccount({ kind: "bank", name: "HBL", accountNumber: "PK36 HABB 0000 0011 2345 6702" })).toMatchObject({ ok: true });
    expect(readCancel({ date: TODAY, reason: "x" }, TODAY)).toEqual({ ok: false, reason: "Say why it is cancelled." });
  });
});
