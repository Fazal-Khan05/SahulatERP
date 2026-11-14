import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { averageCost, countDifference, formatQuantity, issue, readAdjustment, readCountStart, readCounted, readNumber, readOpeningRows, readTransfer, receive, remainingToDeliver, type StockOnHand } from "./rules";

const d = (value: string) => new Decimal(value);
const stock = (quantity: string, value: string): StockOnHand => ({ quantity: d(quantity), value: d(value) });
const show = (s: StockOnHand) => `${s.quantity.toFixed()} worth ${s.value.toFixed(2)}`;
const take = (from: StockOnHand, quantity: string) => {
  const result = issue(from, d(quantity));
  return result.ok ? `${result.value.toFixed(2)}, leaving ${show(result.left)}` : `short by ${result.short.toFixed()}`;
};

describe("weighted-average cost", () => {
  it("averages what came in at different costs", () => {
    // 12 chains at 250 and 8 at 300: 5,400 for 20, 270 each.
    const chains = receive(receive(stock("0", "0"), d("12"), d("3000")), d("8"), d("2400"));
    expect(show(chains)).toBe("20 worth 5400.00");
    expect(averageCost(chains).toFixed(2)).toBe("270.00");
    expect(averageCost(stock("0", "0")).toFixed()).toBe("0");
    expect(averageCost(stock("3", "100")).toFixed(6)).toBe("33.333333");
  });
  it("values goods leaving at the average, and leaves the rest at the same average", () => {
    expect(take(stock("20", "5400"), "5")).toBe("1350.00, leaving 15 worth 4050.00");
    expect(take(stock("15", "4050"), "3")).toBe("810.00, leaving 12 worth 3240.00");
    expect(take(stock("10", "6000"), "2")).toBe("1200.00, leaving 8 worth 4800.00");
    // A later receipt at a new cost moves the average for what leaves after it, not before.
    const mixed = receive(stock("8", "4800"), d("2"), d("1400"));
    expect(averageCost(mixed).toFixed(2)).toBe("620.00");
    expect(take(mixed, "1")).toBe("620.00, leaving 9 worth 5580.00");
  });
  it("rounds to the paisa, half up, and lets the last of the stock take the last of the value", () => {
    // 3 pieces worth 100: one is 33.33, the next 33.34 (66.67 / 2 = 33.335), the last 33.33.
    expect(take(stock("3", "100"), "1")).toBe("33.33, leaving 2 worth 66.67");
    expect(take(stock("2", "66.67"), "1")).toBe("33.34, leaving 1 worth 33.33");
    expect(take(stock("1", "33.33"), "1")).toBe("33.33, leaving 0 worth 0.00");
    expect(take(stock("0.3333", "10"), "0.1")).toBe("3.00, leaving 0.2333 worth 7.00");
    expect(take(stock("7", "0"), "2")).toBe("0.00, leaving 5 worth 0.00");
    // A value below a paisa never rounds up past what is there.
    expect(take(stock("2", "0.006"), "1.9999")).toBe("0.01, leaving 0.0001 worth 0.00");
  });
  it("never lets stock go below zero", () => {
    expect(take(stock("5", "1350"), "5.0001")).toBe("short by 0.0001");
    expect(take(stock("0", "0"), "1")).toBe("short by 1");
    expect(issue(stock("5", "100"), d("0")).ok).toBe(false);
    expect(issue(stock("5", "100"), d("-1")).ok).toBe(false);
  });
  it("says what an order line still has to deliver", () => {
    expect(remainingToDeliver(d("24"), d("10")).toFixed()).toBe("14");
    expect(remainingToDeliver(d("24"), d("24")).toFixed()).toBe("0");
    expect(remainingToDeliver(d("24"), d("30")).toFixed()).toBe("0");
  });
});

