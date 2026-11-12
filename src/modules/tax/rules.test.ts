import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  checkNonAtlRate,
  checkRateForKind,
  formatPercent,
  inForceOn,
  legalReferenceSchema,
  parseOptionalPercent,
  parsePercent,
  sroTextSchema,
  taxCategoryKindSchema,
  taxCategoryNameSchema,
  taxRateOn,
  withholdingCodeSchema,
  withholdingRateFor,
  withholdingRuleOn,
} from "./rules";

const d = (value: string) => new Decimal(value);

describe("tax input", () => {
  it("requires a name, a kind and a legal reference", () => {
    expect(taxCategoryNameSchema.parse("  Reduced 10% ")).toBe("Reduced 10%");
    expect(taxCategoryNameSchema.safeParse("x").success).toBe(false);
    expect(taxCategoryKindSchema.parse("third_schedule")).toBe("third_schedule");
    expect(taxCategoryKindSchema.safeParse("luxury").success).toBe(false);
    expect(legalReferenceSchema.parse(" Sales Tax Act 1990, s.3(1) ")).toBe("Sales Tax Act 1990, s.3(1)");
    expect(legalReferenceSchema.safeParse("  ").success).toBe(false);
  });

  it("reads an SRO number, and a blank one as none", () => {
    expect(sroTextSchema.parse(" Eighth Schedule ")).toBe("Eighth Schedule");
    expect(sroTextSchema.parse("   ")).toBeNull();
    expect(sroTextSchema.safeParse("x".repeat(61)).success).toBe(false);
  });

  it("accepts only a rule code of the known shape", () => {
    expect(withholdingCodeSchema.parse("income_tax.goods.company")).toBe("income_tax.goods.company");
    for (const bad of ["income_tax", "Income.Tax", "a..b", "a.b;drop", ""]) {
      expect(withholdingCodeSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("parsePercent", () => {
  it("reads a plain number exactly, as a decimal", () => {
    const parsed = parsePercent(" 5.50 ");
    expect(parsed.ok && parsed.percent.equals("5.5")).toBe(true);
    const small = parsePercent("0.25");
    expect(small.ok && small.percent.toFixed()).toBe("0.25");
    const zero = parsePercent("0");
    expect(zero.ok && zero.percent.isZero()).toBe(true);
    const whole = parsePercent("100");
    expect(whole.ok && whole.percent.toFixed()).toBe("100");
    // A value a JS number cannot hold exactly stays exact.
    const exact = parsePercent("0.1");
    expect(exact.ok && exact.percent.plus("0.2").toFixed()).toBe("0.3");
  });

  it.each([
    ["", "Enter the rate."],
    ["abc", "Enter the rate as a plain number, such as 18 or 5.5."],
    ["18%", "Enter the rate as a plain number, such as 18 or 5.5."],
    ["-4", "Enter the rate as a plain number, such as 18 or 5.5."],
    ["1e1", "Enter the rate as a plain number, such as 18 or 5.5."],
    [".5", "Enter the rate as a plain number, such as 18 or 5.5."],
    ["1,5", "Enter the rate as a plain number, such as 18 or 5.5."],
    ["5.12345", "Use at most 4 digits after the point."],
    ["100.0001", "A rate cannot be more than 100."],
    ["101", "A rate cannot be more than 100."],
    ["1800", "A rate cannot be more than 100."],
  ])("refuses %j", (input, reason) => {
    expect(parsePercent(input)).toEqual({ ok: false, reason });
  });

  it("refuses anything that is not text", () => {
    expect(parsePercent(18)).toEqual({ ok: false, reason: "Enter the rate." });
    expect(parsePercent(null)).toEqual({ ok: false, reason: "Enter the rate." });
  });

  it("reads nothing typed as none where a rate is optional", () => {
    expect(parseOptionalPercent("  ")).toEqual({ ok: true, percent: null });
    expect(parseOptionalPercent(null)).toEqual({ ok: true, percent: null });
    const typed = parseOptionalPercent("10");
    expect(typed.ok && typed.percent?.toFixed()).toBe("10");
    expect(parseOptionalPercent("ten")).toEqual({ ok: false, reason: "Enter the rate as a plain number, such as 18 or 5.5." });
  });
});

describe("formatPercent", () => {
  it("shows a percentage without trailing zeros", () => {
    expect(formatPercent(d("18"))).toBe("18%");
    expect(formatPercent(d("5.5000"))).toBe("5.5%");
    expect(formatPercent(d("0.25"))).toBe("0.25%");
    expect(formatPercent(d("0"))).toBe("0%");
    expect(formatPercent(d("100"))).toBe("100%");
  });
});

describe("checkRateForKind", () => {
  it("lets an exempt category carry no tax at all", () => {
    expect(checkRateForKind("exempt", d("0"), d("0"))).toEqual({ ok: true });
    const refused = { ok: false, reason: "Exempt goods carry no tax. Leave both rates at 0." };
    expect(checkRateForKind("exempt", d("18"), d("0"))).toEqual(refused);
    expect(checkRateForKind("exempt", d("0"), d("4"))).toEqual(refused);
  });

  it("fixes a zero-rated category's rate at 0 but lets it carry further tax, as the law can", () => {
    expect(checkRateForKind("zero_rated", d("0"), d("0"))).toEqual({ ok: true });
    expect(checkRateForKind("zero_rated", d("0"), d("4"))).toEqual({ ok: true });
    expect(checkRateForKind("zero_rated", d("5"), d("0"))).toEqual({
      ok: false,
      reason: "Zero-rated goods are taxed at 0. Leave the rate at 0.",
    });
  });

  it("requires a rate above zero for every taxed kind", () => {
    for (const kind of ["standard", "reduced", "third_schedule"] as const) {
      expect(checkRateForKind(kind, d("0"), d("0")).ok, kind).toBe(false);
      expect(checkRateForKind(kind, d("10"), d("0")).ok, kind).toBe(true);
    }
  });
});

describe("checkNonAtlRate", () => {
  it("always wants the second rate for income tax, never lower than the first", () => {
    expect(checkNonAtlRate("income_tax", d("5"), d("10"))).toEqual({ ok: true });
    expect(checkNonAtlRate("income_tax", d("5"), d("5"))).toEqual({ ok: true });
    // Nothing typed is not "the same as the normal rate": it is refused.
    expect(checkNonAtlRate("income_tax", d("5"), null)).toEqual({
      ok: false,
      reason: "Enter the rate for a supplier who is not on the Active Taxpayers List. It is normally double.",
    });
    expect(checkNonAtlRate("income_tax", d("6"), d("5"))).toEqual({
      ok: false,
      reason: "The rate for a supplier who is not on the Active Taxpayers List cannot be lower than the normal rate.",
    });
  });

  it("allows one rate only on the other kinds of rule", () => {
    for (const kind of ["sales_tax", "provincial_sales_tax"] as const) {
      expect(checkNonAtlRate(kind, d("20"), null), kind).toEqual({ ok: true });
      expect(checkNonAtlRate(kind, d("20"), d("40")), kind).toEqual({
        ok: false,
        reason: "This rule has one rate for every supplier. Leave the second rate empty.",
      });
    }
  });
});

describe("the row in force on a date", () => {
  const rows = [
    { effectiveFrom: "2027-01-01", rate: "19" },
    { effectiveFrom: "2026-07-01", rate: "18" },
    { effectiveFrom: "2027-07-01", rate: "20" },
  ];

  it("returns the row that starts on the day itself", () => {
    expect(inForceOn(rows, "2027-01-01")?.rate).toBe("19");
  });

  it("returns the latest row before the day when none starts on it", () => {
    expect(inForceOn(rows, "2026-12-31")?.rate).toBe("18");
    expect(inForceOn(rows, "2027-06-30")?.rate).toBe("19");
  });

  it("returns the newest row for any later day", () => {
    expect(inForceOn(rows, "2031-03-05")?.rate).toBe("20");
  });

  it("returns nothing for a day before the first row, or when there are no rows", () => {
    expect(inForceOn(rows, "2026-06-30")).toBeNull();
    expect(inForceOn([], "2026-11-12")).toBeNull();
  });
});

describe("taxRateOn", () => {
  const standard = "11111111-1111-4111-8111-111111111111";
  const reduced = "22222222-2222-4222-8222-222222222222";
  const rates = [
    { categoryId: standard, effectiveFrom: "2026-07-01", rate: d("18"), furtherTaxRate: d("4") },
    { categoryId: reduced, effectiveFrom: "2026-07-01", rate: d("10"), furtherTaxRate: d("0") },
    // The standard rate changes on 1 January 2027.
    { categoryId: standard, effectiveFrom: "2027-01-01", rate: d("19"), furtherTaxRate: d("4") },
  ];

  it("gives an invoice dated before a change the old rate", () => {
    expect(taxRateOn(rates, standard, "2026-12-31")?.rate.toFixed()).toBe("18");
    expect(taxRateOn(rates, standard, "2026-07-01")?.rate.toFixed()).toBe("18");
  });

  it("gives an invoice dated on or after the change the new rate", () => {
    expect(taxRateOn(rates, standard, "2027-01-01")?.rate.toFixed()).toBe("19");
    expect(taxRateOn(rates, standard, "2027-03-15")?.rate.toFixed()).toBe("19");
  });

  it("never mixes one category's rates with another's", () => {
    expect(taxRateOn(rates, reduced, "2027-03-15")?.rate.toFixed()).toBe("10");
  });

  it("returns nothing before the category had a rate, or for an unknown category", () => {
    expect(taxRateOn(rates, standard, "2026-06-30")).toBeNull();
    expect(taxRateOn(rates, "33333333-3333-4333-8333-333333333333", "2027-03-15")).toBeNull();
  });
});

describe("withholding rules", () => {
  const rules = [
    { code: "income_tax.goods.company", effectiveFrom: "2026-07-01", rate: d("5"), rateNonAtl: d("10") },
    { code: "income_tax.goods.company", effectiveFrom: "2027-07-01", rate: d("6"), rateNonAtl: d("12") },
    { code: "sales_tax.registered", effectiveFrom: "2026-07-01", rate: d("20"), rateNonAtl: null },
  ];

  it("finds a rule by its code and the date, old rate before a change", () => {
    expect(withholdingRuleOn(rules, "income_tax.goods.company", "2027-06-30")?.rate.toFixed()).toBe("5");
    expect(withholdingRuleOn(rules, "income_tax.goods.company", "2027-07-01")?.rate.toFixed()).toBe("6");
    expect(withholdingRuleOn(rules, "income_tax.goods.company", "2026-06-30")).toBeNull();
    expect(withholdingRuleOn(rules, "income_tax.services.company", "2027-07-01")).toBeNull();
  });

  it("uses the higher rate for a supplier who is not on the Active Taxpayers List", () => {
    const rule = withholdingRuleOn(rules, "income_tax.goods.company", "2026-11-12")!;
    expect(withholdingRateFor(rule, true).toFixed()).toBe("5");
    expect(withholdingRateFor(rule, false).toFixed()).toBe("10");
  });

  it("ignores the list where the law sets one rate for everyone", () => {
    const rule = withholdingRuleOn(rules, "sales_tax.registered", "2026-11-12")!;
    expect(withholdingRateFor(rule, true).toFixed()).toBe("20");
    expect(withholdingRateFor(rule, false).toFixed()).toBe("20");
  });
});
