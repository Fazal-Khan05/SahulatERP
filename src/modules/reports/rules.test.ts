import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  amountsTree,
  balanceSheet,
  balanceSheetTable,
  filterQuery,
  generalLedgerTable,
  isReportKey,
  profitAndLoss,
  profitAndLossTable,
  readFilter,
  retainedEarnings,
  retainedEarningsStatement,
  runningBalance,
  sidedBalance,
  tableToCsv,
  trialBalance,
  trialBalanceTable,
  type AccountTotal,
  type ReportAccount,
} from "./rules";

const d = (value: string | number) => new Decimal(value);
const account = (id: string, parentId: string | null, code: string, name: string, type: ReportAccount["type"], isGroup = false, controlType: string | null = null): ReportAccount => ({ id, parentId, code, name, type, isGroup, controlType });

// A small chart: the five roots, a heading under two of them, and the accounts a trader uses.
const chart: ReportAccount[] = [
  account("A", null, "1000", "Assets", "asset", true),
  account("CA", "A", "1100", "Current assets", "asset", true),
  account("cash", "CA", "1111", "Cash in hand", "asset"),
  account("ar", "CA", "1200", "Trade receivables", "asset", false, "ar"),
  account("stock", "CA", "1300", "Stock in trade", "asset", false, "inventory"),
  account("van", "A", "1530", "Vehicles", "asset"),
  account("L", null, "2000", "Liabilities", "liability", true),
  account("ap", "L", "2110", "Trade payables", "liability", false, "ap"),
  account("E", null, "3000", "Equity", "equity", true),
  account("capital", "E", "3100", "Owner's capital", "equity"),
  account("re", "E", "3300", "Retained earnings", "equity", false, "retained_earnings"),
  account("I", null, "4000", "Income", "income", true),
  account("sales", "I", "4100", "Sales", "income", false, "sales"),
  account("other", "I", "4200", "Other income", "income"),
  account("X", null, "5000", "Expenses", "expense", true),
  account("cogs", "X", "5100", "Cost of goods sold", "expense", false, "cogs"),
  account("OX", "X", "5200", "Operating expenses", "expense", true),
  account("rent", "OX", "5230", "Rent", "expense"),
  account("unused", "OX", "5240", "Electricity, gas and water", "expense"),
];
const total = (before: string, debit: string, credit: string): AccountTotal => ({ before: d(before), debit: d(debit), credit: d(credit) });

// Before the period: capital 500,000 in cash, a van bought for 300,000, and last year's trading
// (sales 200,000 on credit, cost 120,000 out of stock bought on credit for 150,000, rent 30,000).
// In the period: sales 80,000 (50,000 cash), cost 48,000, rent 10,000, 1,500 other income, a
// supplier paid 60,000.
const totals = new Map<string, AccountTotal>([
  ["cash", total("170000", "51500", "70000")],
  ["ar", total("200000", "30000", "0")],
  ["stock", total("30000", "0", "48000")],
  ["van", total("300000", "0", "0")],
  ["ap", total("-150000", "60000", "0")],
  ["capital", total("-500000", "0", "0")],
  ["sales", total("-200000", "0", "80000")],
  ["other", total("0", "0", "1500")],
  ["cogs", total("120000", "48000", "0")],
  ["rent", total("30000", "10000", "0")],
]);
const show = (rows: { code: string; depth: number; amount: Decimal }[]) => rows.map((row) => `${"  ".repeat(row.depth)}${row.code} ${row.amount.toFixed(2)}`);

