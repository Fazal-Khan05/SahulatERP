import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { PayRow, Slab, StatutoryRow } from "@/modules/payroll/rules";
import { approvalJournal, commissionOf, monthEnd, monthsEmployedEarlier, monthsLeftInTaxYear, NO_COMMISSION, runTotals, taxYearStart, workOutPayslip, type PayslipEmployee, type PayslipInput } from "./rules";

// Step 41's worked example (docs/examples/step-41.md), figure for figure, and the edges around it.

const d = (value: string | number) => new Decimal(value);
const slab = (over: number, upTo: number | null, fixed: number, rate: number): Slab => ({ over: d(over), upTo: upTo === null ? null : d(upTo), fixed: d(fixed), rate: d(rate) });
// Tax year 2027 (Finance Act 2026), as shipped in drizzle/0032_payroll_employees.sql.
const TABLE = {
  from: "2026-07-01",
  slabs: [
    slab(0, 600000, 0, 0),
    slab(600000, 1200000, 0, 1),
    slab(1200000, 2200000, 6000, 11),
    slab(2200000, 3200000, 116000, 20),
    slab(3200000, 4100000, 316000, 25),
    slab(4100000, 5600000, 541000, 29),
    slab(5600000, 7000000, 976000, 32),
    slab(7000000, null, 1424000, 35),
  ],
};
const rate = (kind: StatutoryRow["kind"], from: string, figures: { rate?: number; amount?: number }, province: StatutoryRow["province"] = null): StatutoryRow => ({
  kind,
  province,
  effectiveFrom: from,
  rate: figures.rate === undefined ? null : d(figures.rate),
  amount: figures.amount === undefined ? null : d(figures.amount),
  legalReference: "test",
});
const RATES: StatutoryRow[] = [
  rate("salary_surcharge", "2026-07-01", { rate: 0, amount: 10000000 }),
  rate("medical_allowance_exempt", "2003-07-01", { rate: 10 }),
  rate("eobi_employer", "2008-07-01", { rate: 5 }),
  rate("eobi_employee", "2001-07-01", { rate: 1 }),
  rate("eobi_wage", "2024-07-01", { amount: 37000 }),
  rate("eobi_wage", "2026-07-01", { amount: 40700 }),
  rate("minimum_wage", "2025-07-01", { amount: 40000 }, "punjab"),
  rate("minimum_wage", "2026-07-01", { amount: 43000 }, "sindh"),
  rate("social_security_employer", "2025-07-01", { rate: 6 }, "punjab"),
  rate("social_security_employer", "2025-07-01", { rate: 6 }, "sindh"),
];
const pay = (rows: [PayRow["component"], number, string?][]): PayRow[] => rows.map(([component, amount, from]) => ({ component, amount: d(amount), effectiveFrom: from ?? "2026-07-01" }));
const person = (over: Partial<PayslipEmployee>): PayslipEmployee => ({
  id: "e",
  code: "E",
  name: "E",
  payBasis: "monthly",
  province: "punjab",
  joinedOn: "2026-07-01",
  leftOn: null,
  eobi: false,
  socialSecurity: false,
  userId: null,
  ...over,
});
const NOV = "2026-11-01";
const input = (over: Partial<PayslipInput>): PayslipInput => ({
  month: NOV,
  employee: person({}),
  pay: pay([["basic", 100000]]),
  attendance: null,
  slabs: TABLE,
  rates: RATES,
  commission: NO_COMMISSION,
  before: { taxable: d(0), tax: d(0), months: 0 },
  ...over,
});
const worked = (over: Partial<PayslipInput>) => {
  const result = workOutPayslip(input(over));
  if (!result.ok) throw new Error(result.reason);
  return result.payslip;
};
const money = (value: Decimal) => value.toFixed(2);

// ── The worked example ──
const ayesha = () =>
  worked({
    employee: person({ id: "a", code: "E-001", name: "Ayesha Khan", eobi: true, socialSecurity: true, userId: "ayesha-login" }),
    pay: pay([
      ["basic", 150000],
      ["medical", 15000],
      ["fixed_deduction", 5000],
    ]),
    attendance: { daysWorked: d(0), unpaidDays: d(3) },
    commission: { gross: "25000", owed: "3000", digest: "d" },
    before: { taxable: d(600000), tax: d(24000), months: 4 },
  });
const bilal = () =>
  worked({
    employee: person({ id: "b", code: "E-002", name: "Bilal Ahmed", payBasis: "daily", province: "sindh", joinedOn: "2026-11-10", socialSecurity: true }),
    pay: pay([["daily_wage", 2000, "2026-11-10"]]),
    attendance: { daysWorked: d(15), unpaidDays: d(0) },
  });
const kamran = () =>
  worked({
    employee: person({ id: "c", code: "E-003", name: "Kamran Ali", leftOn: "2026-11-20" }),
    pay: pay([["basic", 300000]]),
    before: { taxable: d(1200000), tax: d("138666.68"), months: 4 },
  });

