import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { backToSales, documentNote, marketPurchaseHref, readMarketPurchase, shortages, type RawMarketPurchase } from "./rules";

const TODAY = "2026-11-25";
const raw = (over: Partial<RawMarketPurchase> = {}): RawMarketPurchase => ({
  date: TODAY,
  warehouseId: "w",
  sellerKind: "market",
  sellerName: "  Anarkali   Helmet House ",
  sellerPhone: "0300 1234567",
  lines: [{ itemId: "i", unitId: "", quantity: "4", unitCost: "650" }],
  method: "cash",
  accountId: "a",
  ...over,
});
const reason = (over: Partial<RawMarketPurchase>) => {
  const read = readMarketPurchase(raw(over), TODAY);
  return read.ok ? null : read.reason;
};

describe("reading a quick market purchase", () => {
  it("cleans what was typed", () => {
    const read = readMarketPurchase(raw({ memoNo: " CM-118 ", note: " for the Karachi order ", reference: "" }), TODAY);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.purchase.seller).toEqual({ kind: "market", name: "Anarkali Helmet House", phone: "0300 1234567" });
    expect([read.purchase.memoNo, read.purchase.note, read.purchase.payment]).toEqual(["CM-118", "for the Karachi order", { method: "cash", accountId: "a", reference: null }]);
    expect(read.purchase.lines.map((line) => [line.quantity.toFixed(), line.unitCost.toFixed(), line.unitId])).toEqual([["4", "650", null]]);
  });

  it("takes a supplier on the list by its id, and forgets a name typed beside it", () => {
    const read = readMarketPurchase(raw({ sellerKind: "supplier", supplierId: " s ", sellerName: "ignored" }), TODAY);
    expect(read.ok && read.purchase.seller).toEqual({ kind: "supplier", supplierId: "s" });
  });

  it("is dated today or earlier, never later", () => {
    expect(reason({ date: "2026-11-26" })).toBe("A purchase is recorded on the day the goods were bought or later, never before it.");
    expect(reason({ date: "2026-11-24" })).toBeNull();
    expect(reason({ date: "yesterday" })).toBe("Enter the day the goods were bought.");
  });

  it("says the first thing that is wrong, in plain words", () => {
    expect(reason({ sellerKind: "nobody" })).toContain("Say who the goods were bought from");
    expect(reason({ sellerKind: "supplier", supplierId: "" })).toBe("Choose the supplier.");
    expect(reason({ sellerName: "A" })).toBe("Enter the seller's name, or the shop's.");
    expect(reason({ sellerName: "x".repeat(121) })).toContain("at most 120 characters");
    expect(reason({ sellerPhone: "call me" })).toContain("seller's phone as digits");
    expect(reason({ memoNo: "m".repeat(41) })).toContain("at most 40 characters");
    expect(reason({ warehouseId: "" })).toBe("Choose the warehouse the goods came into.");
    expect(reason({ lines: [] })).toContain("Enter at least one line");
    expect(reason({ lines: [{ itemId: "i", quantity: "4", unitCost: "" }] })).toBe("Line 1, cost: Enter what one costs.");
    expect(reason({ lines: [{ itemId: "i", quantity: "4", unitCost: "0" }] })).toBe("Line 1, cost: enter what one cost, more than zero.");
    expect(reason({ lines: [{ itemId: "i", quantity: "0", unitCost: "5" }] })).toContain("Line 1, quantity");
    expect(reason({ lines: [{ itemId: "i", quantity: "1", unitCost: "5" }, { itemId: "i", quantity: "2", unitCost: "6" }] })).toContain("twice in the same unit");
    expect(reason({ lines: [{ itemId: "i", unitId: "ctn", quantity: "1", unitCost: "5" }, { itemId: "i", quantity: "2", unitCost: "6" }] })).toBeNull();
    expect(reason({ method: "cheque" })).toContain("Choose how it was paid");
    expect(reason({ accountId: "" })).toBe("Choose the cash account the money came out of.");
    expect(reason({ method: "bank", accountId: "" })).toBe("Choose the bank account the money came out of.");
    expect(reason({ reference: "r".repeat(61) })).toContain("at most 60 characters");
  });

  it("writes one note for every document it makes", () => {
    expect(documentNote({ seller: { kind: "market", name: "Anarkali Helmet House", phone: "0300 1234567" }, memoNo: "CM-118", note: "For the Karachi order" })).toBe("Quick market purchase from Anarkali Helmet House (0300 1234567), cash memo CM-118. For the Karachi order");
    expect(documentNote({ seller: { kind: "market", name: "Shah Alam Traders", phone: null }, memoNo: null, note: null })).toBe("Quick market purchase from Shah Alam Traders.");
    expect(documentNote({ seller: { kind: "supplier", supplierId: "s" }, memoNo: null, note: null })).toBe("Quick market purchase.");
  });
});

describe("what a delivery is short of", () => {
  const row = (over: Partial<Parameters<typeof shortages>[0][number]>) => ({ itemId: "h", itemCode: "HL-1", description: "Helmet", unitCode: "pc", unitFactor: new Decimal(1), quantity: new Decimal(0), onHand: new Decimal(5), ...over });

  it("is nothing when there is enough, or when nothing is being delivered", () => {
    expect(shortages([row({ quantity: new Decimal(5) })])).toEqual([]);
    expect(shortages([row({ quantity: new Decimal(0), onHand: new Decimal(0) })])).toEqual([]);
  });

  it("adds an item's lines up in the item's own unit", () => {
    const short = shortages([row({ quantity: new Decimal(3) }), row({ quantity: new Decimal(1), unitCode: "ctn", unitFactor: new Decimal(10) }), row({ itemId: "g", itemCode: "GL-1", description: "Gloves", quantity: new Decimal(2), onHand: new Decimal(2) })]);
    expect(short.map((s) => [s.itemCode, s.needed.toFixed(), s.onHand.toFixed(), s.short.toFixed(), s.unitCode])).toEqual([["HL-1", "13", "5", "8", "pc"]]);
  });

  it("names no unit when every line is in a larger one", () => {
    expect(shortages([row({ quantity: new Decimal(1), unitCode: "ctn", unitFactor: new Decimal(10) })])[0]).toMatchObject({ unitCode: null });
  });

  it("builds the address of the purchase, and returns only to a sales document", () => {
    const back = "/sales/0b6f2a52-63b5-4e0e-9c1b-0d7d5a0b1c11";
    expect(marketPurchaseHref([{ itemId: "h", short: new Decimal("8.5") }, { itemId: "g", short: new Decimal(2) }], "w", back)).toBe(`/purchases/market?item=h&quantity=8.5&item=g&quantity=2&warehouse=w&back=${encodeURIComponent(back)}`);
    expect(backToSales(back)).toBe(back);
    for (const elsewhere of ["https://example.com", "//example.com", "/sales/../settings", `${back}/x`, `${back}?x=1`, "/purchases", null, undefined, 5]) expect(backToSales(elsewhere)).toBeNull();
  });
});