describe("the trial balance", () => {
  it("lists every account that stood at something or moved, and its totals agree", () => {
    const report = trialBalance(chart, totals);
    expect(report.rows.map((row) => `${row.code} ${row.opening.toFixed(0)} ${row.debit.toFixed(0)} ${row.credit.toFixed(0)} ${row.closing.toFixed(0)}`)).toEqual([
      "1111 170000 51500 70000 151500",
      "1200 200000 30000 0 230000",
      "1300 30000 0 48000 -18000",
      "1530 300000 0 0 300000",
      "2110 -150000 60000 0 -90000",
      "3100 -500000 0 0 -500000",
      "4100 -200000 0 80000 -280000",
      "4200 0 0 1500 -1500",
      "5100 120000 48000 0 168000",
      "5230 30000 10000 0 40000",
    ]);
    const t = report.totals;
    expect([t.openingDebit, t.openingCredit, t.debit, t.credit, t.closingDebit, t.closingCredit].map((v) => v.toFixed(0))).toEqual(["850000", "850000", "199500", "199500", "889500", "889500"]);
    // Headings and accounts with nothing on them are left out.
    expect(report.rows.find((row) => row.code === "5240" || row.code === "1000")).toBeUndefined();
    expect(trialBalance(chart, new Map()).rows).toEqual([]);
  });

  it("is laid out with a debit and a credit column for each of opening, movement and closing", () => {
    const table = trialBalanceTable(trialBalance(chart, totals), { from: "2026-07-01", to: "2026-07-31" });
    expect(table.period).toBe("01-07-2026 to 31-07-2026");
    expect(table.columns.map((c) => c.label)).toEqual(["Code", "Account", "Opening debit", "Opening credit", "Debits", "Credits", "Closing debit", "Closing credit"]);
    const cells = (row: (typeof table.rows)[number]) => row.cells.map((cell) => (cell === null ? "" : typeof cell === "string" ? cell : cell.toFixed(0)));
    // Stock closed in credit (more sold than the books held): it moves to the credit column.
    expect(cells(table.rows[2])).toEqual(["1300", "Stock in trade", "30000", "", "", "48000", "", "18000"]);
    expect(cells(table.rows.at(-1)!)).toEqual(["", "Total", "850000", "850000", "199500", "199500", "889500", "889500"]);
    expect(table.rows.at(-1)!.kind).toBe("grand");
    expect(table.notes).toEqual([]);
    // Books that do not balance say so.
    const broken = trialBalanceTable(trialBalance(chart, new Map([["cash", total("0", "5", "0")]])), { from: "2026-07-01", to: "2026-07-31" });
    expect(broken.notes[0]).toContain("The totals do not agree.");
  });
});

describe("the chart with amounts", () => {
  it("rolls every amount up into its headings and leaves out what comes to nothing", () => {
    const tree = amountsTree(chart, ["asset"], (a) => totals.get(a.id)?.before ?? d(0));
    expect(show(tree)).toEqual(["1000 700000.00", "  1100 400000.00", "    1111 170000.00", "    1200 200000.00", "    1300 30000.00", "  1530 300000.00"]);
    expect(amountsTree(chart, ["expense"], (a) => (a.id === "rent" ? d(7) : d(0))).map((row) => row.code)).toEqual(["5000", "5200", "5230"]);
    expect(amountsTree(chart, ["liability"], () => d(0))).toEqual([]);
    // A heading whose accounts cancel out is still shown, with its accounts, at nil.
    expect(show(amountsTree(chart, ["income"], (a) => (a.id === "sales" ? d(5) : d(-5))))).toEqual(["4000 0.00", "  4100 5.00", "  4200 -5.00"]);
  });
});