describe("the tax year and the month", () => {
  it("runs from July to June", () => {
    expect([taxYearStart("2026-07-01"), taxYearStart("2026-11-01"), taxYearStart("2027-06-01")]).toEqual(["2026-07-01", "2026-07-01", "2026-07-01"]);
    expect([monthsLeftInTaxYear("2026-07-01"), monthsLeftInTaxYear("2026-11-01"), monthsLeftInTaxYear("2027-01-01"), monthsLeftInTaxYear("2027-06-01")]).toEqual([12, 8, 6, 1]);
    expect([monthEnd("2026-11-01"), monthEnd("2028-02-01")]).toEqual(["2026-11-30", "2028-02-29"]);
    expect([monthsEmployedEarlier("2026-11-01", "2020-01-01"), monthsEmployedEarlier("2026-11-01", "2026-09-30"), monthsEmployedEarlier("2026-07-01", "2026-01-01"), monthsEmployedEarlier("2027-02-01", "2026-12-01")]).toEqual([4, 2, 0, 2]);
  });
});

describe("commission on a payslip", () => {
  it("is what is approved and released, less what is owed back, as far as it goes", () => {
    const of = (gross: string, owed: string) => Object.values(commissionOf({ gross, owed, digest: "d" })).map(money);
    expect(of("25000", "3000")).toEqual(["25000.00", "3000.00", "3000.00", "22000.00"]);
    expect(of("100", "300")).toEqual(["100.00", "300.00", "100.00", "0.00"]);
    expect(of("0", "300")).toEqual(["0.00", "300.00", "0.00", "0.00"]);
    expect(Object.values(commissionOf(NO_COMMISSION)).map(money)).toEqual(["0.00", "0.00", "0.00", "0.00"]);
  });
});

describe("the worked example: November 2026", () => {
  it("Ayesha: 27 of 30 days, commission less what she owed back, tax spread over the eight months left", () => {
    const slip = ayesha();
    expect(slip.daysWorked.toFixed()).toBe("27");
    expect(slip.lines.map((l) => [l.kind, l.code, money(l.amount)])).toEqual([
      ["earning", "basic", "135000.00"],
      ["earning", "medical", "13500.00"],
      ["earning", "commission", "22000.00"],
      ["deduction", "income_tax", "6096.25"],
      ["deduction", "eobi_employee", "407.00"],
      ["deduction", "fixed_deduction", "5000.00"],
      ["employer", "eobi_employer", "2035.00"],
      ["employer", "social_security_employer", "2400.00"],
    ]);
    expect(slip.lines[2].label).toBe("Commission, less 3000.00 owed back");
    // Medical 13,500 is within 10% of the 135,000 basic paid: all of it exempt.
    expect([slip.taxable, slip.annualTaxable, slip.annualTax].map(money)).toEqual(["157000.00", "1807000.00", "72770.00"]);
    expect([slip.earnings, slip.commission, slip.commissionRecovered, slip.tax, slip.eobiEmployee, slip.deductions, slip.net].map(money)).toEqual([
      "148500.00",
      "22000.00",
      "3000.00",
      "6096.25",
      "407.00",
      "5000.00",
      "158996.75",
    ]);
    expect(slip.monthsLeft).toBe(8);
  });

  it("Bilal: joined on the 10th, paid by the day for 15 days, under the tax threshold", () => {
    const slip = bilal();
    expect([slip.daysEmployed, slip.daysWorked.toFixed()]).toEqual([21, "15"]);
    expect([slip.earnings, slip.annualTaxable, slip.tax, slip.employerSocialSecurity, slip.net].map(money)).toEqual(["30000.00", "240000.00", "0.00", "2580.00", "30000.00"]);
  });

  it("Kamran: leaves on the 20th, so the year ends with this month, and was taxed enough before", () => {
    const slip = kamran();
    expect([slip.daysEmployed, slip.daysWorked.toFixed()]).toEqual([20, "20"]);
    expect([slip.earnings, slip.annualTaxable, slip.annualTax, slip.tax, slip.net].map(money)).toEqual(["200000.00", "1400000.00", "28000.00", "0.00", "200000.00"]);
  });

  it("adds up to the run, and the run's journal balances", () => {
    const totals = runTotals([ayesha(), bilal(), kamran()]);
    expect(Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, money(v)]))).toEqual({
      earnings: "378500.00",
      commission: "22000.00",
      tax: "6096.25",
      eobiEmployee: "407.00",
      deductions: "5000.00",
      net: "388996.75",
      employerEobi: "2035.00",
      employerSocialSecurity: "4980.00",
    });
    const journal = approvalJournal(totals);
    expect(journal.map((l) => [l.account, money(l.debit), money(l.credit)])).toEqual([
      ["Salaries and wages", "373500.00", "0.00"],
      ["Employer EOBI and social security", "7015.00", "0.00"],
      ["Commission payable", "22000.00", "0.00"],
      ["Salaries payable", "0.00", "388996.75"],
      ["Income tax withheld payable", "0.00", "6096.25"],
      ["EOBI and social security payable", "0.00", "7422.00"],
    ]);
    const side = (pick: (l: (typeof journal)[number]) => Decimal) => money(journal.reduce((t, l) => t.plus(pick(l)), d(0)));
    expect(side((l) => l.debit)).toBe(side((l) => l.credit));
  });
});

