import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { checkSplits, commissionOnLine, makesCycle, managerShare, managersAbove, rangesOverlap, readPlan, slabs, type LineFacts, type PlanTerms } from "./rules";

// The old prototype's commission tests (reference/tests/qa/12-commissions.test.ts), ported by
// hand to the new rules. Each keeps its old number. COM-014 is changed on purpose: the founder
// decided on 2026-11-14 that slabs are measured on the month's sales, not on each line.

const d = (value: string | number) => new Decimal(value);
const plan = (over: Partial<PlanTerms> = {}): PlanTerms => ({
  kind: "flat",
  rate: d(2),
  categoryRates: new Map(),
  classRates: new Map(),
  tiers: [],
  target: d(0),
  multiplier: d(1),
  teamRate: d(0),
  ...over,
});
/** The old tests' default line: 100 × 100 = 10,000 net, no tax. */
const line = (over: Partial<LineFacts> = {}): LineFacts => ({ base: d(10000), quantity: d(100), categoryId: null, customerClass: null, ...over });
const earned = (p: PlanTerms, l: LineFacts, before: number = 0) => commissionOnLine(p, l, d(before)).toFixed(4);

describe("what a line earns (the old COM tests)", () => {
  it("COM-011 category plan: Lighting earns 2.5%, other categories the plan's rate", () => {
    const p = plan({ kind: "category", rate: d(1), categoryRates: new Map([["lighting", d(2.5)]]) });
    expect([earned(p, line({ categoryId: "lighting" })), earned(p, line({ categoryId: "home" }))]).toEqual(["250.0000", "100.0000"]);
    expect(earned(p, line({ categoryId: null }))).toBe("100.0000");
  });

  it("COM-012 customer-class plan: Wholesaler 1%, other classes the plan's rate", () => {
    const p = plan({ kind: "customer_class", rate: d(3), classRates: new Map([["wholesaler", d(1)]]) });
    expect([earned(p, line({ customerClass: "Wholesaler" })), earned(p, line({ customerClass: "Retailer" }))]).toEqual(["100.0000", "300.0000"]);
    expect(earned(p, line({ customerClass: " WHOLESALER " }))).toBe("100.0000");
  });

  it("COM-013 per-unit plan rate 10: quantity × 10; COM-071: quantity 0.5 at 10 earns 5", () => {
    expect(earned(plan({ kind: "per_unit", rate: d(10) }), line({ quantity: d(7), base: d(700) }))).toBe("70.0000");
    expect(earned(plan({ kind: "per_unit", rate: d(10) }), line({ quantity: d(0.5), base: d(50) }))).toBe("5.0000");
  });

  it("COM-014, changed by the founder: slabs 0 at 2% and 500,000 at 3%, measured on the month's sales", () => {
    const p = plan({ kind: "tiered", tiers: [{ threshold: d(0), rate: d(2) }, { threshold: d(500000), rate: d(3) }] });
    // A first sale of 600,000 in the month: 500,000 at 2% and 100,000 at 3% (as before).
    expect(earned(p, line({ base: d(600000) }))).toBe("13000.0000");
    // A second of 100,000 in the same month is all above 500,000: 3,000 (the old per-line rule gave 2,000).
    expect(earned(p, line({ base: d(100000) }), 600000)).toBe("3000.0000");
    // The same sale first in a month earns 2% (the old number).
    expect(earned(p, line({ base: d(100000) }))).toBe("2000.0000");
    // A sale that crosses the slab is split at it.
    expect(earned(p, line({ base: d(200000) }), 400000)).toBe("5000.0000");
  });

  it("COM-072 a total exactly at the slab earns the lower rate; one rupee more earns 3 paisa", () => {
    const tiers = [{ threshold: d(0), rate: d(2) }, { threshold: d(500000), rate: d(3) }];
    expect(slabs(tiers, d(500000)).toFixed(4)).toBe("10000.0000");
    expect(slabs(tiers, d(500001)).toFixed(4)).toBe("10000.0300");
    expect(earned(plan({ kind: "tiered", tiers }), line({ base: d(500001) }))).toBe("10000.0300");
  });

  it("COM-015 target 15,000 with multiplier 2: from the sale that reaches it onwards", () => {
    const p = plan({ target: d(15000), multiplier: d(2) });
    expect([earned(p, line(), 0), earned(p, line(), 10000), earned(p, line(), 20000)]).toEqual(["200.0000", "400.0000", "400.0000"]);
  });

  it("COM-016 flat 2% on 10,000 earns 200", () => {
    expect(earned(plan(), line())).toBe("200.0000");
  });

  it("COM-032 a 60/40 split: each share earns on its own part", () => {
    expect(earned(plan(), line({ base: d(6000), quantity: d(60) }))).toBe("120.0000");
    expect(earned(plan(), line({ base: d(4000), quantity: d(40) }))).toBe("80.0000");
  });

  it("COM-033 splits must total 100", () => {
    expect(checkSplits([d(60), d(30)])).toBe("Commission splits must total 100%.");
    expect(checkSplits([d(60), d(40)])).toBeNull();
    expect(checkSplits([d(33.34), d(33.33), d(33.33)])).toBeNull();
  });

  it("COM-038 and COM-039: the base is after discount and before tax, as Step 38 hands it over", () => {
    expect(earned(plan(), line({ base: d(9000) }))).toBe("180.0000");
    expect(earned(plan(), line({ base: d(10000) }))).toBe("200.0000");
  });

  it("COM-069 rate 0 earns 0; COM-070 rate 100 earns the base", () => {
    expect(earned(plan({ rate: d(0) }), line())).toBe("0.0000");
    expect(earned(plan({ rate: d(100) }), line())).toBe("10000.0000");
  });

  it("COM-077 rounding: 2% of 33.33 is 0.6666", () => {
    expect(earned(plan(), line({ base: d(33.33), quantity: d(1) }))).toBe("0.6666");
    // Half a ten-thousandth goes up.
    expect(earned(plan({ rate: d(1) }), line({ base: d(0.005) }))).toBe("0.0001");
  });

  it("a manager earns their plan's team rate on the seller's base", () => {
    expect(managerShare(d(0.5), d(10000)).toFixed(4)).toBe("50.0000");
    expect(managerShare(d(0), d(10000)).toFixed(4)).toBe("0.0000");
  });
});