describe("what is typed for a stock document", () => {
  const D = "2026-11-10";

  it("reads a quantity or a cost as plain digits, to four decimals", () => {
    expect(readNumber("2.5", "the quantity", false)).toMatchObject({ ok: true });
    expect(readNumber(" 12 ", "the quantity", false)).toMatchObject({ ok: true });
    expect(readNumber("0", "what was counted", true)).toMatchObject({ ok: true });
    expect(readNumber("0", "the quantity", false)).toEqual({ ok: false, reason: "Enter the quantity above zero." });
    expect(readNumber("", "the quantity", false)).toEqual({ ok: false, reason: "Enter the quantity." });
    for (const wrong of ["-1", "1,000", "1e3", "abc", "1.", ".5", "+2"]) expect(readNumber(wrong, "the quantity", false), wrong).toMatchObject({ ok: false });
    expect(readNumber("1.00001", "the quantity", false)).toEqual({ ok: false, reason: "Use at most 4 digits after the point." });
    expect(readNumber("123456789012", "the quantity", false)).toEqual({ ok: false, reason: "That number is too large." });
    expect(formatQuantity(d("12.5000"))).toBe("12.5");
    expect(formatQuantity(d("40"))).toBe("40");
  });

  it("reads a transfer: two different warehouses, each item once, empty rows left out", () => {
    const read = readTransfer({ date: D, fromWarehouseId: "a", toWarehouseId: "b", note: "  For the  counter ", lines: [{ itemCode: "", quantity: "" }, { itemCode: " HL-1 ", quantity: "4" }, { itemCode: "CH-2", quantity: "1.5" }] });
    expect(read).toMatchObject({ ok: true, draft: { date: D, note: "For the counter" } });
    if (!read.ok) throw new Error("not read");
    expect(read.draft.lines.map((line) => `${line.itemCode} ${line.quantity.toFixed()}`)).toEqual(["HL-1 4", "CH-2 1.5"]);
    const refused = (raw: Parameters<typeof readTransfer>[0]) => (readTransfer(raw) as { reason?: string }).reason;
    expect(refused({ date: "10-11-2026", fromWarehouseId: "a", toWarehouseId: "b" })).toBe("Enter the date of the transfer.");
    expect(refused({ date: D, fromWarehouseId: "a", toWarehouseId: "a" })).toBe("A transfer goes from one warehouse to another. Choose two different warehouses.");
    expect(refused({ date: D, fromWarehouseId: "a", toWarehouseId: "b", lines: [{ itemCode: "HL-1", quantity: "1" }, { itemCode: "hl-1", quantity: "2" }] })).toBe("hl-1 is on the transfer twice. Put each item on one line.");
    expect(refused({ date: D, fromWarehouseId: "a", toWarehouseId: "b", lines: [{ itemCode: "HL-1", quantity: "0" }] })).toBe("Line 1: Enter the quantity above zero.");
    expect(refused({ date: D, fromWarehouseId: "a", toWarehouseId: "b", lines: [{ itemCode: "", quantity: "3" }] })).toBe("Line 1: enter the item's code.");
  });

  it("reads an adjustment: a reason, goods out below zero, a cost only on goods added", () => {
    const read = readAdjustment("adjustment", { date: D, warehouseId: "w", reason: "damaged", lines: [{ itemCode: "HL-1", direction: "out", quantity: "1" }, { itemCode: "GR-3", direction: "in", quantity: "5", unitCost: "10" }, { itemCode: "CH-2", quantity: "2" }] });
    if (!read.ok) throw new Error(read.reason);
    expect(read.draft).toMatchObject({ kind: "adjustment", reason: "damaged", note: null });
    expect(read.draft.lines.map((line) => `${line.itemCode} ${line.quantity.toFixed()} ${line.unitCost?.toFixed() ?? "average"}`)).toEqual(["HL-1 -1 average", "GR-3 5 10", "CH-2 2 average"]);
    const refused = (raw: Parameters<typeof readAdjustment>[1]) => (readAdjustment("adjustment", raw) as { reason?: string }).reason;
    expect(refused({ date: D, warehouseId: "w", reason: "stolen by aliens" })).toBe("Choose the reason for the adjustment.");
    expect(refused({ date: D, warehouseId: "w", reason: "other" })).toBe('Say in the note what the reason is, when it is "Other".');
    expect(refused({ date: D, warehouseId: "", reason: "lost" })).toBe("Choose the warehouse.");
    expect(refused({ date: D, warehouseId: "w", reason: "lost", lines: [{ itemCode: "HL-1", direction: "out", quantity: "1", unitCost: "5" }] })).toBe("Line 1: goods taken out leave at their average cost. Leave the cost empty.");
    expect(readAdjustment("adjustment", { date: D, warehouseId: "w", reason: "other", note: "Used on the shop van" })).toMatchObject({ ok: true });
  });

  it("reads opening stock: no reason, and a cost on every item brought in, even nothing", () => {
    const read = readAdjustment("opening", { date: D, warehouseId: "w", reason: "damaged", lines: [{ itemCode: "HL-1", quantity: "10", unitCost: "600" }, { itemCode: "GR-3", quantity: "40", unitCost: "0" }] });
    if (!read.ok) throw new Error(read.reason);
    expect(read.draft).toMatchObject({ kind: "opening", reason: null });
    expect(read.draft.lines.map((line) => `${line.itemCode} ${line.quantity.toFixed()} at ${line.unitCost?.toFixed()}`)).toEqual(["HL-1 10 at 600", "GR-3 40 at 0"]);
    expect(readAdjustment("opening", { date: D, warehouseId: "w", lines: [{ itemCode: "HL-1", quantity: "10" }] })).toEqual({ ok: false, reason: "Line 1: enter what one HL-1 cost. Opening stock comes in at its cost." });
  });

  it("reads the rows of an opening stock file and names every row that is wrong", () => {
    const row = (n: number, code: string, quantity: string, cost: string, extra = false) => ({ row: n, raw: { code, quantity, cost }, extra });
    const good = readOpeningRows([row(2, "HL-1", "10", "600"), row(3, " ch-2 ", "20.5", "270.25")]);
    if (!good.ok) throw new Error("not read");
    expect(good.lines.map((line) => `${line.itemCode} ${line.quantity.toFixed()} at ${line.unitCost?.toFixed()}`)).toEqual(["HL-1 10 at 600", "ch-2 20.5 at 270.25"]);
    expect(readOpeningRows([row(2, "HL-1", "10", "600"), row(3, "", "-4", ""), row(5, "hl-1", "1", "1", true)])).toEqual({
      ok: false,
      problems: [
        { row: 3, name: "", problems: ["The item's code is missing.", "Quantity: Enter the quantity as a plain number without commas, such as 12 or 2.5.", "Unit cost: Enter what one cost."] },
        { row: 5, name: "hl-1", problems: ["The row has more cells than the file has columns.", "The same item is on row 2. Put each item on one row."] },
      ],
    });
  });

  it("reads a count: a number, zero for an empty shelf, nothing for a line not counted", () => {
    expect(readCountStart({ date: D, warehouseId: "w", note: "" })).toEqual({ ok: true, draft: { date: D, warehouseId: "w", note: null } });
    expect(readCountStart({ date: D, warehouseId: "" })).toEqual({ ok: false, reason: "Choose the warehouse to count." });
    const read = readCounted([{ lineId: "a", counted: "4" }, { lineId: "b", counted: "" }, { lineId: "c", counted: "0" }, { lineId: "", counted: "9" }]);
    if (!read.ok) throw new Error(read.reason);
    expect(read.counted.map((line) => `${line.lineId} ${line.counted?.toFixed() ?? "not counted"}`)).toEqual(["a 4", "b not counted", "c 0"]);
    expect(readCounted([{ lineId: "a", counted: "four", label: "HL-1" }])).toEqual({ ok: false, reason: "HL-1: Enter what was counted as a plain number without commas, such as 12 or 2.5." });
    expect(countDifference(d("5"), d("4"))!.toFixed()).toBe("-1");
    expect(countDifference(d("22"), d("23"))!.toFixed()).toBe("1");
    expect(countDifference(d("5"), null)).toBeNull();
  });
});
