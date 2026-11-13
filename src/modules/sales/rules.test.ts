import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { DatedTaxRate, TaxCategoryForLine } from "@/modules/tax/rules";
import { creditCheck, creditRefusal, documentTotals, leadSalesperson, parsePercent, priceLine, readDraft, readReason, readShares, type DraftLine, type LineItem, type TaxContext } from "./rules";

const d = (value: string) => new Decimal(value);
const STANDARD: TaxCategoryForLine = { id: "standard", kind: "standard", sroScheduleNo: null, sroItemSerial: null };
const THIRD: TaxCategoryForLine = { id: "third", kind: "third_schedule", sroScheduleNo: "Third Schedule", sroItemSerial: "7" };
const RATES: DatedTaxRate[] = [
  { categoryId: "standard", effectiveFrom: "2026-07-01", rate: d("18"), furtherTaxRate: d("4") },
  { categoryId: "third", effectiveFrom: "2026-07-01", rate: d("18"), furtherTaxRate: d("4") },
];
const context = (change: Partial<TaxContext> = {}): TaxContext => ({
  seller: { salesTaxRegistered: false, pricesIncludeTax: false },
  buyer: { registrationType: "unregistered", atlStatus: "unknown" },
  date: "2026-11-13",
  currency: "PKR",
  rates: RATES,
  standardCategory: STANDARD,
  ...change,
});
const item = (change: Partial<LineItem> = {}): LineItem => ({ id: "pad", code: "BP-100", name: "Brake pad", archived: false, baseUnitId: "pc", conversions: [{ unitId: "ctn", factor: d("12") }], taxCategory: null, retailPrice: null, saleType: null, fbrUomCode: "U1000069", hsCode: "8714.9390", ...change });
const typed = (change: Partial<DraftLine> = {}): DraftLine => ({ itemId: "pad", description: null, unitId: null, quantity: d("10"), unitPrice: null, discountPercent: null, ...change });
const worked = (line: DraftLine, it: LineItem, list: string | null, ctx: TaxContext) => {
  const result = priceLine(line, it, list === null ? null : { price: d(list), source: "list" }, ctx);
  if (!result.ok) return result.reason;
  const l = result.line;
  return `${l.quantity.toFixed()} x ${l.unitPrice.toFixed(2)} = ${l.gross.toFixed(2)} - ${l.discountAmount.toFixed(2)} | value ${l.value.toFixed(2)} tax ${l.taxAmount.toFixed(2)} further ${l.furtherTaxAmount.toFixed(2)} total ${l.total.toFixed(2)}`;
};

describe("reading a sales document as typed", () => {
  const base = { kind: "order", date: "2026-11-13", customerId: "c", warehouseId: "w" };
  it("skips empty rows and numbers the lines as they will be kept", () => {
    const read = readDraft({ ...base, lines: [{ itemId: "", quantity: "" }, { itemId: "a", quantity: "2", unitPrice: "10.5", discountPercent: "0" }, {}, { itemId: "b", quantity: "x" }] });
    expect(read).toEqual({ ok: false, reason: "Line 2, quantity: Enter a plain number without commas, such as 12 or 2.5." });
    const good = readDraft({ ...base, lines: [{}, { itemId: "a", quantity: "2", unitPrice: "10.5", discountPercent: "0", description: "  Front   pad " }] });
    expect(good.ok && good.draft.lines).toEqual([{ itemId: "a", description: "Front pad", unitId: null, quantity: d("2"), unitPrice: d("10.5"), discountPercent: null }]);
  });
  it("says what is missing or wrong, one thing at a time", () => {
    const reason = (raw: object) => {
      const read = readDraft(raw);
      return read.ok ? null : read.reason;
    };
    expect(reason({ ...base, kind: "invoice" })).toBe("Choose a quotation or a sales order.");
    expect(reason({ ...base, date: "13-11-2026" })).toBe("Enter the date.");
    expect(reason({ ...base, customerId: " " })).toBe("Choose the customer.");
    expect(reason({ ...base, warehouseId: "" })).toBe("Choose the warehouse the goods leave from.");
    expect(reason({ ...base, validUntil: "2026-12-01" })).toBe("Only a quotation has a last day.");
    expect(reason({ ...base, kind: "quotation", validUntil: "2026-11-01" })).toBe("The quotation's last day cannot be before its date.");
    expect(reason({ ...base, lines: [{ quantity: "1" }] })).toBe("Line 1: choose an item.");
    expect(reason({ ...base, lines: [{ itemId: "a", quantity: "0" }] })).toBe("Line 1, quantity: The quantity must be more than zero.");
    expect(reason({ ...base, lines: [{ itemId: "a", quantity: "1", unitPrice: "1,000" }] })).toBe("Line 1, price: Enter the price as a plain number without commas, such as 500000.");
    expect(reason({ ...base, lines: [{ itemId: "a", quantity: "1", discountPercent: "101" }] })).toBe("Line 1, discount: A percentage cannot be more than 100.");
    expect(reason({ ...base, lines: Array.from({ length: 201 }, () => ({ itemId: "a", quantity: "1" })) })).toBe("A document can have at most 200 lines.");
    expect(reason({ ...base, customerReference: "x".repeat(61) })).toBe("The customer's reference: use at most 60 characters.");
  });
  it("reads percentages and reasons", () => {
    expect(parsePercent("2.5")).toEqual({ ok: true, percent: d("2.5") });
    expect(parsePercent("-1")).toMatchObject({ ok: false });
    expect(parsePercent("1.23456")).toEqual({ ok: false, reason: "Use at most 4 digits after the point." });
    expect(readReason(" ok ", "why")).toEqual({ ok: false, reason: "Say why, in a few words." });
    expect(readReason("  Cheque  due Monday ", "why")).toEqual({ ok: true, reason: "Cheque due Monday" });
  });
});

