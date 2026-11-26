import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { checkSheet, groupByDay, matchAccount, readDailyExpense, readRange, readSheetCells, toExpense, type SheetCells } from "./rules";

const TODAY = "2026-11-26";
const whatForId = "11111111-1111-4111-8111-111111111111";
const paidFromId = "22222222-2222-4222-8222-222222222222";
const good = { date: TODAY, whatForId, amount: "1,250.50", paidFromId };
const reason = (raw: object) => {
  const read = readDailyExpense({ ...good, ...raw }, TODAY);
  return read.ok ? null : read.reason;
};

describe("a daily expense as typed", () => {
  it("needs only the day, what it was for, the amount and the account it was paid from", () => {
    const read = readDailyExpense(good, TODAY);
    expect(read.ok && { ...read.expense, amount: read.expense.amount.toFixed(2) }).toEqual({ date: TODAY, whatForId, amount: "1250.50", paidFromId, paidTo: null, note: null, branchId: null });
  });

  it("says the first thing that is wrong, in plain words", () => {
    expect(reason({ date: "" })).toBe("Enter the date.");
    expect(reason({ date: "2026-11-27" })).toBe("That date has not come yet.");
    expect(reason({ whatForId: " " })).toBe("Choose what it was for.");
    expect(reason({ amount: "0" })).toBe("Enter an amount above nothing.");
    expect(reason({ amount: "12.345" })).toBe("Enter the amount in rupees, such as 5000 or 1250.50.");
    expect(reason({ amount: "-5" })).toBe("Enter the amount in rupees, such as 5000 or 1250.50.");
    expect(reason({ paidFromId: "" })).toBe("Choose the cash or bank account it was paid from.");
    expect(reason({ paidTo: "A" })).toBe("Who was paid: from 2 to 120 characters, or leave it empty.");
    expect(reason({ note: "x" })).toBe("The note: use at least 2 characters, or leave it empty.");
    expect(reason({ note: "n".repeat(201) })).toBe("The note: use at most 200 characters.");
    expect(reason({ paidTo: "  Tea   stall ", note: " Tea for   the office " })).toBeNull();
  });

  it("becomes an expense of one line, described by its note or else by its account, with nothing withheld", () => {
    const read = readDailyExpense({ ...good, paidTo: " Tea  stall ", note: "Tea for the office", branchId: "b" }, TODAY);
    if (!read.ok) throw new Error(read.reason);
    const expense = toExpense(read.expense, "Entertainment");
    expect({ ...expense, lines: expense.lines.map((l) => ({ ...l, amount: l.amount.toFixed(2) })) }).toEqual({
      date: TODAY, accountId: paidFromId, supplierId: null, payee: "Tea stall", branchId: "b", reference: null, memo: null, incomeTaxCode: null, provincialTaxCode: null,
      lines: [{ accountId: whatForId, description: "Tea for the office", amount: "1250.50" }],
    });
    const plain = readDailyExpense(good, TODAY);
    expect(plain.ok && toExpense(plain.expense, "Entertainment").lines[0].description).toBe("Entertainment");
    expect(plain.ok && toExpense(plain.expense, "Entertainment").payee).toBeNull();
  });
});

describe("the days the list covers", () => {
  it("is the thirty days up to today unless others are asked for", () => {
    expect(readRange(undefined, undefined, TODAY)).toEqual({ from: "2026-10-28", to: TODAY, asked: false });
    expect(readRange("2026-11-01", "2026-11-10", TODAY)).toEqual({ from: "2026-11-01", to: "2026-11-10", asked: true });
  });

  it("never reaches past today, puts the two days the right way round, and shows a year at most", () => {
    expect(readRange("2026-11-20", "2027-01-01", TODAY)).toEqual({ from: "2026-11-20", to: TODAY, asked: true });
    expect(readRange("2026-12-25", undefined, TODAY)).toEqual({ from: TODAY, to: TODAY, asked: true });
    expect(readRange("2026-11-10", "2026-11-01", TODAY)).toEqual({ from: "2026-11-01", to: "2026-11-10", asked: true });
    expect(readRange("2020-01-01", "2026-11-10", TODAY)).toEqual({ from: "2025-11-10", to: "2026-11-10", asked: true });
    expect(readRange("yesterday", "2026-02-30", TODAY)).toEqual({ from: "2026-10-28", to: TODAY, asked: false });
  });
});

describe("the list, day by day", () => {
  it("puts each expense under its day, and counts a day's total without the cancelled ones", () => {
    const row = (date: string, total: string, status: "posted" | "cancelled" = "posted") => ({ date, total: new Decimal(total), status });
    const days = groupByDay([row("2026-11-26", "500"), row("2026-11-26", "120.50"), row("2026-11-25", "900", "cancelled"), row("2026-11-25", "75"), row("2026-11-20", "10")]);
    expect(days.map((d) => `${d.date} ${d.total.toFixed(2)} ${d.count}/${d.rows.length}`)).toEqual(["2026-11-26 620.50 2/2", "2026-11-25 75.00 1/2", "2026-11-20 10.00 1/1"]);
    expect(groupByDay([])).toEqual([]);
  });
});

