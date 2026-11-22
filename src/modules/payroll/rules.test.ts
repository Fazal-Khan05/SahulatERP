import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { daysIn, monthlySalaryTax, parseDays, payForMonth, payOn, slabProblem, slabTax, statutoryOn, surcharge, taxableMonthlyPay, type Slab, type StatutoryRow } from "./rules";

// The figures are those of docs/examples/step-40.md: the salaried individuals' tables of the
// First Schedule, Part I, Division I, clause (2), for Tax Year 2027 (Finance Act 2026) and Tax
// Year 2026 (Finance Act 2025). Checked by Claude, not an accountant.

const d = (value: string | number) => new Decimal(value);
const slab = (over: number, upTo: number | null, fixed: number, rate: number): Slab => ({ over: d(over), upTo: upTo === null ? null : d(upTo), fixed: d(fixed), rate: d(rate) });

const TY2027 = [
  slab(0, 600_000, 0, 0),
  slab(600_000, 1_200_000, 0, 1),
  slab(1_200_000, 2_200_000, 6_000, 11),
  slab(2_200_000, 3_200_000, 116_000, 20),
  slab(3_200_000, 4_100_000, 316_000, 25),
  slab(4_100_000, 5_600_000, 541_000, 29),
  slab(5_600_000, 7_000_000, 976_000, 32),
  slab(7_000_000, null, 1_424_000, 35),
];
const TY2026 = [slab(0, 600_000, 0, 0), slab(600_000, 1_200_000, 0, 1), slab(1_200_000, 2_200_000, 6_000, 11), slab(2_200_000, 3_200_000, 116_000, 23), slab(3_200_000, 4_100_000, 346_000, 30), slab(4_100_000, null, 616_000, 35)];

describe("income tax on salary", () => {
  it("acceptance: Rs 150,000 a month is Rs 72,000 a year, Rs 6,000 a month", () => {
    const worked = monthlySalaryTax(d(150_000), TY2027, null)!;
    expect([worked.annualIncome.toFixed(2), worked.annualTax.toFixed(2), worked.monthly.toFixed(2)]).toEqual(["1800000.00", "72000.00", "6000.00"]);
  });

  it("takes each slab from just over its lower bound to its upper bound", () => {
    const cases: [number, string][] = [
      [600_000, "0.00"],
      [600_001, "0.01"],
      [1_200_000, "6000.00"],
      [2_200_000, "116000.00"],
      [3_200_000, "316000.00"],
      [4_100_000, "541000.00"],
      [5_600_000, "976000.00"],
      [7_000_000, "1424000.00"],
      [10_000_000, "2474000.00"],
    ];
    for (const [annual, tax] of cases) expect(slabTax(d(annual), TY2027)!.toFixed(2), String(annual)).toBe(tax);
    expect(slabTax(d(0), TY2027)!.toFixed(2)).toBe("0.00");
  });

  it("finds both shipped tables whole: no gaps, and each fixed amount what the slabs below come to", () => {
    expect(slabProblem(TY2027)).toBeNull();
    expect(slabProblem(TY2026)).toBeNull();
    expect(slabProblem([slab(0, 600_000, 0, 0), slab(700_000, null, 0, 1)])).toBe("Slab 1 must end where slab 2 starts.");
    expect(slabProblem([slab(0, 600_000, 0, 5), slab(600_000, null, 0, 1)])).toBe("Slab 2: its fixed amount should be 30000.00, what the slabs below it come to.");
    expect(slabProblem([slab(0, 600_000, 0, 0)])).toBe("The last slab must have no upper limit.");
    expect(slabProblem([slab(1, null, 0, 0)])).toBe("The first slab must start at nil.");
    // A table with a gap is refused when used, not guessed at.
    expect(slabTax(d(650_000), [slab(0, 600_000, 0, 0), slab(700_000, null, 0, 1)])).toBeNull();
  });

  it("charges the 9% surcharge of Tax Year 2026 only above Rs 10 million, and none in Tax Year 2027", () => {
    const ty2026 = { rate: d(9), threshold: d(10_000_000) };
    expect(surcharge(d(10_000_000), d(3_116_000), ty2026).toFixed(2)).toBe("0.00");
    // Rs 1,000,000 a month: 12m a year; 616,000 + 35% of 7.9m = 3,381,000; surcharge 9% = 304,290.
    const worked = monthlySalaryTax(d(1_000_000), TY2026, ty2026)!;
    expect([worked.annualTax.toFixed(2), worked.monthly.toFixed(2)]).toEqual(["3685290.00", "307107.50"]);
    // Tax Year 2027: 1,424,000 + 35% of 5m = 3,174,000, and no surcharge.
    expect(monthlySalaryTax(d(1_000_000), TY2027, { rate: d(0), threshold: d(10_000_000) })!.annualTax.toFixed(2)).toBe("3174000.00");
  });

  it("leaves out of what is taxed the medical allowance up to 10% of basic pay, and nothing else", () => {
    const pay = new Map([
      ["basic", d(100_000)],
      ["house_rent", d(45_000)],
      ["medical", d(15_000)],
      ["conveyance", d(5_000)],
      ["fixed_deduction", d(2_000)],
    ] as const);
    // 165,000 paid; 10,000 of the 15,000 medical allowance is exempt; the fixed deduction does not lower what is taxed.
    expect(taxableMonthlyPay(pay, d(10)).toFixed(2)).toBe("155000.00");
    // docs/examples/step-40.md, case C: 1,860,000 a year, 78,600 tax, 6,550 a month.
    expect(monthlySalaryTax(taxableMonthlyPay(pay, d(10)), TY2027, null)!.monthly.toFixed(2)).toBe("6550.00");
    expect(taxableMonthlyPay(pay, null).toFixed(2)).toBe("165000.00");
  });
});

