import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { previewSpread, readCharge, readShipment, spreadCharge, splitHeld, type GoodsLine } from "./rules";

// The allocation cases of the old engine's imports tests (reference/tests/qa/09-imports.test.ts),
// carried over to the paisa. The same cases run against the database in shipments.test.ts.

const d = (value: string) => new Decimal(value);
const line = (itemId: string, quantity: string, cost: string, weight = "0", volume = "0"): GoodsLine => ({ receiptLineId: `line-${itemId}`, itemId, itemCode: itemId, quantity: d(quantity), value: d(quantity).times(cost), weight: d(quantity).times(weight), volume: d(quantity).times(volume) });
/** Product A weighs 2 and takes up 3; product B weighs 1 and takes up 1: 7 of A and 3 of B at 1,000 each. */
const sevenAndThree = [line("A", "7", "1000", "2", "3"), line("B", "3", "1000", "1", "1")];
const shares = (amount: string, basis: "value" | "quantity" | "weight" | "volume", lines: GoodsLine[] = sevenAndThree) => {
  const spread = spreadCharge(d(amount), basis, lines);
  return spread.ok ? spread.shares.map((share) => share.toFixed(2)) : spread.reason;
};

describe("spreading a charge over a shipment's goods", () => {
  it("IMP-018: by value, 70% and 30% of the goods take 70% and 30% of the freight", () => {
    expect(shares("50000", "value")).toEqual(["35000.00", "15000.00"]);
  });

  it("IMP-018, 079: three equal lines get a third each, and the paisa that is left goes to the last", () => {
    const three = [line("X", "1", "10"), line("Y", "1", "10"), line("Z", "1", "10")];
    expect(shares("100", "value", three)).toEqual(["33.33", "33.33", "33.34"]);
    expect(shares("1000", "quantity", three)).toEqual(["333.33", "333.33", "333.34"]);
  });

  it("IMP-019 to 021: by quantity, by weight and by volume", () => {
    expect(shares("1000", "quantity")).toEqual(["700.00", "300.00"]);
    expect(shares("1700", "weight")).toEqual(["1400.00", "300.00"]);
    expect(shares("2400", "volume")).toEqual(["2100.00", "300.00"]);
  });

  it("IMP-022, 023: a product with no weight takes nothing; with no weight at all the charge cannot be spread by weight", () => {
    expect(shares("900", "weight", [line("A", "5", "100", "2"), line("C", "5", "100")])).toEqual(["900.00", "0.00"]);
    // The last line that has any weight takes what is left, wherever it stands.
    expect(shares("100", "weight", [line("A", "1", "10", "1"), line("B", "1", "10", "1"), line("C", "1", "10")])).toEqual(["50.00", "50.00", "0.00"]);
    expect(shares("900", "weight", [line("C", "5", "100")])).toBe("None of the goods has a weight to spread the charge by. Enter the weight on the items' cards, or spread it another way.");
    expect(shares("900", "value", [])).toBe("The shipment has no goods to spread charges over.");
  });

  it("IMP-042: a charge smaller than the lines it is shared over never gives more than there is", () => {
    expect(shares("0.01", "value")).toEqual(["0.01", "0.00"]);
    // Ten equal lines and five paisa: half a paisa each rounds up, so the first five take it all.
    const ten = Array.from({ length: 10 }, (_, index) => line(`I${index}`, "1", "10"));
    const spread = shares("0.05", "quantity", ten) as string[];
    expect(spread).toEqual(["0.01", "0.01", "0.01", "0.01", "0.01", "0.00", "0.00", "0.00", "0.00", "0.00"]);
  });

  it("IMP-080: lines of half a unit", () => {
    expect(shares("30", "weight", [line("A", "0.5", "200", "2"), line("B", "0.5", "100", "1")])).toEqual(["20.00", "10.00"]);
  });

  it("IMP-096: twenty charges over a hundred lines each add up exactly", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => line(`I${index}`, "3", "17", "1.5", "0.2"));
    for (const basis of ["value", "quantity", "weight", "volume"] as const) {
      const spread = spreadCharge(d("999.99"), basis, hundred);
      expect(spread.ok && spread.shares.reduce((sum, share) => sum.plus(share), d("0")).toFixed(2)).toBe("999.99");
      expect(spread.ok && spread.shares.every((share) => share.gte(0))).toBe(true);
    }
  });
});

describe("what is still held takes its share into stock", () => {
  const split = (amount: string, brought: string, held: string) => {
    const { toStock, toCogs } = splitHeld(d(amount), d(brought), d(held));
    return `${toStock.toFixed(2)} to stock, ${toCogs.toFixed(2)} to cost of goods sold`;
  };

  it("IMP-025, 026: part sold, all sold, nothing sold", () => {
    expect(split("1000", "10", "6")).toBe("600.00 to stock, 400.00 to cost of goods sold");
    expect(split("1000", "10", "0")).toBe("0.00 to stock, 1000.00 to cost of goods sold");
    expect(split("1000", "10", "10")).toBe("1000.00 to stock, 0.00 to cost of goods sold");
  });

  it("never counts more as held than the shipment brought", () => {
    expect(split("1000", "10", "250")).toBe("1000.00 to stock, 0.00 to cost of goods sold");
    expect(split("100", "3", "1")).toBe("33.33 to stock, 66.67 to cost of goods sold");
  });
});