describe("salespeople's shares", () => {
  it("takes none, or shares that come to exactly 100", () => {
    expect(readShares(undefined)).toEqual({ ok: true, shares: [] });
    expect(readShares([{ userId: "", percent: "" }])).toEqual({ ok: true, shares: [] });
    expect(readShares([{ userId: "a", percent: "" }])).toEqual({ ok: true, shares: [{ userId: "a", percent: d("100") }] });
    expect(readShares([{ userId: "a", percent: "33.3333" }, { userId: "b", percent: "66.6667" }])).toMatchObject({ ok: true });
    expect(readShares([{ userId: "a", percent: "50" }, { userId: "b", percent: "49.9999" }])).toEqual({ ok: false, reason: "Salespeople: the shares come to 99.9999%, not 100%." });
    expect(readShares([{ userId: "a", percent: "50" }, { userId: "a", percent: "50" }])).toEqual({ ok: false, reason: "Salespeople: the same person is listed twice." });
    expect(readShares([{ userId: "", percent: "50" }])).toEqual({ ok: false, reason: "Salespeople: choose who the share is for." });
    expect(readShares([{ userId: "a", percent: "0" }, { userId: "b", percent: "100" }])).toEqual({ ok: false, reason: "Salespeople: a share must be more than zero." });
  });
  it("files the document under the largest share, the first listed on a tie", () => {
    expect(leadSalesperson([])).toBeNull();
    expect(leadSalesperson([{ userId: "a", percent: d("40") }, { userId: "b", percent: d("60") }])).toBe("b");
    expect(leadSalesperson([{ userId: "a", percent: d("50") }, { userId: "b", percent: d("50") }])).toBe("a");
  });
});

