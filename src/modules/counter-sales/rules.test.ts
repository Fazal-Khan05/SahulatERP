import { describe, expect, it } from "vitest";
import { PHONE_PATTERN, readCounterSale, type RawCounterSale } from "./rules";

const TODAY = "2026-11-15";
const raw = (over: Partial<RawCounterSale> = {}): RawCounterSale => ({
  date: TODAY,
  warehouseId: "w-1",
  buyerName: "Bilal Ahmed",
  buyerPhone: "",
  lines: [{ itemId: "i-1", quantity: "2", unitId: "", unitPrice: "", discountPercent: "" }],
  shares: [],
  method: "cash",
  accountId: "a-1",
  reference: "",
  ...over,
});
const reason = (over: Partial<RawCounterSale>) => {
  const read = readCounterSale(raw(over), TODAY);
  return read.ok ? "ok" : read.reason;
};

describe("readCounterSale", () => {
  it("reads the goods as an order's lines, and the buyer and the payment as typed", () => {
    const read = readCounterSale(raw({ buyerName: "  Sara   Khan ", buyerPhone: " +92 300-1234567 ", method: "bank", reference: " Card 4411 " }), TODAY);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.sale.buyer).toEqual({ name: "Sara Khan", phone: "+92 300-1234567" });
    expect(read.sale.payment).toEqual({ method: "bank", accountId: "a-1", reference: "Card 4411" });
    expect(read.sale.order).toMatchObject({ kind: "order", date: TODAY, warehouseId: "w-1", validUntil: null, customerReference: null });
    expect(read.sale.order.lines.map((line) => line.quantity.toFixed())).toEqual(["2"]);
    expect("customerId" in read.sale.order).toBe(false);
  });

  it("leaves an empty phone and reference out", () => {
    const read = readCounterSale(raw(), TODAY);
    expect(read.ok && [read.sale.buyer.phone, read.sale.payment.reference]).toEqual([null, null]);
  });

  it("says what is wrong, one thing at a time", () => {
    expect(reason({ date: "2026-11-16" })).toBe("A counter sale is recorded on the day of the sale or later, never before it.");
    expect(reason({ buyerName: " x " })).toBe("Enter the buyer's name.");
    expect(reason({ buyerName: "a".repeat(121) })).toBe("The buyer's name: use at most 120 characters.");
    expect(reason({ buyerPhone: "call me" })).toBe("Enter the buyer's phone as digits, such as 0300 1234567, or leave it empty.");
    expect(reason({ date: "15/11/2026" })).toBe("Enter the date.");
    expect(reason({ lines: [] })).toBe("Enter at least one line: what the buyer took.");
    expect(reason({ lines: [{ itemId: "i-1", quantity: "0" }] })).toMatch(/^Line 1, quantity: /);
    expect(reason({ method: "cheque" })).toBe("Choose how the buyer paid: in cash, or into a bank account.");
    expect(reason({ accountId: "" })).toBe("Choose the cash account the money went into.");
    expect(reason({ method: "bank", accountId: "" })).toBe("Choose the bank account the money went into.");
    expect(reason({ reference: "r".repeat(61) })).toBe("Use at most 60 characters for the payment's reference.");
    expect(reason({ shares: [{ userId: "u-1", percent: "60" }] })).toBe("Salespeople: the shares come to 60%, not 100%.");
  });

  it("takes a phone as the database keeps it", () => {
    for (const phone of ["0300 1234567", "03001234567", "+923001234567", "021-35123456"]) expect(PHONE_PATTERN.test(phone), phone).toBe(true);
    for (const phone of ["12345", "0300-", "+ 92300", "phone"]) expect(PHONE_PATTERN.test(phone), phone).toBe(false);
  });
});