describe("pay and attendance", () => {
  it("reads each component's amount in force on a date, and nil ends it", () => {
    const rows = [
      { component: "basic" as const, amount: d(100_000), effectiveFrom: "2026-07-01" },
      { component: "basic" as const, amount: d(110_000), effectiveFrom: "2026-10-01" },
      { component: "conveyance" as const, amount: d(5_000), effectiveFrom: "2026-07-01" },
      { component: "conveyance" as const, amount: d(0), effectiveFrom: "2026-09-01" },
    ];
    expect(Object.fromEntries([...payOn(rows, "2026-08-15")].map(([k, v]) => [k, v.toFixed()]))).toEqual({ basic: "100000", conveyance: "5000" });
    expect(Object.fromEntries([...payOn(rows, "2026-10-01")].map(([k, v]) => [k, v.toFixed()]))).toEqual({ basic: "110000" });
    expect(payOn(rows, "2026-06-30").size).toBe(0);
  });

  it("takes an unpaid day off a monthly salary at the month's pay over its days, and pays a daily wage per day worked", () => {
    expect(daysIn("2026-11-01")).toBe(30);
    expect(daysIn("2027-02-01")).toBe(28);
    expect(payForMonth("monthly", d(60_000), "2026-11-01", { worked: d(0), unpaid: d(3) }).toFixed(2)).toBe("54000.00");
    expect(payForMonth("monthly", d(62_000), "2026-12-01", { worked: d(0), unpaid: d(1.5) }).toFixed(2)).toBe("59000.00");
    expect(payForMonth("daily", d(1_600), "2026-11-01", { worked: d(24.5), unpaid: d(0) }).toFixed(2)).toBe("39200.00");
  });

  it("reads days as whole or half days within the month", () => {
    expect(parseDays("2.5", "2026-11-01")).toEqual({ ok: true, days: d(2.5) });
    expect(parseDays("", "2026-11-01")).toEqual({ ok: true, days: d(0) });
    expect(parseDays("31", "2026-11-01")).toEqual({ ok: false, reason: "The month has 30 days." });
    expect(parseDays("2.25", "2026-11-01")).toEqual({ ok: false, reason: "Enter days as a whole number or a half, such as 2 or 1.5." });
  });
});

describe("the statutory tables", () => {
  const row = (kind: StatutoryRow["kind"], province: StatutoryRow["province"], effectiveFrom: string, amount: number | null, rate: number | null = null): StatutoryRow => ({
    kind,
    province,
    effectiveFrom,
    amount: amount === null ? null : d(amount),
    rate: rate === null ? null : d(rate),
    legalReference: "x",
  });
  const rows = [row("minimum_wage", "sindh", "2025-07-01", 40_000), row("minimum_wage", "sindh", "2026-07-01", 43_000), row("minimum_wage", "punjab", "2025-07-01", 40_000), row("eobi_employer", null, "2008-07-01", null, 5)];

  it("finds the row in force on a date, by province where the kind goes by province, and nothing to guess from otherwise", () => {
    expect(statutoryOn(rows, "minimum_wage", "2026-06-30", "sindh")?.amount?.toFixed()).toBe("40000");
    expect(statutoryOn(rows, "minimum_wage", "2026-07-01", "sindh")?.amount?.toFixed()).toBe("43000");
    expect(statutoryOn(rows, "minimum_wage", "2026-11-01", "balochistan")).toBeNull();
    expect(statutoryOn(rows, "eobi_employer", "2026-11-01", "punjab")?.rate?.toFixed()).toBe("5");
  });
});
