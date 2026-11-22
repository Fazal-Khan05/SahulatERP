import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { cashFlow, cashFlowTable, flowOf, ownerFigures, type CashFlowEntry } from "./cash-flow";
import type { ReportAccount } from "./rules";

// Step 36's cash-flow statement on its own: where each kind of money goes, and the acceptance:
// the net cash flow is what the cash and bank accounts moved.

const account = (id: string, code: string, type: ReportAccount["type"], controlType: string | null = null, parentId: string | null = null, isGroup = false): ReportAccount => ({
  id,
  parentId,
  code,
  name: id,
  type,
  isGroup,
  controlType,
});
const CHART: ReportAccount[] = [
  account("cash-heading", "1110", "asset", "cash", null, true),
  account("cash", "1111", "asset", "cash", "cash-heading"),
  account("cash-b", "1112", "asset", "cash", "cash-heading"),
  account("bank", "1121", "asset", "bank"),
  account("ar", "1200", "asset", "ar"),
  account("fixed", "1500", "asset", null, null, true),
  account("computers", "1520", "asset", null, "fixed"),
  account("ap", "2110", "liability", "ap"),
  account("output", "2200", "liability", "output_tax"),
  account("wht", "2210", "liability", "wht_income_tax"),
  account("salaries-payable", "2300", "liability", "payroll_payable"),
  account("long-term", "2500", "liability", null, null, true),
  account("loans", "2510", "liability", null, "long-term"),
  account("capital", "3100", "equity"),
  account("opening-equity", "3900", "equity", "opening_equity"),
  account("sales", "4100", "income", "sales"),
  account("other-income", "4200", "income"),
  account("repairs", "5270", "expense"),
];
const d = (value: string | number) => new Decimal(value);
let journalNo = 0;
/** One journal's lines: account and debits less credits. */
const journal = (lines: [string, number][], sourceType = "manual_journal"): CashFlowEntry[] => {
  journalNo += 1;
  return lines.map(([accountId, net]) => ({ journalId: `j${journalNo}`, sourceType, accountId, net: d(net) }));
};
const money = (value: Decimal) => value.toFixed(2);

describe("what money is", () => {
  it("goes by what an account is for, then by where it sits", () => {
    const byId = new Map(CHART.map((a) => [a.id, a]));
    const of = (id: string) => flowOf(byId.get(id)!, byId);
    expect(["ar", "ap", "salaries-payable", "wht", "computers", "loans", "capital", "repairs", "other-income"].map(of)).toEqual([
      "customers",
      "suppliers",
      "staff",
      "taxes",
      "assets",
      "loans",
      "owners",
      "other",
      "other",
    ]);
  });
});

