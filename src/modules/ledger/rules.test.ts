import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { CONTROL_TYPES, CUSTOMER_CONTROLS, JOURNAL_SOURCES, SUBLEDGER_CONTROLS, SUPPLIER_CONTROLS, chartOrder, checkJournalLines, codeCeiling, depthProblem, isJournalSource, lockedReason, readAccountName, readCode, readNewAccount, suggestCode, visibleAccounts } from "./rules";

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

describe("a journal", () => {
  const d = (value: string) => new Decimal(value);
  const line = (debit: string | null, credit: string | null, more: object = {}) => ({ accountId: "a", debit: debit === null ? null : d(debit), credit: credit === null ? null : d(credit), ...more });

  it("balances: debits equal credits, to the last decimal", () => {
    expect(checkJournalLines([line("40000", null), line(null, "40000")])).toEqual({ ok: true, total: d("40000") });
    const split = checkJournalLines([line("450000", null), line("50000.0001", null), line(null, "500000.0001")]);
    expect(split.ok && split.total.toFixed(4)).toBe("500000.0001");
    // Tenths that a binary number cannot hold add up exactly here.
    expect(checkJournalLines([line("0.1", null), line("0.2", null), line(null, "0.3")]).ok).toBe(true);
    // Sixteen digits before the point, summed without losing the last decimal.
    expect(checkJournalLines([line("9999999999999999.9999", null), line("9999999999999999.9999", null), line(null, "9999999999999999.9999"), line(null, "9999999999999999.9999")]).ok).toBe(true);
    expect(checkJournalLines([line("100", null), line(null, "99.9999")])).toEqual({ ok: false, reason: "The journal does not balance: debits are 100.00 and credits are 99.9999." });
  });

  it("has at least two lines, each a debit or a credit above zero and never both", () => {
    expect(checkJournalLines([])).toEqual({ ok: false, reason: "A journal needs at least two lines: a debit and a credit." });
    expect(checkJournalLines([line("5", null)]).ok).toBe(false);
    expect(checkJournalLines(Array.from({ length: 1001 }, () => line("1", null)))).toEqual({ ok: false, reason: "A journal can have at most 1000 lines." });
    expect(checkJournalLines([line("5", "5"), line(null, "5")])).toEqual({ ok: false, reason: "Line 1: enter a debit or a credit, not both." });
    expect(checkJournalLines([line("5", null), line(null, null)])).toEqual({ ok: false, reason: "Line 2: enter a debit or a credit." });
    expect(checkJournalLines([line("0", "0"), line(null, "5")])).toEqual({ ok: false, reason: "Line 1: enter a debit or a credit." });
    expect(checkJournalLines([line("-5", null), line(null, "-5")])).toEqual({ ok: false, reason: "Line 1: an amount cannot be negative." });
    expect(checkJournalLines([line("5.00001", null), line(null, "5.00001")])).toEqual({ ok: false, reason: "Line 1: an amount has at most 4 digits after the point." });
    expect(checkJournalLines([line("10000000000000000", null), line(null, "10000000000000000")])).toEqual({ ok: false, reason: "Line 1: that amount is too large." });
    expect(checkJournalLines([{ accountId: "a", debit: new Decimal(NaN) }, line(null, "5")]).ok).toBe(false);
    expect(checkJournalLines([line("5", null, { customerId: "c", supplierId: "s" }), line(null, "5")])).toEqual({ ok: false, reason: "Line 1: a line belongs to a customer or to a supplier, not both." });
  });

  it("knows what may post, and which accounts are kept by their own documents", () => {
    expect(isJournalSource("manual_journal")).toBe(true);
    for (const not of ["reversal", "sales_invoice", "", null, "constructor"]) expect(isJournalSource(not), String(not)).toBe(false);
    expect(JOURNAL_SOURCES.manual_journal.roles).toEqual(["owner", "accountant"]);
    expect(JOURNAL_SOURCES.manual_journal.blockedControls).toEqual(SUBLEDGER_CONTROLS);
    // Every name used for an account is one the chart knows.
    for (const control of [...SUBLEDGER_CONTROLS, ...CUSTOMER_CONTROLS, ...SUPPLIER_CONTROLS]) expect(Object.keys(CONTROL_TYPES), control).toContain(control);
  });
});