describe("profit and loss", () => {
  it("is the period's income less its expenses", () => {
    const report = profitAndLoss(chart, totals);
    expect(show(report.income)).toEqual(["4000 81500.00", "  4100 80000.00", "  4200 1500.00"]);
    expect(show(report.expenses)).toEqual(["5000 58000.00", "  5100 48000.00", "  5200 10000.00", "    5230 10000.00"]);
    expect([report.totalIncome, report.totalExpenses, report.netProfit, report.sales, report.costOfGoodsSold, report.grossProfit].map((v) => v.toFixed(0))).toEqual(["81500", "58000", "23500", "80000", "48000", "32000"]);
    const table = profitAndLossTable(report, { from: "2026-07-01", to: "2026-07-31" });
    expect(table.rows.map((row) => `${row.kind}|${row.cells[0]}|${row.cells[1] === null ? "" : (row.cells[1] as Decimal).toFixed(0)}`)).toEqual([
      "heading|Income|",
      "line|4100 Sales|80000",
      "line|4200 Other income|1500",
      "total|Total income|81500",
      "heading|Expenses|",
      "line|5100 Cost of goods sold|48000",
      "total|5200 Operating expenses|10000",
      "line|5230 Rent|10000",
      "total|Total expenses|58000",
      "grand|Net profit|23500",
    ]);
    expect(table.notes).toEqual(["Gross profit, counting only the Sales account and the Cost of goods sold account: 80,000.00 less 48,000.00 is 32,000.00. Other income, returns and stock adjustments kept in other accounts are not part of it."]);
  });

  it("calls a loss a loss, and shows an empty period as nil", () => {
    const loss = profitAndLossTable(profitAndLoss(chart, new Map([["rent", total("0", "100", "0")]])), { from: "2026-07-01", to: "2026-07-31" });
    expect(loss.rows.at(-1)!.cells[0]).toBe("Net loss");
    expect((loss.rows.at(-1)!.cells[1] as Decimal).toFixed(0)).toBe("-100");
    const empty = profitAndLossTable(profitAndLoss(chart, new Map()), { from: "2026-07-01", to: "2026-07-31" });
    expect(empty.rows.map((row) => row.cells[0])).toEqual(["Income", "Total income", "Expenses", "Total expenses", "Net profit"]);
    expect(empty.notes).toEqual([]);
  });
});

describe("the balance sheet", () => {
  it("balances: assets equal liabilities plus equity, with profit shown under equity", () => {
    const report = balanceSheet(chart, totals);
    expect(show(report.assets)).toEqual(["1000 663500.00", "  1100 363500.00", "    1111 151500.00", "    1200 230000.00", "    1300 -18000.00", "  1530 300000.00"]);
    expect(show(report.liabilities)).toEqual(["2000 90000.00", "  2110 90000.00"]);
    expect(show(report.equity)).toEqual(["3000 500000.00", "  3100 500000.00"]);
    // Last year's profit (200,000 less 120,000 less 30,000) and this year's so far.
    expect([report.earlierProfit, report.profitThisYear, report.totalAssets, report.totalLiabilities, report.totalEquity, report.difference].map((v) => v.toFixed(0))).toEqual(["50000", "23500", "663500", "90000", "573500", "0"]);
    const table = balanceSheetTable(report, "2026-07-31");
    expect(table.period).toBe("As at the end of 31-07-2026");
    expect(table.rows.filter((row) => row.kind !== "line" || row.depth === 1).map((row) => `${row.cells[0]}|${row.cells[1] === null ? "" : (row.cells[1] as Decimal).toFixed(0)}`)).toEqual([
      "Assets|",
      "1100 Current assets|363500",
      "1530 Vehicles|300000",
      "Total assets|663500",
      "Liabilities|",
      "2110 Trade payables|90000",
      "Total liabilities|90000",
      "Equity|",
      "3100 Owner's capital|500000",
      "Profit of earlier years, not yet moved to retained earnings|50000",
      "Profit for this fiscal year so far|23500",
      "Total equity|573500",
      "Total liabilities and equity|663500",
    ]);
    expect(table.notes).toEqual([]);
  });

  it("says so when it does not balance, and names a loss", () => {
    const table = balanceSheetTable(balanceSheet(chart, new Map([["cash", total("0", "5", "0")], ["rent", total("0", "100", "0")], ["capital", total("0", "0", "100")]])), "2026-07-31");
    expect(table.notes[0]).toContain("differ by 5.00");
    expect(table.rows.map((row) => row.cells[0])).toContain("Loss for this fiscal year so far");
    expect(table.rows.map((row) => row.cells[0])).not.toContain("Profit of earlier years, not yet moved to retained earnings");
  });

  it("has the period's profit equal the change in what the owners have earned", () => {
    // The same books, cut at the start of the period and at its end.
    const atStart = new Map([...totals].map(([id, t]): [string, AccountTotal] => [id, { before: t.before, debit: d(0), credit: d(0) }]));
    const earnedBefore = retainedEarnings(chart, atStart);
    const earnedAfter = retainedEarnings(chart, totals);
    expect([earnedBefore.toFixed(0), earnedAfter.toFixed(0)]).toEqual(["50000", "73500"]);
    expect(earnedAfter.minus(earnedBefore).eq(profitAndLoss(chart, totals).netProfit)).toBe(true);
    // A closing entry that moves last year's profit into retained earnings changes neither figure.
    const closed = new Map(totals);
    closed.set("re", total("-50000", "0", "0"));
    closed.set("sales", total("0", "0", "80000"));
    closed.set("cogs", total("0", "48000", "0"));
    closed.set("rent", total("0", "10000", "0"));
    expect(retainedEarnings(chart, closed).toFixed(0)).toBe("73500");
    expect(balanceSheet(chart, closed).difference.isZero()).toBe(true);
    expect(balanceSheet(chart, closed).earlierProfit.isZero()).toBe(true);
  });

  it("accounts for what is posted straight to retained earnings", () => {
    // Old books brought in with 1,000,000 of earlier profit already in retained earnings, and a
    // dividend of 40,000 paid out of it in the period.
    const brought = new Map(totals);
    brought.set("re", total("0", "40000", "1000000"));
    brought.set("cash", total("170000", "1051500", "110000"));
    const statement = retainedEarningsStatement(chart, brought);
    expect([statement.opening, statement.netProfit, statement.direct, statement.closing].map((v) => v.toFixed(0))).toEqual(["50000", "23500", "960000", "1033500"]);
    // Opening plus profit plus what was posted directly is the closing figure: so the profit is
    // the change in retained earnings less the direct postings.
    expect(statement.opening.plus(statement.netProfit).plus(statement.direct).eq(statement.closing)).toBe(true);
    expect(balanceSheet(chart, brought).difference.isZero()).toBe(true);
    // With nothing posted directly, the profit is the whole change.
    const plain = retainedEarningsStatement(chart, totals);
    expect([plain.direct.toFixed(0), plain.closing.minus(plain.opening).toFixed(0)]).toEqual(["0", "23500"]);
  });
});

