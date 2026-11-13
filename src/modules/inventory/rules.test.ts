import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { averageCost, issue, receive, remainingToDeliver, type StockOnHand } from "./rules";

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
