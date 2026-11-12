import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { priceInForce, readClass, readDatedPrice, readListName, resolvePrice, type DatedPrice, type PriceCandidates } from "./rules";

const p = (price: string, validFrom: string, validTo: string | null = null): DatedPrice => ({ price: new Decimal(price), validFrom, validTo });
const none: PriceCandidates = { customer: [], class: [], list: [], itemDefault: null };
const answer = (candidates: Partial<PriceCandidates>, on: string) => {
  const found = resolvePrice({ ...none, ...candidates }, on);
  return found ? `${found.price.toFixed()} ${found.source}` : null;
};

describe("resolvePrice: customer-specific > class > list > item default", () => {
  const all: PriceCandidates = { customer: [p("90", "2026-07-01")], class: [p("95", "2026-07-01")], list: [p("100", "2026-07-01")], itemDefault: new Decimal("110") };
  const D = "2026-11-13";

  // The twelve cases of the plan's acceptance.
  it.each<[string, Partial<PriceCandidates>, string, string | null]>([
    ["1. all four levels: the customer's own price wins", all, D, "90 customer"],
    ["2. no customer price: the class price wins", { ...all, customer: [] }, D, "95 class"],
    ["3. no customer or class price: the list price wins", { ...all, customer: [], class: [] }, D, "100 list"],
    ["4. only the item default", { itemDefault: new Decimal("110") }, D, "110 item"],
    ["5. nothing at any level: no price, never a guess", {}, D, null],
    ["6. a customer price that has not started yet is passed over", { ...all, customer: [p("90", "2026-12-01")] }, D, "95 class"],
    ["7. a customer price that has ended is passed over", { ...all, customer: [p("90", "2026-07-01", "2026-10-31")] }, D, "95 class"],
    ["8. a price applies on its first and its last day", { customer: [p("90", "2026-11-13", "2026-11-13")] }, D, "90 customer"],
    ["9. within a level, the price that started latest wins", { list: [p("100", "2026-07-01"), p("105", "2026-11-01"), p("102", "2026-09-01")] }, D, "105 list"],
    ["10. an order dated before a change gets the old price", { list: [p("100", "2026-07-01"), p("105", "2026-11-01")] }, "2026-10-31", "100 list"],
    ["11. a short promotion ends and the open-ended price returns", { class: [p("95", "2026-07-01"), p("80", "2026-11-01", "2026-11-10")] }, D, "95 class"],
    ["12. a higher level wins even when it is the dearer price", { customer: [p("130", "2026-07-01")], class: [p("95", "2026-07-01")], itemDefault: new Decimal("110") }, D, "130 customer"],
  ])("%s", (_, candidates, on, expected) => {
    expect(answer(candidates, on)).toBe(expected);
  });

  it("says where the price came from and since when", () => {
    expect(resolvePrice(all, D)).toMatchObject({ source: "customer", validFrom: "2026-07-01" });
    expect(resolvePrice({ ...none, itemDefault: new Decimal("110") }, D)).toMatchObject({ source: "item", validFrom: null });
  });

  it("keeps a price exact", () => {
    expect(answer({ itemDefault: new Decimal("0.1").plus("0.2") }, D)).toBe("0.3 item");
    expect(answer({ list: [p("1250.5050", "2026-07-01")] }, D)).toBe("1250.505 list");
  });
});

describe("priceInForce", () => {
  const rows = [p("100", "2026-07-01", "2026-09-30"), p("105", "2026-10-01"), p("80", "2026-11-01", "2026-11-10")];
  it("uses only rows whose days include the date", () => {
    expect(priceInForce(rows, "2026-06-30")).toBeNull();
    expect(priceInForce(rows, "2026-09-30")?.price.toFixed()).toBe("100");
    expect(priceInForce(rows, "2026-10-01")?.price.toFixed()).toBe("105");
    expect(priceInForce(rows, "2026-11-10")?.price.toFixed()).toBe("80");
    expect(priceInForce(rows, "2026-11-11")?.price.toFixed()).toBe("105");
    expect(priceInForce([], "2026-11-13")).toBeNull();
  });
});

describe("what a person types", () => {
  it("reads a price with its dates", () => {
    expect(readDatedPrice({ price: "1250.50", validFrom: "2026-11-01", validTo: "" })).toEqual({ ok: true, price: "1250.5000", validFrom: "2026-11-01", validTo: null });
    expect(readDatedPrice({ price: "0", validFrom: "2026-11-01", validTo: "2026-11-30" })).toEqual({ ok: true, price: "0.0000", validFrom: "2026-11-01", validTo: "2026-11-30" });
  });

  it.each([
    [{ price: "1,250", validFrom: "2026-11-01" }, "Price: Enter the amount as a plain number without commas, such as 500000."],
    [{ price: "", validFrom: "2026-11-01" }, "Price: Enter the amount."],
    [{ price: "10", validFrom: "01-11-2026" }, "Enter the date the price applies from."],
    [{ price: "10", validFrom: "2026-11-01", validTo: "soon" }, "Enter the last day the price applies, or leave it empty."],
    [{ price: "10", validFrom: "2026-11-01", validTo: "2026-10-31" }, "The last day cannot be before the first."],
  ])("refuses %j", (raw, reason) => {
    expect(readDatedPrice(raw)).toEqual({ ok: false, reason });
  });

  it("reads a list name and a class", () => {
    expect(readListName("  Wholesale   2026 ")).toEqual({ ok: true, name: "Wholesale 2026" });
    expect(readListName("x").ok).toBe(false);
    expect(readClass(" Wholesale ")).toEqual({ ok: true, customerClass: "Wholesale" });
    expect(readClass("").ok).toBe(false);
  });
});
