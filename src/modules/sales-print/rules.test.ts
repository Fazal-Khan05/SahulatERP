import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { amountInWords, pdfFileName, printable, printedTable, printTitle, showsPrices } from "./rules";

describe("amountInWords", () => {
  const words = (amount: string) => amountInWords(new Decimal(amount), "PKR");

  it("says small amounts plainly", () => {
    expect(words("0")).toBe("Rupees Zero Only");
    expect(words("7")).toBe("Rupees Seven Only");
    expect(words("19")).toBe("Rupees Nineteen Only");
    expect(words("40")).toBe("Rupees Forty Only");
    expect(words("99")).toBe("Rupees Ninety-Nine Only");
    expect(words("100")).toBe("Rupees One Hundred Only");
    expect(words("1001")).toBe("Rupees One Thousand One Only");
  });

  it("groups by thousand, lakh and crore, the way Pakistan writes amounts", () => {
    expect(words("12345")).toBe("Rupees Twelve Thousand Three Hundred Forty-Five Only");
    expect(words("100000")).toBe("Rupees One Lakh Only");
    expect(words("1245600")).toBe("Rupees Twelve Lakh Forty-Five Thousand Six Hundred Only");
    expect(words("10000000")).toBe("Rupees One Crore Only");
    expect(words("99999999")).toBe("Rupees Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine Only");
  });

  it("says a hundred crore or more as so many crore", () => {
    expect(words("12000000000")).toBe("Rupees One Thousand Two Hundred Crore Only");
    expect(words("9999999999999999")).toBe(
      "Rupees Ninety-Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine Only",
    );
  });

  it("adds the paisa, rounded to the nearest paisa", () => {
    expect(words("10.5")).toBe("Rupees Ten and Fifty Paisa Only");
    expect(words("0.01")).toBe("Rupees Zero and One Paisa Only");
    expect(words("1.0049")).toBe("Rupees One Only");
    expect(words("1.005")).toBe("Rupees One and One Paisa Only");
    expect(words("99.995")).toBe("Rupees One Hundred Only");
  });

  it("says nothing for another currency or an amount below zero", () => {
    expect(amountInWords(new Decimal(10), "USD")).toBeNull();
    expect(amountInWords(new Decimal(-10), "PKR")).toBeNull();
  });
});

describe("what a printed document shows", () => {
  it("calls an invoice a sales tax invoice only when the company charged sales tax", () => {
    expect(printTitle("invoice", true)).toBe("Sales tax invoice");
    expect(printTitle("invoice", false)).toBe("Invoice");
    expect(printTitle("quotation", true)).toBe("Quotation");
    expect(printTitle("order", false)).toBe("Sales order");
    expect(printTitle("delivery", true)).toBe("Delivery note");
  });

  it("prints no prices on a delivery note", () => {
    expect(showsPrices("delivery")).toBe(false);
    expect(showsPrices("invoice")).toBe(true);
    expect(showsPrices("quotation")).toBe(true);
  });

  it("prints only documents that have a number", () => {
    expect(printable("submitted")).toBe(true);
    expect(printable("cancelled")).toBe(true);
    expect(printable("draft")).toBe(false);
    expect(printable("on_hold")).toBe(false);
  });

  it("names the PDF after the document's number, and nothing else", () => {
    expect(pdfFileName("SI-2627-00001")).toBe("SI-2627-00001.pdf");
    expect(pdfFileName("SI-2627/../00001\n")).toBe("SI-262700001.pdf");
  });
});

describe("printedTable", () => {
  const d = (value: string) => new Decimal(value);
  const money = (amount: Decimal) => amount.toFixed(2);
  const line = (over: Partial<Parameters<typeof printedTable>[0]["lines"][number]> = {}) => ({
    itemCode: "BRK-01",
    description: "Brake shoe",
    unitCode: "pcs",
    quantity: d("10"),
    unitPrice: d("100"),
    discountPercent: null,
    taxKind: "standard",
    taxRate: d("18"),
    taxAmount: d("180"),
    furtherTaxAmount: d("0"),
    extraTaxAmount: d("0"),
    value: d("1000"),
    total: d("1180"),
    ...over,
  });
  const totals = { value: d("1000"), tax: d("180"), furtherTax: d("0"), extraTax: d("0"), total: d("1180") };

  it("shows what and how much, and no money, without prices", () => {
    const table = printedTable({ lines: [line({ quantity: d("2.5000") })], prices: false, taxed: true, pricesIncludeTax: false, currency: "PKR", totals, formatAmount: money });
    expect(table.columns.map((c) => c.label)).toEqual(["Item", "Description", "Quantity"]);
    expect(table.rows).toEqual([["BRK-01", "Brake shoe", "2.5 pcs"]]);
    expect(table.totals).toEqual([]);
  });

  it("shows value, rate and tax on each line of a sales tax invoice", () => {
    const table = printedTable({ lines: [line(), line({ taxKind: "exempt", taxRate: d("0"), taxAmount: d("0"), total: d("1000") })], prices: true, taxed: true, pricesIncludeTax: false, currency: "PKR", totals, formatAmount: money });
    expect(table.columns.map((c) => c.label)).toEqual(["Item", "Description", "Quantity", "Price", "Value excl. tax", "Rate", "Sales tax", "Amount"]);
    expect(table.rows[0]).toEqual(["BRK-01", "Brake shoe", "10 pcs", "100.00", "1000.00", "18%", "180.00", "1180.00"]);
    expect(table.rows[1][5]).toBe("Exempt");
    expect(table.totals).toEqual([
      { label: "Value excluding sales tax", amount: "1000.00", strong: false },
      { label: "Sales tax", amount: "180.00", strong: false },
      { label: "Total (PKR)", amount: "1180.00", strong: true },
    ]);
  });

  it("adds discount and further tax columns only when a line has them", () => {
    const table = printedTable({
      lines: [line({ discountPercent: d("5"), furtherTaxAmount: d("40"), total: d("1220") }), line()],
      prices: true,
      taxed: true,
      pricesIncludeTax: true,
      currency: "PKR",
      totals: { ...totals, furtherTax: d("40") },
      formatAmount: money,
    });
    expect(table.columns.map((c) => c.label)).toEqual(["Item", "Description", "Quantity", "Price incl. tax", "Discount", "Value excl. tax", "Rate", "Sales tax", "Further tax", "Amount"]);
    expect(table.rows[0][4]).toBe("5%");
    expect(table.rows[1][4]).toBe("");
    expect(table.rows[1][8]).toBe("");
    expect(table.totals.map((t) => t.label)).toContain("Further tax");
  });

  it("shows the amount alone for a company that does not charge sales tax", () => {
    const table = printedTable({ lines: [line({ taxKind: null, taxRate: d("0"), taxAmount: d("0"), total: d("1000") })], prices: true, taxed: false, pricesIncludeTax: false, currency: "PKR", totals: { ...totals, tax: d("0"), total: d("1000") }, formatAmount: money });
    expect(table.columns.map((c) => c.label)).toEqual(["Item", "Description", "Quantity", "Price", "Amount"]);
    expect(table.totals).toEqual([{ label: "Total (PKR)", amount: "1000.00", strong: true }]);
  });
});
