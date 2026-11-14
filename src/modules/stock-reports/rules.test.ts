import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { ageStock, daysBetween, itemProfitTable, lowStockTable, marginPercent, movementTable, readStockFilter, valuationTable } from "./rules";

const d = (value: string | number) => new Decimal(value);
const strings = (bands: Decimal[]) => bands.map((band) => band.toFixed());

describe("ageStock", () => {
  const asAt = "2026-11-14";
  it("takes the newest goods received as the ones still on hand", () => {
    // 10 came in a year ago, 5 two months ago, 4 last week; 7 are on hand: the 4 of last week and 3 of two months ago.
    const incoming = [
      { date: "2026-11-07", quantity: d(4) },
      { date: "2026-09-14", quantity: d(5) },
      { date: "2025-11-14", quantity: d(10) },
    ];
    expect(strings(ageStock(d(7), incoming, asAt))).toEqual(["4", "0", "3", "0", "0"]);
    expect(strings(ageStock(d(19), incoming, asAt))).toEqual(["4", "0", "5", "0", "10"]);
  });

  it("counts a day exactly on a band's edge into that band", () => {
    expect(daysBetween("2026-10-15", asAt)).toBe(30);
    expect(strings(ageStock(d(1), [{ date: "2026-10-15", quantity: d(1) }], asAt))).toEqual(["1", "0", "0", "0", "0"]);
    expect(strings(ageStock(d(1), [{ date: "2026-10-14", quantity: d(1) }], asAt))).toEqual(["0", "1", "0", "0", "0"]);
    expect(strings(ageStock(d(1), [{ date: "2026-05-18", quantity: d(1) }], asAt))).toEqual(["0", "0", "0", "1", "0"]);
    expect(strings(ageStock(d(1), [{ date: "2026-05-17", quantity: d(1) }], asAt))).toEqual(["0", "0", "0", "0", "1"]);
  });

  it("puts what the moves do not account for in the oldest band, and handles part quantities", () => {
    expect(strings(ageStock(d("2.5"), [{ date: asAt, quantity: d("1.25") }], asAt))).toEqual(["1.25", "0", "0", "0", "1.25"]);
    expect(strings(ageStock(d(0), [{ date: asAt, quantity: d(3) }], asAt))).toEqual(["0", "0", "0", "0", "0"]);
  });
});

describe("the report tables", () => {
  const filter = readStockFilter({}, { yearStart: "2026-07-01", today: "2026-11-14" });

  it("reads the filter, and turns a period the wrong way round", () => {
    expect(filter).toEqual({ from: "2026-07-01", to: "2026-11-14", branchId: null, warehouseId: null, itemId: null });
    expect(readStockFilter({ from: "2026-12-01", to: "2026-11-01", warehouse: "NOT-AN-ID" }, { yearStart: "x", today: "y" })).toMatchObject({ from: "2026-11-01", to: "2026-11-01", warehouseId: null });
  });

  it("compares the stock held with the stock account, and says so when they differ", () => {
    const rows = [{ code: "BP-1", name: "Brake pad", unit: "pc", warehouse: "Main", quantity: d(3), value: d(1000) }];
    const agree = valuationTable(rows, filter, d(1000));
    expect(agree.rows.at(-1)!.cells).toEqual(["", "Difference", "", "", "", d(0)]);
    expect(agree.rows[0].cells).toEqual(["BP-1", "Brake pad", "Main", "3 pc", d("333.3333"), d(1000)]);
    expect(agree.notes).toEqual([]);
    expect(valuationTable(rows, filter, d(900)).notes[0]).toContain("do not agree");
    // One warehouse: nothing in the books to compare with.
    const one = valuationTable(rows, { ...filter, warehouseId: "w" }, null);
    expect(one.rows.map((row) => row.cells[1])).toEqual(["Brake pad", "Total"]);
  });

  it("works out closing stock from opening, in and out", () => {
    const table = movementTable([{ code: "BP-1", name: "Brake pad", unit: "pc", warehouse: "Main", openingQuantity: d(10), openingValue: d(1000), inQuantity: d(5), inValue: d(600), outQuantity: d(8), outValue: d(850) }], filter);
    expect(table.rows[0].cells.slice(9)).toEqual(["7 pc", d(750)]);
    expect(table.rows[1].cells.at(-1)).toEqual(d(750));
  });

  it("lists free stock at or below the reorder level, shortest first", () => {
    const item = (code: string, reorder: number, onHand: number, onOrder: number) => ({ code, name: code, unit: "pc", reorderLevel: d(reorder), onHand: d(onHand), onOrder: d(onOrder), byWarehouse: [{ warehouse: "Main", quantity: d(onHand) }] });
    const table = lowStockTable([item("A", 10, 20, 5), item("B", 10, 12, 4), item("C", 10, 10, 0), item("D", 5, 0, 3)], "2026-11-14");
    expect(table.rows.map((row) => row.cells[0])).toEqual(["D", "B", "C"]);
    expect(table.rows[0].cells.slice(3, 7)).toEqual(["0", "3", "-3", "8"]);
    expect(table.rows[0].cells[7]).toBe("");
  });

  it("gives profit and margin per item and in total", () => {
    expect(marginPercent(d(1000), d(600))!.toFixed(1)).toBe("40.0");
    expect(marginPercent(d(0), d(10))).toBeNull();
    const table = itemProfitTable([{ code: "BP-1", name: "Brake pad", unit: "pc", quantity: d(3), sales: d(3000), cost: d(1800) }, { code: "CH-2", name: "Chain", unit: "pc", quantity: d(1), sales: d(1000), cost: d(900) }], filter);
    expect(table.rows[0].cells).toEqual(["BP-1", "Brake pad", "3 pc", d(3000), d(1800), d(1200), "40.0%"]);
    expect(table.rows[2].cells).toEqual(["", "Total", "", d(4000), d(2700), d(1300), "32.5%"]);
  });
});