const accounts = {
  expense: [
    { id: "e1", code: "5210", name: "Rent" },
    { id: "e2", code: "5220", name: "Fuel and travel" },
    { id: "e3", code: "5230", name: "Repairs" },
    { id: "e4", code: "5231", name: "Repairs" },
  ],
  money: [
    { id: "m1", code: "1111", name: "Cash in hand" },
    { id: "m2", code: "1121", name: "HBL current account" },
  ],
};
const cells = (over: Partial<SheetCells> = {}): SheetCells => ({ row: 2, date: "25/11/2026", whatFor: "Rent", amount: "45,000", paidFrom: "HBL current account", paidTo: "", note: "", ...over });

describe("a sheet of expenses", () => {
  it("finds the columns by their headings, in any order, and skips empty rows", () => {
    const read = readSheetCells([
      [""],
      ["paid from", " AMOUNT ", "What  for", "Date", "Note"],
      ["Cash in hand", "500", "Fuel and travel", "2026-11-25", " Petrol  for the van "],
      ["", "", "", "", ""],
      ["Cash in hand", "120.5", "Rent", "24/11/2026"],
    ]);
    expect(read).toEqual({
      ok: true,
      cells: [
        { row: 3, date: "2026-11-25", whatFor: "Fuel and travel", amount: "500", paidFrom: "Cash in hand", paidTo: "", note: "Petrol for the van" },
        { row: 5, date: "24/11/2026", whatFor: "Rent", amount: "120.5", paidFrom: "Cash in hand", paidTo: "", note: "" },
      ],
    });
  });

  it("says when the file is not such a sheet", () => {
    expect(readSheetCells([])).toEqual({ ok: false, reason: "The file is empty." });
    expect(readSheetCells([["Date", "Amount", "What for"]])).toMatchObject({ ok: false, reason: expect.stringContaining("The first row must name the columns: Date, What for, Amount, Paid from, Paid to, Note.") });
    expect(readSheetCells([["Date", "What for", "Amount", "Paid from"]])).toEqual({ ok: false, reason: "The sheet has its headings and no expenses under them." });
    const many = [["Date", "What for", "Amount", "Paid from"], ...Array.from({ length: 201 }, () => ["25/11/2026", "Rent", "1", "Cash in hand"])];
    expect(readSheetCells(many)).toEqual({ ok: false, reason: "The sheet has 201 expenses. Enter at most 200 at a time." });
  });

  it("matches an account by its name, its code, or both, whatever the capitals and spaces", () => {
    expect(matchAccount(" fuel AND  travel ", accounts.expense)).toMatchObject({ id: "e2" });
    expect(matchAccount("5220", accounts.expense)).toMatchObject({ id: "e2" });
    expect(matchAccount("5231 Repairs", accounts.expense)).toMatchObject({ id: "e4" });
    expect(matchAccount("Repairs", accounts.expense)).toBe("several");
    expect(matchAccount("Tea", accounts.expense)).toBe("none");
  });

  it("turns a good row into the entry it makes", () => {
    const [row] = checkSheet([cells({ paidTo: "Landlord", note: "November" })], accounts, TODAY, "branch-1");
    expect(row.problems).toEqual([]);
    expect({ ...row.expense, amount: row.expense?.amount.toFixed(2) }).toEqual({ date: "2026-11-25", whatForId: "e1", amount: "45000.00", paidFromId: "m2", paidTo: "Landlord", note: "November", branchId: "branch-1" });
    expect([row.whatForName, row.paidFromName]).toEqual(["Rent", "HBL current account"]);
    // A day as Excel keeps it, and an amount with its paisa.
    expect(checkSheet([cells({ date: "2026-11-05", amount: "1250.5" })], accounts, TODAY, null)[0].expense?.amount.toFixed(2)).toBe("1250.50");
  });

  it("says everything that is wrong with a row, so the sheet is put right in one go", () => {
    const problems = (over: Partial<SheetCells>) => checkSheet([cells(over)], accounts, TODAY, null)[0].problems;
    expect(problems({ date: "", whatFor: "", amount: "", paidFrom: "" })).toEqual(["The date is missing.", "What it was for is missing.", "The amount is missing.", "The cash or bank account it was paid from is missing."]);
    expect(problems({ date: "soon" })).toEqual(['"soon" is not a date. Write it as 26/11/2026 or 2026-11-26.']);
    expect(problems({ date: "27/11/2026" })).toEqual(["That date has not come yet."]);
    expect(problems({ whatFor: "Tea" })).toEqual(['No expense account is called "Tea". Use a name from the list on this page.']);
    expect(problems({ whatFor: "Repairs" })).toEqual(['More than one expense account is called "Repairs". Write its code instead.']);
    expect(problems({ paidFrom: "Meezan" })).toEqual(['No cash or bank account is called "Meezan". Use a name from the list on this page.']);
    for (const amount of ["0", "-500", "(500)", "12.345", "five hundred"]) expect(problems({ amount }), amount).toEqual([`"${amount}" is not an amount. Write rupees above nothing, such as 500 or 1,250.50.`]);
    expect(problems({ paidTo: "A", note: "n".repeat(201) })).toEqual(["Who was paid: from 2 to 120 characters, or leave it empty.", "The note: use at most 200 characters."]);
    expect(checkSheet([cells({ whatFor: "Tea" })], accounts, TODAY, null)[0].expense).toBeNull();
  });
});
