import { describe, expect, it } from "vitest";
import { chartOrder, codeCeiling, depthProblem, lockedReason, readAccountName, readCode, readNewAccount, suggestCode, visibleAccounts } from "./rules";

const row = (id: string, parentId: string | null, code: string) => ({ id, parentId, code });

describe("the chart of accounts", () => {
  it("reads each root, then everything beneath it, by code", () => {
    const chart = chartOrder([row("e", null, "5000"), row("a", null, "1000"), row("c", "a", "1200"), row("b", "a", "1100"), row("d", "b", "1110"), row("f", "e", "5100"), row("lost", "nowhere", "9999")]);
    expect(chart.map((a) => `${a.code}@${a.depth}`)).toEqual(["1000@0", "1100@1", "1110@2", "1200@1", "5000@0", "5100@1"]);
    // Codes are compared as numbers where they are numbers: 900 comes before 1000.
    expect(chartOrder([row("x", null, "1000"), row("y", null, "900")]).map((a) => a.code)).toEqual(["900", "1000"]);
  });

  it("hides the sales tax accounts from a company that is not registered", () => {
    const all = [{ controlType: "ar" }, { controlType: "input_tax" }, { controlType: "output_tax" }, { controlType: "wht_sales_tax" }, { controlType: "wht_income_tax" }, { controlType: null }];
    expect(visibleAccounts(all, true)).toHaveLength(6);
    expect(visibleAccounts(all, false).map((a) => a.controlType)).toEqual(["ar", "wht_income_tax", null]);
  });

  it("suggests the next free code under a heading", () => {
    const all = ["1000", "1100", "1110", "1111", "1120", "1200", "1500", "5000", "5100", "5200", "5210", "5330", "5800", "5810"];
    // Under a root the accounts go up in hundreds, under 5200 in tens, under 1120 in ones.
    expect(suggestCode("5000", ["5100", "5200", "5800"], all)).toBe("5900");
    expect(suggestCode("5200", ["5210", "5330"], all, "5800")).toBe("5340");
    expect(suggestCode("1120", [], all, "1200")).toBe("1121");
    expect(suggestCode("1110", ["1111"], all, "1120")).toBe("1112");
    // It follows the last account under the heading, and skips a code taken elsewhere in the chart.
    expect(suggestCode("1100", ["1110", "1120", "1200"], all, "1500")).toBe("1210");
    expect(suggestCode("1100", ["1110", "1120", "1200"], [...all, "1210", "1220"], "1500")).toBe("1230");
    // It never reaches the next heading: with no room at the usual spacing it takes the first gap.
    expect(suggestCode("5200", ["5210", "5790"], [...all, "5790"], "5800")).toBe("5201");
    expect(suggestCode("1100", ["1490"], [...all, "1490"], "1500")).toBe("1101");
    // With no heading after it, a parent keeps to its own round range.
    expect(suggestCode("5000", ["5900"], [...all, "5900"])).toBe("5001");
    expect(suggestCode("5290", [], [...all, ...Array.from({ length: 9 }, (_, i) => `529${i + 1}`)])).toBeNull();
    // A parent that is not a round figure, or not a number at all.
    expect(suggestCode("5341", [], all)).toBe("53411");
    expect(suggestCode("5341", ["53411"], [...all, "53411"])).toBe("53412");
    expect(suggestCode("EXP", [], all)).toBeNull();
    expect(suggestCode("0100", [], all)).toBeNull();
  });

  it("finds the next heading beside a parent, for the suggestion to stop at", () => {
    const chart = [row("a", null, "1000"), row("b", "a", "1100"), row("c", "b", "1110"), row("d", "b", "1120"), row("e", "a", "1500"), row("f", null, "2000"), row("g", "b", "X1")];
    const of = (id: string) => codeCeiling(chart.find((a) => a.id === id)!, chart);
    expect([of("c"), of("d"), of("b"), of("e"), of("a"), of("f"), of("g")]).toEqual(["1120", "1500", "1500", "2000", "2000", null, null]);
  });

  it("stops the chart at five levels, and headings at four", () => {
    expect([depthProblem(0, true), depthProblem(3, true), depthProblem(4, false)]).toEqual([null, null, null]);
    expect(depthProblem(4, true)).toContain("A heading cannot sit at the deepest level");
    expect(depthProblem(5, false)).toContain("at most five levels deep");
  });

  it("cleans a code and a name, or says what is wrong", () => {
    expect(readCode(" 5340 ")).toEqual({ ok: true, code: "5340" });
    expect(readCode("exp-01")).toEqual({ ok: true, code: "EXP-01" });
    for (const bad of ["", "-12", "12 34", "1234567890123", "5340!", null]) expect(readCode(bad).ok, String(bad)).toBe(false);
    expect(readAccountName("  Shop   rent ")).toEqual({ ok: true, name: "Shop rent" });
    for (const bad of ["", "x", "y".repeat(81), 12]) expect(readAccountName(bad).ok, String(bad)).toBe(false);
  });

  it("reads a new account: a heading to sit under, a name, an optional code, and what it is", () => {
    expect(readNewAccount({ parentId: "p", name: "Shop rent", code: "", kind: "account" })).toEqual({ ok: true, account: { parentId: "p", name: "Shop rent", code: null, isGroup: false } });
    expect(readNewAccount({ parentId: "p", name: "Branch costs", code: "5600", kind: "heading" })).toEqual({ ok: true, account: { parentId: "p", name: "Branch costs", code: "5600", isGroup: true } });
    expect(readNewAccount({ name: "Shop rent", kind: "account" })).toEqual({ ok: false, reason: "Choose the heading the account sits under." });
    expect(readNewAccount({ parentId: "p", name: "Shop rent", kind: "both" })).toEqual({ ok: false, reason: "Say whether this is an account or a heading." });
    expect(readNewAccount({ parentId: "p", name: "Shop rent", code: "!!", kind: "account" }).ok).toBe(false);
    expect(readNewAccount({ parentId: "p", name: "", kind: "account" }).ok).toBe(false);
  });

  it("says a locked account cannot be changed", () => {
    expect(lockedReason({ isControl: false })).toBeNull();
    expect(lockedReason({ isControl: true })).toContain("locked");
  });
});
