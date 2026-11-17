import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { figureBill, figureLines, parseBillAmount, readBill, stillToBill, suggestedIncomeTaxCode, type BillDraft, type BillTaxTables, type ReceiptLineToBill, type WithholdingRule } from "./rules";

const d = (value: string | number) => new Decimal(value);
const SUPPLIER = "11111111-1111-4111-8111-111111111111";
const BRANCH = "22222222-2222-4222-8222-222222222222";
const HELMET = "33333333-3333-4333-8333-333333333333";
const STANDARD = "44444444-4444-4444-8444-444444444444";
const RETAIL = "55555555-5555-4555-8555-555555555555";
const FREIGHT = "66666666-6666-4666-8666-666666666666";
const RECEIVED = "77777777-7777-4777-8777-777777777777";

const head = { date: "2026-11-12", supplierId: SUPPLIER, branchId: BRANCH, supplierInvoiceNo: "INV-1" };
const draft = (over: Partial<BillDraft>): BillDraft => ({ ...head, dueDate: null, note: null, incomeTaxCode: null, salesTaxCode: null, provincialTaxCode: null, goods: [], expenses: [], ...over });
const toBill = (over: Partial<ReceiptLineToBill> = {}): ReceiptLineToBill => ({ receiptLineId: RECEIVED, receiptNumber: "GR-2627-00001", receiptDate: "2026-11-11", orderNumber: "PO-2627-00001", itemId: HELMET, itemCode: "HL-1", description: "Helmet", unitCode: "pc", received: d(10), billed: d(0), orderCost: d(600), taxCategoryId: null, ...over });
const tables = (inputTaxAllowed: boolean): BillTaxTables => ({
  inputTaxAllowed,
  categories: new Map([
    [STANDARD, { kind: "standard" }],
    [RETAIL, { kind: "third_schedule" }],
  ]),
  // 17% until 30 June 2026, 18% from 1 July.
  rates: [
    { categoryId: STANDARD, effectiveFrom: "2025-07-01", rate: d(17) },
    { categoryId: STANDARD, effectiveFrom: "2026-07-01", rate: d(18) },
    { categoryId: RETAIL, effectiveFrom: "2026-07-01", rate: d(18) },
  ],
});
const rule = (kind: WithholdingRule["kind"], code: string, base: WithholdingRule["base"], rate: number, rateNonAtl: number | null, effectiveFrom = "2026-07-01"): WithholdingRule => ({ id: code, kind, code, label: code, effectiveFrom, base, rate: d(rate), rateNonAtl: rateNonAtl === null ? null : d(rateNonAtl), legalReference: "the law" });
const rules = [
  rule("income_tax", "income_tax.goods.company", "gross_amount", 4, 8, "2025-07-01"),
  rule("income_tax", "income_tax.goods.company", "gross_amount", 5, 10),
  rule("income_tax", "income_tax.services.other", "gross_amount", 14, 28),
  rule("sales_tax", "sales_tax.active_taxpayer", "sales_tax", 20, null),
  rule("sales_tax", "sales_tax.not_active_taxpayer", "gross_amount", 5, null),
  rule("provincial_sales_tax", "provincial_sales_tax.punjab", "taxable_value", 16, null),
];
const withholds = { withholds: true, salesTaxRegistered: true };