describe("what closing a shipment would do", () => {
  it("IMP-017: each kind of charge goes where it belongs", () => {
    const worked = previewSpread(
      [
        { class: "inventory", basis: "value", amount: d("50000") },
        { class: "inventory", basis: "quantity", amount: d("80000") },
        { class: "sales_tax", basis: null, amount: d("30000") },
        { class: "deposit", basis: null, amount: d("20000") },
        { class: "expense", basis: null, amount: d("5000") },
        { class: "advance_income_tax", basis: null, amount: d("12000") },
      ],
      sevenAndThree,
      new Map([["A", d("7")], ["B", d("1")]]),
    );
    expect(worked.ok && { perLine: worked.preview.perLine.map((share) => share.toFixed(2)), toStock: worked.preview.toStock.toFixed(2), toCogs: worked.preview.toCogs.toFixed(2), salesTax: worked.preview.salesTax.toFixed(2), advance: worked.preview.advanceIncomeTax.toFixed(2), deposits: worked.preview.deposits.toFixed(2), expenses: worked.preview.expenses.toFixed(2), total: worked.preview.total.toFixed(2) }).toEqual({
      // A: 35,000 of freight and 56,000 of duty, all still held. B: 15,000 and 24,000, of which one in three is still held.
      perLine: ["91000.00", "39000.00"],
      toStock: "104000.00",
      toCogs: "26000.00",
      salesTax: "30000.00",
      advance: "12000.00",
      deposits: "20000.00",
      expenses: "5000.00",
      total: "197000.00",
    });
  });

  it("says why it cannot be worked out", () => {
    expect(previewSpread([{ class: "inventory", basis: "volume", amount: d("10") }], [line("C", "5", "100")], new Map())).toEqual({ ok: false, reason: "None of the goods has a volume to spread the charge by. Enter the volume on the items' cards, or spread it another way." });
  });
});

describe("reading a shipment and a charge", () => {
  it("cleans a shipment as typed", () => {
    const read = readShipment({ openedOn: "2026-11-03", supplierId: "s", branchId: "b", stage: "at_port", containerNo: "  MSKU 123 4567 ", gdNumber: "KPPI-HC-12345-2026", gdDate: "2026-11-05", customsValue: "9500.50", expectedOn: "", origin: "", port: "Karachi" });
    expect(read.ok && { ...read.shipment, customsValue: read.shipment.customsValue?.toFixed(2) }).toEqual({ openedOn: "2026-11-03", supplierId: "s", branchId: "b", stage: "at_port", origin: null, port: "Karachi", containerNo: "MSKU 123 4567", blNumber: null, lcNumber: null, gdNumber: "KPPI-HC-12345-2026", note: null, gdDate: "2026-11-05", customsValue: "9500.50", expectedOn: null });
  });

  it("says what is wrong in plain words", () => {
    const reason = (over: object) => {
      const read = readShipment({ openedOn: "2026-11-03", supplierId: "s", branchId: "b", ...over });
      return read.ok ? null : read.reason;
    };
    expect(reason({ openedOn: "" })).toBe("Enter the day the shipment is opened.");
    expect(reason({ supplierId: "" })).toBe("Choose the supplier.");
    expect(reason({ stage: "lost" })).toBe("Choose how far the shipment has come.");
    expect(reason({ gdNumber: "G".repeat(101) })).toBe("Goods declaration (GD) number: use at most 100 characters.");
    expect(reason({ gdDate: "2026-02-30" })).toBe("Enter the date on the goods declaration, or leave it empty.");
    expect(reason({ customsValue: "-5" })).toMatch(/^Customs value: /);
    // IMP-007: a GD number of 100 characters is kept.
    expect(reason({ gdNumber: "G".repeat(100) })).toBeNull();
  });

  it("IMP-015, 016: a charge is one of five kinds, and one that is part of the goods' cost is spread by one of four measures", () => {
    const reason = (raw: object) => {
      const read = readCharge({ billLineId: "l", ...raw });
      return read.ok ? read.charge : read.reason;
    };
    expect(reason({ class: "other", basis: "value" })).toBe("Choose what kind of charge it is.");
    expect(reason({ class: "inventory", basis: "price" })).toBe("Choose what the charge is spread over the goods by: value, quantity, weight or volume.");
    expect(reason({ class: "deposit" })).toBe("Choose the asset account the deposit is held in.");
    expect(reason({ class: "expense" })).toBe("Choose the expense account the charge goes to.");
    expect(reason({ class: "inventory", basis: "weight", accountId: "x" })).toEqual({ billLineId: "l", class: "inventory", basis: "weight", accountId: null });
    expect(reason({ class: "sales_tax", basis: "value", accountId: "x" })).toEqual({ billLineId: "l", class: "sales_tax", basis: null, accountId: null });
    expect(reason({ class: "expense", accountId: "x" })).toEqual({ billLineId: "l", class: "expense", basis: null, accountId: "x" });
  });
});