describe("the cash-flow statement", () => {
  it("acceptance: puts every rupee moved down to what it was set against, and adds up to what cash and bank moved", () => {
    const entries = [
      ...journal([["bank", 1000], ["ar", -1000]], "receipt"),
      ...journal([["ap", 400], ["bank", -400]], "supplier_payment"),
      ...journal([["salaries-payable", 300], ["cash", -300]], "payroll_payment"),
      // An expense of 500 paid less 50 tax withheld: 450 out, all of it on the expense.
      ...journal([["repairs", 500], ["bank", -450], ["wht", -50]], "expense"),
      // The tax withheld paid to the government.
      ...journal([["wht", 50], ["bank", -50]]),
      // A cash sale with its sales tax: all of it from the customer.
      ...journal([["cash", 118], ["sales", -100], ["output", -18]]),
      ...journal([["computers", 2000], ["bank", -2000]]),
      ...journal([["bank", 5000], ["loans", -5000]]),
      ...journal([["cash", 1000], ["capital", -1000]]),
      // Cash banked: nothing comes in or goes out.
      ...journal([["bank", 200], ["cash", -200]], "cash_transfer"),
      ...journal([["cash", 700], ["opening-equity", -700]], "opening_balance"),
      // Money in against two kinds at once: each gets its own.
      ...journal([["bank", 300], ["ar", -200], ["other-income", -100]]),
    ];
    const report = cashFlow(CHART, entries, d(1000), d(5918));
    expect(Object.fromEntries(Object.entries(report.flows).map(([k, v]) => [k, money(v)]))).toEqual({
      customers: "1318.00",
      suppliers: "-400.00",
      staff: "-300.00",
      taxes: "-50.00",
      other: "-350.00",
      assets: "-2000.00",
      loans: "5000.00",
      owners: "1000.00",
      opening: "700.00",
    });
    expect([report.operating, report.investing, report.financing, report.net, report.moved].map(money)).toEqual(["218.00", "-2000.00", "6000.00", "4918.00", "4918.00"]);
    // The net change is what the accounts moved: from 1,000 to 5,918.
    expect(report.net.eq(report.closing.minus(report.opening))).toBe(true);
    const table = cashFlowTable(report, { from: "2026-11-01", to: "2026-11-30" }, "Cash flow");
    expect(table.rows.find((row) => row.kind === "grand")?.cells).toEqual(["Net change in cash and bank", report.net]);
    expect(table.notes[0]).toMatch(/^The net change, 4,918.00, is what the cash and bank accounts moved in the period/);
  });

  it("shows an opening balance reversed and entered again as opening balances, not as owners' money", () => {
    const entries = [
      ...journal([["cash", 700], ["opening-equity", -700]], "opening_balance"),
      ...journal([["cash", -700], ["opening-equity", 700]], "reversal:opening_balance"),
      ...journal([["cash", 650], ["opening-equity", -650]], "opening_balance"),
      // A manual correction of the opening cash, against Opening balance equity.
      ...journal([["cash", 50], ["opening-equity", -50]]),
    ];
    const report = cashFlow(CHART, entries, d(0), d(700));
    expect([report.flows.opening, report.flows.owners, report.net].map(money)).toEqual(["700.00", "0.00", "700.00"]);
  });

  it("shares money out to the paisa and beyond, the shares adding up exactly", () => {
    const report = cashFlow(CHART, journal([["bank", 100], ["ar", -1], ["other-income", -1], ["loans", -1]]), d(0), d(100));
    const shares = [report.flows.customers, report.flows.other, report.flows.loans].map((v) => v.toFixed(4));
    expect(shares.sort()).toEqual(["33.3333", "33.3333", "33.3334"]);
    expect(money(report.net)).toBe("100.00");
  });

  it("says so when the net change does not agree with the accounts", () => {
    const report = cashFlow(CHART, journal([["bank", 100], ["ar", -100]]), d(0), d(90));
    expect(cashFlowTable(report, { from: "2026-11-01", to: "2026-11-30" }, "Cash flow").notes[0]).toMatch(/does not agree/);
  });
});

describe("the owner's figures", () => {
  it("are the reports' own: cash at the end and its change, sales, profit, and what is owed each way", () => {
    const t = (before: number, debit: number, credit: number) => ({ before: d(before), debit: d(debit), credit: d(credit) });
    const totals = new Map([
      ["cash", t(1000, 500, 200)],
      ["bank", t(0, 300, 0)],
      ["ar", t(400, 1180, 300)],
      ["ap", t(-250, 100, 600)],
      ["sales", t(-5000, 0, 1000)],
      ["other-income", t(0, 0, 50)],
      ["repairs", t(700, 120, 0)],
      ["cash-heading", t(99, 99, 99)],
    ]);
    const figures = ownerFigures(CHART, totals);
    expect(Object.fromEntries(Object.entries(figures).map(([k, v]) => [k, money(v)]))).toEqual({
      cash: "1600.00",
      cashChange: "600.00",
      sales: "1000.00",
      profit: "930.00",
      receivables: "1280.00",
      payables: "750.00",
    });
  });
});
