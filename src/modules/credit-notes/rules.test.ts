import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { NOTHING_RETURNED, creditFigures, creditLeft, creditShare, creditTotals, fitsBaseUnit, readCreditNote, stillToReturn, type InvoicedLine, type Returned } from "./rules";

const d = (value: string | number) => new Decimal(value);
const line = (quantity: string, unitPrice: string, value: string, tax = "0", further = "0", extra = "0"): InvoicedLine => ({
  quantity: d(quantity),
  unitFactor: d(1),
  unitPrice: d(unitPrice),
  value: d(value),
  taxAmount: d(tax),
  furtherTaxAmount: d(further),
  extraTaxAmount: d(extra),
});
const show = (f: ReturnType<typeof creditFigures>) => `${f.gross.toFixed(2)} - ${f.discountAmount.toFixed(2)}: ${f.value.toFixed(2)} + ${f.taxAmount.toFixed(2)} + ${f.furtherTaxAmount.toFixed(2)} + ${f.extraTaxAmount.toFixed(2)} = ${f.total.toFixed(2)}`;
/** What a run of credit notes has taken of a line, after each. */
const after = (returned: Returned, quantity: Decimal, f: ReturnType<typeof creditFigures>): Returned => ({
  quantity: returned.quantity.plus(quantity),
  value: returned.value.plus(f.value),
  taxAmount: returned.taxAmount.plus(f.taxAmount),
  furtherTaxAmount: returned.furtherTaxAmount.plus(f.furtherTaxAmount),
  extraTaxAmount: returned.extraTaxAmount.plus(f.extraTaxAmount),
});

describe("a figure's share", () => {
  it("is the figure in the proportion of what has come back, rounded to the paisa, half up", () => {
    expect(creditShare(d("1900"), d(0), d(2), d(5)).toFixed(2)).toBe("760.00");
    expect(creditShare(d("100"), d(0), d(1), d(3)).toFixed(2)).toBe("33.33");
    expect(creditShare(d("200"), d(0), d(1), d(3)).toFixed(2)).toBe("66.67");
    // Exactly half a paisa goes up.
    expect(creditShare(d("0.15"), d(0), d(1), d(10)).toFixed(2)).toBe("0.02");
    expect(creditShare(d("1.005"), d(0), d(1), d(2)).toFixed(4)).toBe("0.5000");
    expect(creditShare(d("0"), d(0), d(1), d(3)).toFixed(2)).toBe("0.00");
  });

  it("brings what has been credited up to the exact share so far, less what earlier credit notes took", () => {
    // A third each time of 100: 33.33, then up to 66.67 (33.34 more), then all of it (33.33 more).
    expect(creditShare(d("100"), d("33.33"), d(2), d(3)).toFixed(2)).toBe("33.34");
    expect(creditShare(d("100"), d("66.67"), d(3), d(3)).toFixed(2)).toBe("33.33");
    // Twenty pins billed 0.10 in all, coming back one at a time: never ahead of their share by more than half a paisa.
    let gone = d(0);
    const parts: string[] = [];
    for (let pins = 1; pins <= 20; pins += 1) {
      const part = creditShare(d("0.10"), gone, d(pins), d(20));
      parts.push(part.toFixed(2));
      gone = gone.plus(part);
      expect(gone.minus(d("0.10").times(pins).div(20)).abs().lte("0.005"), `after ${pins} pins`).toBe(true);
    }
    expect(parts.join(" ")).toBe("0.01 0.00 0.01 0.00 0.01 0.00 0.01 0.00 0.01 0.00 0.01 0.00 0.01 0.00 0.01 0.00 0.01 0.00 0.01 0.00");
    expect(gone.toFixed(2)).toBe("0.10");
  });

  it("is all that is left once everything has come back, whatever the figure's decimals", () => {
    expect(creditShare(d("11.9826"), d("6.85"), d(7), d(7)).toFixed(4)).toBe("5.1326");
    expect(creditShare(d("100"), d("100"), d(3), d(3)).toFixed(2)).toBe("0.00");
    // And never more than the figure before that: 0.0149 is not rounded up to 0.02 for nine tenths of it.
    expect(creditShare(d("0.0149"), d(0), d(9), d(10)).toFixed(4)).toBe("0.0100");
    expect(creditShare(d("0.0049"), d(0), d(9), d(10)).toFixed(4)).toBe("0.0000");
    expect(creditShare(d("0.0051"), d(0), d(999), d(1000)).toFixed(4)).toBe("0.0051");
  });

  it("keeps its digits whatever the size of the figures", () => {
    expect(creditShare(d("999999999999999.99"), d(0), d("123456.7891"), d("999999.9999")).toFixed(2)).toBe("123456789112345.68");
    expect(creditShare(d("0.01"), d(0), d("0.0001"), d("999999.9999")).toFixed(2)).toBe("0.00");
  });
});