describe("working a payslip out", () => {
  it("pays a full month whole, and the same pay every month of the year carries the same tax", () => {
    const july = worked({ month: "2026-07-01", pay: pay([["basic", 150000]]) });
    expect([july.earnings, july.tax].map(money)).toEqual(["150000.00", "6000.00"]);
    const august = worked({ month: "2026-08-01", pay: pay([["basic", 150000]]), before: { taxable: july.taxable, tax: july.tax, months: 1 } });
    expect(money(august.tax)).toBe("6000.00");
  });

  it("takes months of the tax year before payroll was run here as paid the regular pay and taxed evenly", () => {
    // Employed since July, first run here in November: July to October are four months of 150,000 taxed 6,000 each.
    const slip = worked({ pay: pay([["basic", 150000]]) });
    expect([slip.assumedMonths, money(slip.assumedTaxable), money(slip.assumedTax), money(slip.annualTaxable), money(slip.tax)]).toEqual([4, "600000.00", "24000.00", "1800000.00", "6000.00"]);
    // Only the months not run here: October was, so three are assumed.
    const after = worked({ pay: pay([["basic", 150000]]), before: { taxable: d(150000), tax: d(6000), months: 1 } });
    expect([after.assumedMonths, money(after.tax)]).toEqual([3, "6000.00"]);
    // Nobody is assumed paid before they joined.
    expect(worked({ employee: person({ joinedOn: "2026-10-15" }), pay: pay([["basic", 150000]]) }).assumedMonths).toBe(1);
    expect(worked({ employee: person({ joinedOn: "2026-11-15" }), pay: pay([["basic", 150000]]) }).assumedMonths).toBe(0);
  });

  it("uses the pay in force on the last day of the month, or the last day employed", () => {
    const rows = pay([
      ["basic", 100000],
      ["basic", 120000, "2026-11-15"],
    ]);
    expect(money(worked({ pay: rows }).earnings)).toBe("120000.00");
    expect(money(worked({ pay: rows, employee: person({ leftOn: "2026-11-10" }) }).earnings)).toBe("33333.33");
  });

  it("spreads tax the year's earlier months did not deduct over the months left", () => {
    // A raise from November: 1,800,000 a year becomes 600,000 + 8 x 200,000 = 2,200,000, taxed 116,000; 24,000 deducted already.
    const slip = worked({ pay: pay([["basic", 200000]]), before: { taxable: d(600000), tax: d(24000), months: 4 } });
    expect([slip.annualTaxable, slip.annualTax, slip.tax].map(money)).toEqual(["2200000.00", "116000.00", "11500.00"]);
  });

  it("never takes more than the pay: tax first, then EOBI, then the fixed deduction", () => {
    const slip = worked({
      employee: person({ eobi: true }),
      pay: pay([
        ["basic", 30000],
        ["fixed_deduction", 50000],
      ]),
      attendance: { daysWorked: d(0), unpaidDays: d(29) },
    });
    // One day of 30,000 in a 30-day month is 1,000: EOBI 407, then 593 of the 50,000 deduction.
    expect([slip.earnings, slip.tax, slip.eobiEmployee, slip.deductions, slip.net].map(money)).toEqual(["1000.00", "0.00", "407.00", "593.00", "0.00"]);
    expect(slip.lines.find((l) => l.code === "fixed_deduction")?.label).toBe("Fixed deduction, 593.00 of 50000.00");
  });

  it("refuses rather than guesses", () => {
    const why = (over: Partial<PayslipInput>) => {
      const result = workOutPayslip(input(over));
      return result.ok ? null : result.reason;
    };
    expect(why({ pay: [] })).toBe("has no pay on record for this month.");
    expect(why({ employee: person({ payBasis: "daily" }), pay: [] })).toBe("has no daily wage on record for this month.");
    expect(why({ employee: person({ payBasis: "daily", joinedOn: "2026-11-25" }), pay: pay([["daily_wage", 1000]]), attendance: { daysWorked: d(10), unpaidDays: d(0) } })).toBe(
      "has 10 days worked, more than the 6 days employed in the month.",
    );
    expect(why({ attendance: { daysWorked: d(0), unpaidDays: d(31) } })).toBe("has 31 unpaid days, more than the 30 days employed in the month.");
    expect(why({ slabs: null })).toBe("cannot be taxed: there is no salary tax table in force in this month.");
    expect(why({ slabs: { from: "2026-07-01", slabs: [slab(0, 600000, 0, 0)] } })).toBe("cannot be taxed: the salary tax table in force has a gap.");
    expect(why({ employee: person({ eobi: true }), rates: RATES.filter((r) => r.kind !== "eobi_wage") })).toMatch(/EOBI/);
    expect(why({ employee: person({ socialSecurity: true, province: "balochistan" }) })).toMatch(/social security/);
    expect(why({ employee: person({ joinedOn: "2026-12-01" }) })).toBe("was not employed in this month.");
  });
});
