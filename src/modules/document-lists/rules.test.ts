import { describe, expect, it } from "vitest";
import { matches, newestFirst, purchaseKindsFor, salesKindsFor, searchTerm } from "./rules";

describe("the All lists", () => {
  it("puts several newest-first lists together newest first, keeping each list's own order within a day", () => {
    const orders = { rows: [{ id: "o2", date: "2026-11-20" }, { id: "o1", date: "2026-11-01" }], more: false };
    const invoices = { rows: [{ id: "i2", date: "2026-11-25" }, { id: "i1b", date: "2026-11-20" }, { id: "i1a", date: "2026-11-20" }], more: false };
    expect(newestFirst([orders, invoices]).rows.map((r) => r.id)).toEqual(["i2", "o2", "i1b", "i1a", "o1"]);
    expect(newestFirst([orders, invoices]).more).toBe(false);
  });

  it("says there is more when one list did, or when the whole is cut short", () => {
    const one = { rows: [{ date: "2026-11-01" }], more: true };
    expect(newestFirst([one]).more).toBe(true);
    const many = { rows: Array.from({ length: 3 }, () => ({ date: "2026-11-01" })), more: false };
    expect(newestFirst([many, many], 5)).toMatchObject({ more: true });
    expect(newestFirst([many, many], 5).rows).toHaveLength(5);
    expect(newestFirst([]).rows).toEqual([]);
  });

  it("searches the number and the party, as typed, ignoring case", () => {
    const term = searchTerm("  karachi\u0007 ");
    expect(term).toBe("karachi");
    expect(matches({ number: "PO-2627-00001", party: "Karachi Traders" }, term)).toBe(true);
    expect(matches({ number: "PB-2627-00007", party: "Lahore Parts" }, searchTerm("pb-2627"))).toBe(true);
    expect(matches({ number: null, party: "Lahore Parts" }, term)).toBe(false);
    expect(matches({ number: null, party: "Anyone" }, searchTerm(""))).toBe(true);
    expect(searchTerm(undefined)).toBe("");
    expect(searchTerm("x".repeat(100))).toHaveLength(80);
  });
});

describe("which kinds each role sees in the All lists", () => {
  it("shows a role only the kinds it already reads", () => {
    expect(salesKindsFor({ role: "owner" })).toEqual(["quotation", "order", "delivery", "invoice", "credit_note"]);
    expect(salesKindsFor({ role: "salesperson" })).toEqual(["quotation", "order", "delivery", "invoice", "credit_note"]);
    // The warehouse reads orders and delivery notes, never what they sell for.
    expect(salesKindsFor({ role: "warehouse_manager" })).toEqual(["order", "delivery"]);
    expect(salesKindsFor({ role: "payroll_administrator" })).toEqual([]);
    expect(purchaseKindsFor({ role: "accountant" })).toEqual(["order", "receipt", "bill", "payment", "return"]);
    expect(purchaseKindsFor({ role: "warehouse_manager" })).toEqual(expect.arrayContaining(["receipt"]));
    expect(purchaseKindsFor({ role: "warehouse_manager" })).not.toContain("bill");
    expect(purchaseKindsFor({ role: "salesperson" })).not.toContain("bill");
  });
});
