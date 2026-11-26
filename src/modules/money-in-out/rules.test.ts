import { describe, expect, it } from "vitest";
import { otherSideAllowed, readMoneyInOut, type AccountFacts } from "./rules";

const TODAY = "2026-11-27";
const typed = { direction: "in", date: "2026-11-20", moneyAccountId: "cash", otherAccountId: "capital", amount: "250,000", party: "  Fazal   Khan ", reference: " DEP-1 ", memo: "" };

describe("reading money in or out", () => {
  it("cleans what is typed", () => {
    const read = readMoneyInOut(typed, TODAY);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entry).toMatchObject({ direction: "in", date: "2026-11-20", moneyAccountId: "cash", otherAccountId: "capital", party: "Fazal Khan", reference: "DEP-1", memo: null });
    expect(read.entry.amount.toFixed(2)).toBe("250000.00");
  });

  it("says the first thing that is wrong", () => {
    const reason = (change: Record<string, unknown>) => {
      const read = readMoneyInOut({ ...typed, ...change }, TODAY);
      return read.ok ? null : read.reason;
    };
    expect(reason({ direction: "sideways" })).toMatch(/came in or went out/);
    expect(reason({ date: "" })).toBe("Enter the date.");
    expect(reason({ date: "2026-11-28" })).toBe("That date has not come yet.");
    expect(reason({ moneyAccountId: "" })).toMatch(/came into/);
    expect(reason({ direction: "out", moneyAccountId: "" })).toMatch(/went out of/);
    expect(reason({ otherAccountId: "" })).toMatch(/what the money is/);
    expect(reason({ otherAccountId: "cash" })).toMatch(/transfer/);
    expect(reason({ amount: "0" })).toMatch(/above nothing/);
    expect(reason({ amount: "12.345" })).toMatch(/rupees/);
    expect(reason({ amount: "-5" })).toMatch(/rupees/);
    expect(reason({ party: " x " })).toBe("Say who the money came from.");
    expect(reason({ direction: "out", party: "" })).toBe("Say who the money went to.");
    expect(reason({ party: "a".repeat(121) })).toMatch(/120/);
    expect(reason({ reference: "r".repeat(61) })).toMatch(/60/);
    expect(reason({ memo: "m".repeat(301) })).toMatch(/300/);
  });
});

describe("the other side", () => {
  const account = (change: Partial<AccountFacts> = {}): AccountFacts => ({ type: "equity", isGroup: false, isControl: false, controlType: null, archived: false, ...change });

  it("takes capital, drawings, loans and other income, either way", () => {
    for (const type of ["equity", "liability", "income", "asset"] as const) {
      expect(otherSideAllowed(account({ type }), "in")).toBe(true);
      expect(otherSideAllowed(account({ type }), "out")).toBe(true);
    }
  });

  it("never takes a control account, a heading or an archived account", () => {
    expect(otherSideAllowed(account({ isControl: true, controlType: "ar", type: "asset" }), "in")).toBe(false);
    expect(otherSideAllowed(account({ controlType: "bank", type: "asset" }), "in")).toBe(false);
    expect(otherSideAllowed(account({ isControl: true, controlType: "retained_earnings" }), "out")).toBe(false);
    expect(otherSideAllowed(account({ isGroup: true }), "in")).toBe(false);
    expect(otherSideAllowed(account({ archived: true }), "in")).toBe(false);
  });

  it("leaves expenses to the Expenses form when money goes out", () => {
    expect(otherSideAllowed(account({ type: "expense" }), "out")).toBe(false);
    expect(otherSideAllowed(account({ type: "expense" }), "in")).toBe(true);
  });
});