describe("working a line out", () => {
  it("takes the price lists' price, times the size of the unit sold", () => {
    expect(worked(typed(), item(), "110", context())).toBe("10 x 110.00 = 1100.00 - 0.00 | value 1100.00 tax 0.00 further 0.00 total 1100.00");
    expect(worked(typed({ unitId: "ctn", quantity: d("2") }), item(), "110", context())).toBe("2 x 1320.00 = 2640.00 - 0.00 | value 2640.00 tax 0.00 further 0.00 total 2640.00");
    const carton = priceLine(typed({ unitId: "ctn", quantity: d("2") }), item(), { price: d("110"), source: "class" }, context());
    expect(carton.ok && [carton.line.baseQuantity.toFixed(), carton.line.unitFactor.toFixed(), carton.line.listPrice?.toFixed(), carton.line.priceSource, carton.line.description]).toEqual(["24", "12", "1320", "class", "Brake pad"]);
  });
  it("takes a typed price over the list's, and a discount off the line, rounded to the paisa", () => {
    expect(worked(typed({ unitPrice: d("99.99"), quantity: d("3"), discountPercent: d("2.5") }), item(), "110", context())).toBe("3 x 99.99 = 299.97 - 7.50 | value 292.47 tax 0.00 further 0.00 total 292.47");
    expect(worked(typed({ quantity: d("0.3333"), unitPrice: d("100.005") }), item(), null, context())).toBe("0.3333 x 100.01 = 33.33 - 0.00 | value 33.33 tax 0.00 further 0.00 total 33.33");
    expect(worked(typed({ discountPercent: d("100") }), item(), "110", context())).toBe("10 x 110.00 = 1100.00 - 1100.00 | value 0.00 tax 0.00 further 0.00 total 0.00");
  });
  it("never guesses: no price, an unknown unit, an inexact quantity, an archived item", () => {
    expect(worked(typed(), item(), null, context())).toBe("BP-100 has no price for this customer. Enter the price.");
    expect(worked(typed({ unitId: "box" }), item(), "110", context())).toBe("BP-100 is not sold in that unit.");
    expect(worked(typed({ unitId: "kg", quantity: d("0.3333") }), item({ conversions: [{ unitId: "kg", factor: d("0.333333") }] }), "110", context())).toBe("That quantity does not come to an exact number of the item's own unit. Enter it in the item's own unit.");
    expect(worked(typed(), item({ archived: true }), "110", context())).toBe("BP-100 is archived and cannot be sold.");
  });
  it("adds the tax engine's tax for a registered seller, and none for one that is not", () => {
    const registered = context({ seller: { salesTaxRegistered: true, pricesIncludeTax: false } });
    expect(worked(typed({ quantity: d("2"), unitPrice: d("1000") }), item(), null, registered)).toBe("2 x 1000.00 = 2000.00 - 0.00 | value 2000.00 tax 360.00 further 80.00 total 2440.00");
    const active = { ...registered, buyer: { registrationType: "registered" as const, atlStatus: "active" as const } };
    expect(worked(typed({ quantity: d("2"), unitPrice: d("1000"), discountPercent: d("10") }), item(), null, active)).toBe("2 x 1000.00 = 2000.00 - 200.00 | value 1800.00 tax 324.00 further 0.00 total 2124.00");
    const inside = { ...active, seller: { salesTaxRegistered: true, pricesIncludeTax: true } };
    expect(worked(typed({ quantity: d("1"), unitPrice: d("1180") }), item(), null, inside)).toBe("1 x 1180.00 = 1180.00 - 0.00 | value 1000.00 tax 180.00 further 0.00 total 1180.00");
    // Third Schedule goods sold by the carton: the retail price is for one piece.
    const retail = item({ taxCategory: THIRD, retailPrice: d("200") });
    expect(worked(typed({ unitId: "ctn", quantity: d("1"), unitPrice: d("1800") }), retail, null, active)).toBe("1 x 1800.00 = 1800.00 - 0.00 | value 1800.00 tax 432.00 further 0.00 total 2232.00");
    expect(worked(typed(), item({ taxCategory: THIRD }), "110", active)).toBe("BP-100: This item is taxed on its retail price. Set the retail price on the item.");
    const untaxed = priceLine(typed(), item(), { price: d("110"), source: "item" }, context());
    expect(untaxed.ok && [untaxed.line.taxKind, untaxed.line.fbrUomCode, untaxed.line.hsCode]).toEqual([null, null, null]);
    const taxed = priceLine(typed(), item(), { price: d("110"), source: "item" }, registered);
    expect(taxed.ok && [taxed.line.taxKind, taxed.line.taxRateFrom, taxed.line.furtherTaxReason, taxed.line.fbrUomCode, taxed.line.hsCode]).toEqual(["standard", "2026-07-01", "buyer_unregistered", "U1000069", "8714.9390"]);
  });
  it("adds the lines up", () => {
    const lines = [typed({ quantity: d("2"), unitPrice: d("1000") }), typed({ quantity: d("3"), unitPrice: d("99.99"), discountPercent: d("2.5") })].map((line) => {
      const result = priceLine(line, item(), null, context({ seller: { salesTaxRegistered: true, pricesIncludeTax: false } }));
      if (!result.ok) throw new Error(result.reason);
      return result.line;
    });
    const totals = documentTotals(lines);
    expect(Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.toFixed(2)]))).toEqual({ gross: "2299.97", discount: "7.50", value: "2292.47", tax: "412.64", furtherTax: "91.70", extraTax: "0.00", total: "2796.81" });
  });
});

describe("the credit limit", () => {
  const facts = { limit: d("50000"), receivable: d("30000"), openOrders: d("15400") };
  it("weighs what is owed, what is on order and this order against the limit", () => {
    expect(creditCheck(facts, d("4600")).over).toBe(false);
    const over = creditCheck(facts, d("4600.01"));
    expect([over.over, over.exposure.toFixed(2), over.after.toFixed(2), over.by.toFixed(2)]).toEqual([true, "45400.00", "50000.01", "0.01"]);
    expect(creditCheck({ ...facts, limit: null }, d("99999999")).over).toBe(false);
    expect(creditCheck({ limit: d("0"), receivable: d("0"), openOrders: d("0") }, d("1")).over).toBe(true);
    // A customer who has paid in advance has room for more.
    expect(creditCheck({ limit: d("1000"), receivable: d("-500"), openOrders: d("0") }, d("1500")).over).toBe(false);
  });
  it("says why in plain words", () => {
    expect(creditRefusal(facts, d("4600"))).toBeNull();
    expect(creditRefusal(facts, d("11000"))).toBe("This order of 11,000.00 takes the customer 6,400.00 over the credit limit of 50,000.00: the customer owes 30,000.00 and has 15,400.00 in other orders.");
    expect(creditRefusal({ ...facts, openOrders: d("0") }, d("25000"))).toBe("This order of 25,000.00 takes the customer 5,000.00 over the credit limit of 50,000.00: the customer owes 30,000.00.");
  });
});