describe("the general ledger", () => {
  const entries = [
    { date: "2026-07-02", reference: "JV-2627-00001", description: "Shop rent", debit: d("40000"), credit: d(0) },
    { date: "2026-07-10", reference: "Reversal of JV-2627-00001", description: "Entered twice", debit: d(0), credit: d("40000") },
    { date: "2026-07-15", reference: "JV-2627-00002", description: "", debit: d(0), credit: d("1250.5") },
  ];

  it("keeps a running balance from the opening balance", () => {
    const ledger = runningBalance(d("1000"), entries);
    expect(ledger.lines.map((line) => line.balance.toFixed(2))).toEqual(["41000.00", "1000.00", "-250.50"]);
    expect([ledger.debit.toFixed(2), ledger.credit.toFixed(2), ledger.closing.toFixed(2)]).toEqual(["40000.00", "41250.50", "-250.50"]);
    expect(runningBalance(d("7"), [])).toMatchObject({ lines: [], closing: d("7") });
    expect([sidedBalance(d("41000")), sidedBalance(d("-250.5")), sidedBalance(d(0)), sidedBalance(d("0.0025"))]).toEqual(["41,000.00 Dr", "250.50 Cr", "Nil", "0.0025 Dr"]);
  });

  it("is laid out with an opening line, each entry and a closing line", () => {
    const table = generalLedgerTable({ code: "5230", name: "Rent" }, d("1000"), runningBalance(d("1000"), entries), { from: "2026-07-01", to: "2026-07-31" }, false);
    expect(table.title).toBe("General ledger: 5230 Rent");
    expect(table.rows.map((row) => `${row.cells[0]}|${row.cells[1]}|${row.cells[2]}|${row.cells[5]}`)).toEqual([
      "||Opening balance|1,000.00 Dr",
      "02-07-2026|JV-2627-00001|Shop rent|41,000.00 Dr",
      "10-07-2026|Reversal of JV-2627-00001|Entered twice|1,000.00 Dr",
      "15-07-2026|JV-2627-00002||250.50 Cr",
      "||Closing balance|250.50 Cr",
    ]);
    expect(generalLedgerTable({ code: "5230", name: "Rent" }, d(0), runningBalance(d(0), entries), { from: "2026-07-01", to: "2026-07-31" }, true).notes[0]).toContain("more entries in the period than one page shows. Choose a shorter period, or download the file");
  });
});