describe("a bill as typed", () => {
  it("is read into a draft: goods with a quantity, expenses with an account, empty rows left out", () => {
    const read = readBill({
      ...head,
      supplierInvoiceNo: "  LP / 771 ",
      dueDate: "2026-12-12",
      incomeTaxCode: "income_tax.goods.company",
      goods: [{ receiptLineId: RECEIVED, quantity: "4", unitPrice: "600.5", taxCategoryId: STANDARD }, { receiptLineId: "other", quantity: "", unitPrice: "1" }, { receiptLineId: "third", quantity: "0", unitPrice: "1" }],
      expenses: [{ accountId: "", description: "", amount: "" }, { accountId: FREIGHT, description: " Freight ", amount: "1500.50", taxCategoryId: "" }],
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.bill).toMatchObject({ supplierInvoiceNo: "LP / 771", dueDate: "2026-12-12", incomeTaxCode: "income_tax.goods.company", salesTaxCode: null, provincialTaxCode: null });
    expect(read.bill.goods.map((line) => [line.receiptLineId, line.quantity.toFixed(), line.unitPrice.toFixed(), line.taxCategoryId])).toEqual([[RECEIVED, "4", "600.5", STANDARD]]);
    expect(read.bill.expenses.map((line) => [line.accountId, line.description, line.amount.toFixed(2), line.taxCategoryId])).toEqual([[FREIGHT, "Freight", "1500.50", null]]);
  });

  it("says the first thing that is wrong", () => {
    const reason = (raw: Parameters<typeof readBill>[0]) => {
      const read = readBill(raw);
      return read.ok ? "" : read.reason;
    };
    expect(reason({ ...head, date: "12 Nov" })).toBe("Enter the date on the supplier's invoice.");
    expect(reason({ ...head, supplierInvoiceNo: " " })).toBe("Enter the number on the supplier's invoice.");
    expect(reason({ ...head, dueDate: "2026-11-11" })).toBe("A bill cannot be due before its own date.");
    // A withholding line is one of its own kind's, by its code.
    expect(reason({ ...head, incomeTaxCode: "sales_tax.active_taxpayer" })).toBe("Choose the withholding lines from the lists.");
    expect(reason({ ...head, provincialTaxCode: "10" })).toBe("Choose the withholding lines from the lists.");
    expect(reason({ ...head, goods: [{ receiptLineId: RECEIVED, quantity: "1", unitPrice: "" }] })).toBe("Goods, line 1, price: Enter the supplier's price for one.");
    expect(reason({ ...head, goods: [{ receiptLineId: RECEIVED, quantity: "1", unitPrice: "5" }, { receiptLineId: RECEIVED, quantity: "2", unitPrice: "5" }] })).toBe("A line of goods received is on the bill twice.");
    expect(reason({ ...head, expenses: [{ accountId: FREIGHT, description: "", amount: "5" }] })).toBe("Expenses, line 1: say what it is for.");
    expect(reason({ ...head, expenses: [{ accountId: "", description: "Freight", amount: "5" }] })).toBe("Expenses, line 1: choose the account it is charged to.");
    expect(reason({ ...head, expenses: [{ accountId: FREIGHT, description: "Freight", amount: "0" }] })).toBe("Expenses, line 1: The amount must be more than zero.");
  });

  it("takes an amount to the paisa and no further", () => {
    expect(parseBillAmount("1500.5")).toEqual({ ok: true, amount: d("1500.5") });
    for (const typed of ["", "1,500", "-5", "1.234", "abc", "0"]) expect(parseBillAmount(typed).ok, typed).toBe(false);
  });
});

describe("the lines of a bill", () => {
  it("bill what is left of what arrived, at the supplier's price, to the paisa", () => {
    expect(stillToBill(toBill({ billed: d(4) })).toFixed()).toBe("6");
    expect(stillToBill(toBill({ billed: d(11) })).toFixed()).toBe("0");
    const figured = figureLines(draft({ goods: [{ receiptLineId: RECEIVED, quantity: d(3), unitPrice: d("33.3333"), taxCategoryId: null }] }), [toBill()], tables(false));
    expect(figured.ok && figured.lines.map((line) => [line.kind, line.itemId, line.description, line.amount.toFixed(2), line.salesTax.toFixed(2), line.taxRate])).toEqual([["goods", HELMET, "Helmet", "100.00", "0.00", null]]);
  });

  it("refuse more than is left, and goods that are not this supplier's to bill", () => {
    const reason = (quantity: string, lines: ReceiptLineToBill[]) => {
      const figured = figureLines(draft({ goods: [{ receiptLineId: RECEIVED, quantity: d(quantity), unitPrice: d(1), taxCategoryId: null }] }), lines, tables(false));
      return figured.ok ? "" : figured.reason;
    };
    expect(reason("11", [toBill()])).toBe("HL-1: 10 arrived on GR-2627-00001, so 11 cannot be billed.");
    expect(reason("7", [toBill({ billed: d(4) })])).toBe("HL-1: 10 arrived on GR-2627-00001 and 4 has been billed, so only 6 more can be billed.");
    expect(reason("1", [])).toContain("these goods were not received from this supplier into this branch");
  });

  it("carry input tax at the rate in force on the bill's date, only where it can be claimed", () => {
    const goods = (taxCategoryId: string | null) => [{ receiptLineId: RECEIVED, quantity: d(10), unitPrice: d(1000), taxCategoryId }];
    const taxed = figureLines(draft({ goods: goods(STANDARD), expenses: [{ accountId: FREIGHT, description: "Freight", amount: d("333.33"), taxCategoryId: STANDARD }] }), [toBill()], tables(true));
    expect(taxed.ok && taxed.lines.map((line) => `${line.taxRate}% ${line.salesTax.toFixed(2)}`)).toEqual(["18% 1800.00", "18% 60.00"]);
    // The same bill dated before the rate changed gets the rate of its own day.
    const earlier = figureLines(draft({ date: "2026-06-30", goods: goods(STANDARD) }), [toBill()], tables(true));
    expect(earlier.ok && earlier.lines[0].salesTax.toFixed(2)).toBe("1700.00");
    const reason = (date: string, category: string, allowed: boolean) => {
      const figured = figureLines(draft({ date, goods: goods(category) }), [toBill()], tables(allowed));
      return figured.ok ? "" : figured.reason;
    };
    expect(reason("2026-11-12", STANDARD, false)).toContain("sales tax can be entered only when your company is registered for sales tax and the supplier is registered with an STRN");
    expect(reason("2026-11-12", RETAIL, true)).toBe("Goods, line 1: goods taxed on their printed retail price cannot carry input tax on a bill yet.");
    expect(reason("2025-01-01", STANDARD, true)).toBe("Goods, line 1: no sales tax rate is in force for that category on the bill's date.");
    expect(reason("2026-11-12", "unknown", true)).toBe("Goods, line 1: choose the tax category from the list.");
  });
});

describe("what a bill comes to and what is withheld", () => {
  const goods = (amount: string, salesTax = "0") => ({ kind: "goods" as const, amount: d(amount), salesTax: d(salesTax) });
  const expense = (amount: string) => ({ kind: "expense" as const, amount: d(amount), salesTax: d(0) });
  const chosen = (over: Partial<{ date: string; incomeTaxCode: string; salesTaxCode: string; provincialTaxCode: string }>) => ({ date: "2026-11-12", incomeTaxCode: null, salesTaxCode: null, provincialTaxCode: null, ...over });
  const figures = (...args: Parameters<typeof figureBill>) => {
    const worked = figureBill(...args);
    if (!worked.ok) return worked.reason;
    const f = worked.figures;
    return `${f.total.toFixed(2)} less ${f.withheld.map((w) => `${w.kind} ${w.rate}% of ${w.base.toFixed(2)} = ${w.amount.toFixed(2)}`).join(", ") || "nothing"}: ${f.payable.toFixed(2)}`;
  };

  it("withholds nothing where no line is chosen", () => {
    expect(figures([goods("2400")], chosen({}), rules, withholds, false)).toBe("2400.00 less nothing: 2400.00");
    expect(figures([], chosen({}), rules, withholds, false)).toBe("Add at least one line to the bill.");
  });

  it("withholds income tax at the rate for a supplier who is, or is not, on the Active Taxpayers List", () => {
    const code = { incomeTaxCode: "income_tax.goods.company" };
    expect(figures([goods("100000")], chosen(code), rules, withholds, false)).toBe("100000.00 less income_tax 10% of 100000.00 = 10000.00: 90000.00");
    expect(figures([goods("100000")], chosen(code), rules, withholds, true)).toBe("100000.00 less income_tax 5% of 100000.00 = 5000.00: 95000.00");
    // A bill dated before the rate changed gets the rate of its own day; before the line existed, none.
    expect(figures([goods("100000")], chosen({ ...code, date: "2026-06-30" }), rules, withholds, true)).toBe("100000.00 less income_tax 4% of 100000.00 = 4000.00: 96000.00");
    expect(figures([goods("100000")], chosen({ ...code, date: "2025-06-30" }), rules, withholds, true)).toBe("The income tax withholding line chosen is not in force on the bill's date.");
  });

  it("withholds sales tax from the tax, or from the gross, as the line says", () => {
    const lines = [goods("10000", "1800")];
    expect(figures(lines, chosen({ incomeTaxCode: "income_tax.goods.company", salesTaxCode: "sales_tax.active_taxpayer" }), rules, withholds, true)).toBe(
      "11800.00 less income_tax 5% of 11800.00 = 590.00, sales_tax 20% of 1800.00 = 360.00: 10850.00",
    );
    expect(figures(lines, chosen({ salesTaxCode: "sales_tax.not_active_taxpayer" }), rules, withholds, false)).toBe("11800.00 less sales_tax 5% of 11800.00 = 590.00: 11210.00");
    // No sales tax on the bill, or a company that is not registered: nothing for the line to be withheld from.
    expect(figures([goods("10000")], chosen({ salesTaxCode: "sales_tax.active_taxpayer" }), rules, withholds, true)).toContain("There is nothing on the bill for the sales tax line to be withheld from.");
    expect(figures(lines, chosen({ salesTaxCode: "sales_tax.active_taxpayer" }), rules, { withholds: true, salesTaxRegistered: false }, true)).toContain("There is nothing on the bill for the sales tax line");
  });

  it("charges the province's tax on the services billed and withholds all of it", () => {
    const lines = [expense("30000"), expense("20000")];
    expect(figures(lines, chosen({ incomeTaxCode: "income_tax.services.other", provincialTaxCode: "provincial_sales_tax.punjab" }), rules, withholds, false)).toBe(
      "58000.00 less income_tax 28% of 58000.00 = 16240.00, provincial_sales_tax 16% of 50000.00 = 8000.00: 33760.00",
    );
    // Goods on the same bill are not services: the province's tax is on the expense lines only.
    expect(figures([goods("1000"), expense("500")], chosen({ provincialTaxCode: "provincial_sales_tax.punjab" }), rules, withholds, true)).toBe("1580.00 less provincial_sales_tax 16% of 500.00 = 80.00: 1500.00");
    expect(figures([goods("1000")], chosen({ provincialTaxCode: "provincial_sales_tax.punjab" }), rules, withholds, true)).toContain("The province's tax is on services.");
  });

  it("refuses any withholding line for a company that does not withhold", () => {
    expect(figures([goods("100000")], chosen({ incomeTaxCode: "income_tax.goods.company" }), rules, { withholds: false, salesTaxRegistered: true }, false)).toContain("Your company does not withhold tax from suppliers.");
  });

  it("suggests the income tax line by what the supplier is and what is billed", () => {
    expect([suggestedIncomeTaxCode("company", true), suggestedIncomeTaxCode("aop", true), suggestedIncomeTaxCode("individual", true), suggestedIncomeTaxCode("company", false)]).toEqual([
      "income_tax.goods.company",
      "income_tax.goods.non_company",
      "income_tax.goods.non_company",
      "income_tax.services.other",
    ]);
  });
});
