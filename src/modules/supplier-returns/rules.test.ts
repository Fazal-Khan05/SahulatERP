import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { stillToBill } from "@/modules/supplier-bills/rules";
import { settle } from "@/modules/supplier-payments/rules";
import { readReturn, returnEstimate, returnLines, type Returnable } from "./rules";

const d = (value: string) => new Decimal(value);
const RECEIPT = "11111111-1111-4111-8111-111111111111";
const LINE = "22222222-2222-4222-8222-222222222222";
const BILL_LINE = "33333333-3333-4333-8333-333333333333";

const unbilled: Returnable = { receiptLineId: LINE, billLineId: null, lineNo: 1, itemId: "item", itemCode: "HL-1", description: "Helmet", unitCode: "ctn", unitFactor: d("12"), available: d("4"), unitValue: d("7200"), unitTax: d("0"), billNumber: null, billDate: null, inStock: d("60") };
const billed: Returnable = { ...unbilled, billLineId: BILL_LINE, available: d("6"), unitValue: d("7500"), unitTax: d("1350"), billNumber: "PB-2627-00007", billDate: "2026-11-04" };

describe("reading a return", () => {
  const typed = { date: "2026-11-06", receiptId: RECEIPT, reason: "  Damaged   in transit ", supplierReference: " CN-9 ", lines: [{ receiptLineId: LINE, quantity: "2" }, { receiptLineId: LINE, billLineId: BILL_LINE, quantity: "1.5" }] };

  it("cleans what was typed and keeps unbilled and billed goods of one line apart", () => {
    const read = readReturn(typed);
    expect(read.ok && { ...read.draft, lines: read.draft.lines.map((line) => `${line.billLineId ?? "unbilled"} ${line.quantity.toFixed()}`) }).toEqual({
      date: "2026-11-06",
      receiptId: RECEIPT,
      reason: "Damaged in transit",
      supplierReference: "CN-9",
      lines: ["unbilled 2", `${BILL_LINE} 1.5`],
    });
  });

  it("leaves out rows left empty or at nil, and needs at least one", () => {
    const read = readReturn({ ...typed, lines: [{ receiptLineId: LINE, quantity: "" }, { receiptLineId: LINE, billLineId: BILL_LINE, quantity: "0.00" }] });
    expect(read).toEqual({ ok: false, reason: "Enter how much goes back of at least one line." });
  });

  it("says what is wrong in plain words", () => {
    const reason = (over: object) => {
      const read = readReturn({ ...typed, ...over });
      return read.ok ? null : read.reason;
    };
    expect(reason({ date: "06/11/2026" })).toBe("Enter the day the goods went back.");
    expect(reason({ receiptId: "" })).toBe("Choose the goods received note the goods came in on.");
    expect(reason({ reason: "no" })).toBe("Say why the goods are going back, in a few words.");
    expect(reason({ reason: "x".repeat(301) })).toBe("The reason: use at most 300 characters.");
    expect(reason({ supplierReference: "x".repeat(61) })).toBe("The supplier's credit note number: use at most 60 characters.");
    expect(reason({ lines: [{ receiptLineId: LINE, quantity: "two" }] })).toMatch(/^Line 1, quantity: /);
    expect(reason({ lines: [{ receiptLineId: LINE, quantity: "1" }, { receiptLineId: LINE, quantity: "2" }] })).toBe("The same goods are on the return twice.");
  });
});

describe("the lines of a return", () => {
  const want = (quantity: string, billLineId: string | null = null) => ({ receiptLineId: LINE, billLineId, quantity: d(quantity) });

  it("takes each row in the unit it was received in and numbers the lines as typed", () => {
    const worked = returnLines([unbilled, billed], [want("2", BILL_LINE), want("1")], "2026-11-06");
    expect(worked.ok && worked.lines.map((line) => `${line.lineNo}: ${line.billLineId ?? "unbilled"} ${line.quantity.toFixed()} = ${line.baseQuantity.toFixed()}`)).toEqual([`1: ${BILL_LINE} 2 = 24`, "2: unbilled 1 = 12"]);
  });

  it("refuses more than is left, billed goods before their bill, and goods the warehouse no longer holds", () => {
    const reason = (rows: Returnable[], wanted: ReturnType<typeof want>[], date = "2026-11-06") => {
      const worked = returnLines(rows, wanted, date);
      return worked.ok ? null : worked.reason;
    };
    expect(reason([unbilled], [want("4.5")])).toBe("HL-1 not yet billed: only 4 can go back, not 4.5.");
    expect(reason([billed], [want("7", BILL_LINE)])).toBe("HL-1 billed on PB-2627-00007: only 6 can go back, not 7.");
    expect(reason([unbilled], [want("1", BILL_LINE)])).toMatch(/^Some goods on the return are no longer there to send back/);
    expect(reason([billed], [want("1", BILL_LINE)], "2026-11-03")).toBe("HL-1 billed on PB-2627-00007: the bill is dated 04-11-2026. Billed goods go back on or after the day of their bill.");
    // Unbilled and billed rows of one item draw on the same stock: 4 + 2 cartons are 72 pieces, and 60 are held.
    expect(reason([unbilled, billed], [want("4"), want("2", BILL_LINE)])).toMatch(/^HL-1: the warehouse holds 60, so 72 cannot go back\./);
    expect(reason([{ ...unbilled, unitFactor: d("0.33333") }], [want("1")])).toBe("HL-1: use a quantity the item's own unit can hold, with fewer decimals.");
  });

  it("estimates what a draft takes back on each side", () => {
    const estimate = returnEstimate([unbilled, billed], [want("2"), want("1.5", BILL_LINE)]);
    // Two cartons not billed at 7,200; one and a half billed at 7,500 with 1,350 of tax each.
    expect([estimate.notBilled.toFixed(2), estimate.credit.toFixed(2)]).toEqual(["14400.00", "13275.00"]);
  });
});

describe("what earlier steps now count", () => {
  it("goods sent back before they were billed are no longer left to bill", () => {
    expect(stillToBill({ received: d("10"), billed: d("3") }).toFixed()).toBe("7");
    expect(stillToBill({ received: d("10"), billed: d("3"), returned: d("4") }).toFixed()).toBe("3");
    expect(stillToBill({ received: d("10"), billed: d("6"), returned: d("5") }).toFixed()).toBe("0");
  });

  it("a credit is set against bills like money, in its own words", () => {
    const owed = [{ billId: "b1", number: "PB-2627-00009", supplierInvoiceNo: "INV-9", date: "2026-11-08", dueDate: null, payable: d("400"), owed: d("400") }];
    expect(settle(d("200"), "2026-11-07", [{ billId: "b1", amount: d("100") }], owed, "what is left of the credit")).toEqual({ ok: false, reason: "PB-2627-00009 is dated 08-11-2026, after this day. A credit is set against a bill on or after the bill's day." });
    expect(settle(d("200"), "2026-11-08", [{ billId: "b1", amount: d("250") }], owed, "what is left of the credit")).toEqual({ ok: false, reason: "250.00 is set against bills, more than what is left of the credit: 200.00." });
  });
});