describe("a line of a credit note", () => {
  it("takes back the share of what its invoice line billed", () => {
    // Five chains at 400, 5% off: 1,900 and 342 of tax. Two come back.
    const chains = line("5", "400", "1900", "342");
    expect(show(creditFigures(chains, NOTHING_RETURNED, d(2), false))).toBe("800.00 - 40.00: 760.00 + 136.80 + 0.00 + 0.00 = 896.80");
    // An unregistered buyer's line carries further tax, taken back in the same proportion.
    expect(show(creditFigures(line("3", "400", "1200", "216", "48"), NOTHING_RETURNED, d(1), false))).toBe("400.00 - 0.00: 400.00 + 72.00 + 16.00 + 0.00 = 488.00");
  });

  it("comes, over all its credit notes, to exactly what the invoice line billed", () => {
    // Seven bolts: 66.57 and 11.98 of tax. Two, two and three come back.
    const bolts = line("7", "10.01", "66.57", "11.98");
    let returned = NOTHING_RETURNED;
    const shown: string[] = [];
    for (const quantity of [d(2), d(2), d(3)]) {
      const f = creditFigures(bolts, returned, quantity, false);
      shown.push(`${f.value.toFixed(2)} + ${f.taxAmount.toFixed(2)}`);
      returned = after(returned, quantity, f);
    }
    // Tax: two sevenths is 3.42; four sevenths is 6.85, so the second two take 3.43; the last three what is left.
    expect(shown).toEqual(["19.02 + 3.42", "19.02 + 3.43", "28.53 + 5.13"]);
    expect(`${returned.value.toFixed(2)} ${returned.taxAmount.toFixed(2)}`).toBe("66.57 11.98");
    // Taken first, two bolts are 3.42 of tax whichever two they are: a draft saved before another credit note was posted shows that figure.
    expect(creditFigures(bolts, NOTHING_RETURNED, d(2), false).taxAmount.toFixed(2)).toBe("3.42");
    expect(stillToReturn(bolts, returned).toFixed()).toBe("0");
  });

  it("shows as discount what lies between the quantity at the price and what the line comes to", () => {
    // Prices before tax: against the value.
    expect(creditFigures(line("10", "100", "900", "162"), NOTHING_RETURNED, d(4), false).discountAmount.toFixed(2)).toBe("40.00");
    // Prices that hold the tax: against the value with its tax and further tax, not the extra tax.
    const inclusive = creditFigures(line("10", "118", "950", "171", "0", "5"), NOTHING_RETURNED, d(4), true);
    expect(show(inclusive)).toBe("472.00 - 23.60: 380.00 + 68.40 + 0.00 + 2.00 = 450.40");
    // Never below nothing, even where rounding puts the share a paisa above the quantity at the price.
    expect(creditFigures(line("10", "0.0149", "0.15"), NOTHING_RETURNED, d(1), false).discountAmount.toFixed(2)).toBe("0.00");
  });

  it("adds up to the credit note's totals", () => {
    const totals = creditTotals([creditFigures(line("5", "400", "1900", "342"), NOTHING_RETURNED, d(2), false), creditFigures(line("3", "400", "1200", "216", "48"), NOTHING_RETURNED, d(1), false)]);
    expect(`${totals.gross.toFixed(2)} ${totals.discount.toFixed(2)} ${totals.value.toFixed(2)} ${totals.tax.toFixed(2)} ${totals.furtherTax.toFixed(2)} ${totals.total.toFixed(2)}`).toBe("1200.00 40.00 1160.00 208.80 16.00 1384.80");
  });

  it("knows which quantities the item's own unit can hold", () => {
    expect(fitsBaseUnit(d("2.5"), d("12"))).toBe(true);
    expect(fitsBaseUnit(d("0.0001"), d("0.5"))).toBe(false);
    expect(fitsBaseUnit(d("0"), d("0.333333"))).toBe(true);
  });
});