describe("what a report was asked for", () => {
  const defaults = { yearStart: "2026-07-01", today: "2026-11-13" };

  it("falls back to the fiscal year so far, and puts a backwards period right", () => {
    expect(readFilter({}, defaults)).toEqual({ from: "2026-07-01", to: "2026-11-13", branchId: null, accountId: null });
    expect(readFilter({ from: "2026-08-01", to: "2026-08-31" }, defaults)).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    expect(readFilter({ from: "2026-09-30", to: "2026-09-01" }, defaults)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(readFilter({ from: "31-08-2026", to: "soon" }, defaults)).toMatchObject({ from: "2026-07-01", to: "2026-11-13" });
    // A day that was asked for is never moved. The balance sheet gives only the day it is for:
    // last year's closing day stays last year's closing day.
    expect(readFilter({ to: "2026-06-30" }, defaults)).toMatchObject({ from: "2026-06-30", to: "2026-06-30" });
    expect(readFilter({ to: "2026-09-30" }, defaults)).toMatchObject({ from: "2026-07-01", to: "2026-09-30" });
    expect(readFilter({ from: "2027-01-01" }, defaults)).toMatchObject({ from: "2027-01-01", to: "2027-01-01" });
    expect(readFilter({ from: "2026-08-01" }, defaults)).toMatchObject({ from: "2026-08-01", to: "2026-11-13" });
    // An address can carry a value twice; the first is used. Ids are checked to be ids.
    const id = "0b0e7a52-9c1d-4a53-8a51-2f4c8d1e9a10";
    expect(readFilter({ from: ["2026-08-01", "2026-01-01"], branch: id.toUpperCase(), account: "1 or 1=1" }, defaults)).toMatchObject({ from: "2026-08-01", branchId: id, accountId: null });
    expect(filterQuery({ from: "2026-08-01", to: "2026-08-31", branchId: id, accountId: null }, { format: "csv" })).toBe(`from=2026-08-01&to=2026-08-31&branch=${id}&format=csv`);
  });

  it("knows the four reports", () => {
    for (const key of ["trial-balance", "general-ledger", "balance-sheet", "profit-and-loss"]) expect(isReportKey(key)).toBe(true);
    for (const not of ["cash-flow", "", null, "constructor"]) expect(isReportKey(not), String(not)).toBe(false);
  });
});

describe("a report as a CSV file", () => {
  it("writes plain numbers, quotes what needs it, and defuses anything a spreadsheet would run", () => {
    const csv = tableToCsv(
      {
        title: "Trial balance",
        period: "01-07-2026 to 31-07-2026",
        columns: [
          { label: "Account", numeric: false },
          { label: "Amount", numeric: true },
        ],
        rows: [
          { kind: "line", depth: 0, cells: ['Rent, "shop"', d("1234567.891")] },
          { kind: "line", depth: 0, cells: ["=HYPERLINK(1)", d("-5")] },
          { kind: "line", depth: 0, cells: ["-Evil Co", d("0.005")] },
          { kind: "line", depth: 0, cells: ["Exact", d("0.1234")] },
          { kind: "grand", depth: 0, cells: ["Total", null] },
        ],
        notes: ["A note"],
      },
      "Karachi Bike Parts",
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\r\n")).toEqual(["Karachi Bike Parts", "Trial balance", "01-07-2026 to 31-07-2026", "", "Account,Amount", '"Rent, ""shop""",1234567.891', "'=HYPERLINK(1),-5.00", "'-Evil Co,0.005", "Exact,0.1234", "Total,", "A note", ""]);
  });
});
