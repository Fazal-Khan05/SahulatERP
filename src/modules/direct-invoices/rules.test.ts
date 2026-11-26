import { describe, expect, it } from "vitest";
import { nextPage, readDirectInvoice } from "./rules";

const TODAY = "2026-11-27";
const ID = "8a3c2f1e-0000-4000-8000-000000000001";
const typed = { date: "2026-11-27", customerId: ID, warehouseId: ID, customerReference: "", notes: "", furtherTaxExcluded: "", lines: [{ itemId: ID, unitId: "", quantity: "2", unitPrice: "", discountPercent: "" }], shares: [] };

describe("reading a one-step invoice", () => {
  it("reads the goods as a sales order's, with the owner's reason when given", () => {
    const read = readDirectInvoice({ ...typed, reason: "  Cheque due Monday " }, TODAY);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.invoice.order.kind).toBe("order");
    expect(read.invoice.order.lines).toHaveLength(1);
    expect(read.invoice.reason).toBe("Cheque due Monday");
    const plain = readDirectInvoice(typed, TODAY);
    expect(plain.ok && plain.invoice.reason).toBeNull();
  });

  it("refuses a day not come and a sale of nothing", () => {
    expect(readDirectInvoice({ ...typed, date: "2026-11-28" }, TODAY)).toEqual({ ok: false, reason: "An invoice is dated today or earlier, never on a day that has not come." });
    expect(readDirectInvoice({ ...typed, lines: [] }, TODAY)).toEqual({ ok: false, reason: "Enter at least one line: what the customer is buying." });
    expect(readDirectInvoice({ ...typed, customerId: "" }, TODAY).ok).toBe(false);
  });

  it("goes on to the invoice, the order waiting for approval, or the draft that is short", () => {
    expect(nextPage({ status: "posted", invoiceId: "i", invoiceNumber: "SI-1", orderNumber: "SO-1" })).toBe("/sales/i");
    expect(nextPage({ status: "on_hold", orderId: "o", message: "" })).toBe("/sales/o");
    expect(nextPage({ status: "short", invoiceId: "d", orderNumber: "SO-1", message: "" })).toBe("/sales/d");
  });
});