describe("what is typed for a credit note", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";

  it("keeps the lines that came back, with what is damaged", () => {
    const read = readCreditNote({
      date: "2026-10-20",
      notes: "  Sent back:\tbent  link ",
      lines: [
        { sourceLineId: a, quantity: "2", damaged: "1" },
        { sourceLineId: b, quantity: "", damaged: "" },
      ],
    });
    expect(read).toEqual({ ok: true, creditNote: { date: "2026-10-20", notes: "Sent back: bent link", reference: null, lines: [{ sourceLineId: a, quantity: d(2), damaged: d(0).plus(1) }] } });
    expect(readCreditNote({ date: "2026-10-20", lines: [{ sourceLineId: a, quantity: "0.5" }] })).toMatchObject({ ok: true, creditNote: { notes: null, lines: [{ quantity: d("0.5"), damaged: d(0) }] } });
    expect(readCreditNote({ date: "2026-10-20", lines: [{ sourceLineId: a, quantity: "0", damaged: "0" }] })).toMatchObject({ ok: true, creditNote: { lines: [] } });
  });

  it("says what is wrong in plain words", () => {
    const reason = (raw: Parameters<typeof readCreditNote>[0]) => {
      const read = readCreditNote(raw);
      return read.ok ? null : read.reason;
    };
    expect(reason({ date: "20-10-2026", lines: [] })).toBe("Enter the date of the credit note.");
    expect(reason({ date: "2026-10-20", notes: "x".repeat(1001), lines: [] })).toBe("Reason: use at most 1,000 characters.");
    expect(reason({ date: "2026-10-20", reference: "x".repeat(61), lines: [] })).toBe("Customer's debit note: use at most 60 characters.");
    expect(reason({ date: "2026-10-20", lines: [{ sourceLineId: a, quantity: "2", damaged: "3" }] })).toBe("Line 1: no more can be damaged than came back.");
    expect(reason({ date: "2026-10-20", lines: [{ sourceLineId: a, quantity: "", damaged: "1" }] })).toBe("Line 1: enter how much came back before how much of it is damaged.");
    expect(reason({ date: "2026-10-20", lines: [{ sourceLineId: a, quantity: "-1" }] })).toMatch(/^Line 1, returned: /);
    expect(reason({ date: "2026-10-20", lines: [{ sourceLineId: a, quantity: "1", damaged: "1,5" }] })).toMatch(/^Line 1, damaged: /);
    expect(
      reason({
        date: "2026-10-20",
        lines: [
          { sourceLineId: a, quantity: "1" },
          { sourceLineId: a, quantity: "1" },
        ],
      }),
    ).toBe("A line of the invoice is on the credit note twice.");
  });
});

describe("credit left on a credit note", () => {
  it("is its total less what it has been set against", () => {
    expect(creditLeft(d("1220"), [{ amount: d("976") }]).toFixed(2)).toBe("244.00");
    expect(creditLeft(d("896.80"), [{ amount: d("896.80") }]).toFixed(2)).toBe("0.00");
    expect(creditLeft(d("100"), []).toFixed(2)).toBe("100.00");
  });
});