describe("plans as typed (the old COM-003 to COM-010)", () => {
  const good = { name: "Standard plan", kind: "flat", rate: "2", from: "2026-07-01", to: "" };
  it("reads a good plan, with no end and the defaults", () => {
    const read = readPlan(good);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.draft).toMatchObject({ name: "Standard plan", userId: null, kind: "flat", from: "2026-07-01", to: null });
    if (read.ok) expect([read.draft.rate.toFixed(), read.draft.target.toFixed(), read.draft.multiplier.toFixed(), read.draft.teamRate.toFixed()]).toEqual(["2", "0", "1", "0"]);
  });
  it("COM-003 an end before the start is refused", () => {
    expect(readPlan({ ...good, from: "2026-06-01", to: "2026-05-31" })).toEqual({ ok: false, reason: "Plan dates are invalid." });
  });
  it("COM-006 a one-letter name is refused", () => {
    expect(readPlan({ ...good, name: "P" })).toMatchObject({ ok: false });
  });
  it("COM-007 a rate below nothing is refused", () => {
    expect(readPlan({ ...good, rate: "-1" })).toEqual({ ok: false, reason: "The rate cannot be negative." });
  });
  it("COM-008 a category rate above 100 is refused", () => {
    expect(readPlan({ ...good, kind: "category", categoryRates: [{ categoryId: "0b6a4b0e-0000-4000-8000-000000000001", rate: "101" }] })).toEqual({ ok: false, reason: "Percentage cannot exceed 100." });
    expect(readPlan({ ...good, rate: "100.01" })).toEqual({ ok: false, reason: "Percentage cannot exceed 100." });
  });
  it("COM-009 a slab plan with no slab is refused", () => {
    expect(readPlan({ ...good, kind: "tiered", tiers: [] })).toEqual({ ok: false, reason: "A slab plan needs at least one slab." });
    expect(readPlan({ ...good, kind: "tiered", tiers: [{ threshold: "0", rate: "2" }, { threshold: "0", rate: "3" }] })).toEqual({ ok: false, reason: "Two slabs start at the same amount." });
  });
  it("COM-010 a multiplier of 0 is refused", () => {
    expect(readPlan({ ...good, multiplier: "0" })).toEqual({ ok: false, reason: "Amount must be greater than zero." });
  });
  it("a per-unit amount may be more than 100; numbers with commas are refused", () => {
    expect(readPlan({ ...good, kind: "per_unit", rate: "250" }).ok).toBe(true);
    expect(readPlan({ ...good, rate: "1,000" })).toMatchObject({ ok: false });
  });
});

describe("dates and the hierarchy (the old COM-004, COM-005, COM-049, COM-050)", () => {
  it("COM-004 overlapping plans overlap; COM-005 plans end to end do not", () => {
    expect(rangesOverlap({ from: "2026-01-01", to: "2026-12-31" }, { from: "2026-06-01", to: "2027-06-30" })).toBe(true);
    expect(rangesOverlap({ from: "2026-01-01", to: "2026-12-31" }, { from: "2027-01-01", to: "2027-12-31" })).toBe(false);
    expect(rangesOverlap({ from: "2026-01-01", to: null }, { from: "2030-01-01", to: "2030-12-31" })).toBe(true);
    expect(rangesOverlap({ from: "2026-01-01", to: "2026-12-31" }, { from: "2026-12-31", to: null })).toBe(true);
  });

  it("COM-049 a circle A → B → A is refused; COM-050 nobody is their own manager", () => {
    const managerOf = new Map([["B", "A"]]);
    expect(makesCycle("A", "B", managerOf)).toBe(true);
    expect(makesCycle("A", "A", new Map())).toBe(true);
    expect(makesCycle("C", "B", managerOf)).toBe(false);
    // A longer circle: C under B under A; making A report to C closes it.
    expect(makesCycle("A", "C", new Map([["B", "A"], ["C", "B"]]))).toBe(true);
  });

  it("lists everyone above a member, nearest first", () => {
    expect(managersAbove("C", new Map([["C", "B"], ["B", "A"]]))).toEqual(["B", "A"]);
    expect(managersAbove("A", new Map([["C", "B"], ["B", "A"]]))).toEqual([]);
  });
});
