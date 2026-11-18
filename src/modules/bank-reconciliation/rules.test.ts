import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { autoMatch, readBankAmount, readBankDate, readStatement, reconcile, type BankLine, type BookLine } from "./rules";

// Step 35's rules on their own: reading a bank's file, matching it with the books, and the
// reconciliation adding up.

const d = (value: string | number) => new Decimal(value);
const money = (value: Decimal | null) => (value === null ? null : value.toFixed(2));

describe("a bank's days and amounts", () => {
  it("reads a day however Pakistani banks write it, day first", () => {
    expect(["05/11/2026", "5-11-2026", "05-Nov-2026", "5 November 2026", "05/11/26", "2026-11-05", "05.11.2026", "46331"].map(readBankDate)).toEqual(Array(8).fill("2026-11-05"));
    expect(["31/02/2026", "Nov 5", "", "13/13/2026"].map(readBankDate)).toEqual([null, null, null, null]);
  });

  it("reads an amount with its grouping, its sign and its side", () => {
    expect(["1,234.50", "(1,234.50)", "-1234.5", "1,234.50 Cr", "1,234.50 DR", "Rs 500", "PKR 1,00,000"].map((x) => money(readBankAmount(x) as Decimal))).toEqual([
      "1234.50",
      "-1234.50",
      "-1234.50",
      "1234.50",
      "-1234.50",
      "500.00",
      "100000.00",
    ]);
    expect([readBankAmount(""), readBankAmount("-"), readBankAmount("abc"), readBankAmount("1.23456")]).toEqual([null, null, "bad", "bad"]);
  });
});

const HBL = `Habib Bank Limited
Account,PK36HABB0000001123456702
Period,01-Nov-2026 to 30-Nov-2026

Transaction Date,Value Date,Transaction Details,Cheque No.,Debit,Credit,Balance
01-Nov-2026,,Opening Balance,,,,"100,000.00"
02-Nov-2026,02-Nov-2026,Cash deposit,,,"50,000.00","150,000.00"
03-Nov-2026,03-Nov-2026,Cheque paid,000123,"20,000.00",,"130,000.00"
05-Nov-2026,05-Nov-2026,IBFT RC-2627-00004 Corner Shop,,,"15,000.00","145,000.00"
05-Nov-2026,05-Nov-2026,Bank charges,,250.00,,"144,750.00"
,,Closing Balance,,,,"144,750.00"
`;

describe("reading a statement", () => {
  it("finds the heading under the bank's own lines, and reads each line and the balances", () => {
    const read = readStatement(HBL, "hbl");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.lines.map((l) => [l.row, l.date, l.description, l.reference, money(l.amount), money(l.balance)])).toEqual([
      [7, "2026-11-02", "Cash deposit", null, "50000.00", "150000.00"],
      [8, "2026-11-03", "Cheque paid", "000123", "-20000.00", "130000.00"],
      [9, "2026-11-05", "IBFT RC-2627-00004 Corner Shop", null, "15000.00", "145000.00"],
      [10, "2026-11-05", "Bank charges", null, "-250.00", "144750.00"],
    ]);
    expect([money(read.opening), money(read.closing), read.from, read.to]).toEqual(["100000.00", "144750.00", "2026-11-02", "2026-11-05"]);
    // The same file read automatically reads the same; every line has a fingerprint of its own.
    const auto = readStatement(HBL, "auto");
    expect(auto.ok && auto.lines.map((l) => l.fingerprint)).toEqual(read.lines.map((l) => l.fingerprint));
    expect(new Set(read.lines.map((l) => l.fingerprint)).size).toBe(4);
  });

  it("puts a newest-first file oldest first, and reads one Amount column", () => {
    const csv = "Date,Description,Amount,Balance\n10/11/2026,Second,-500,9500\n09/11/2026,First,2000,10000\n";
    const read = readStatement(csv, "auto");
    expect(read.ok && read.lines.map((l) => [l.date, money(l.amount)])).toEqual([
      ["2026-11-09", "2000.00"],
      ["2026-11-10", "-500.00"],
    ]);
    expect(read.ok && money(read.opening)).toBe("8000.00");
  });

  it("reads columns the company names itself", () => {
    const csv = "Posted,What,Out,In\n01/11/2026,Rent,30000,\n02/11/2026,Sale,,5000\n";
    const read = readStatement(csv, "columns", { date: "Posted", description: "What", out: "Out", in: "In" });
    expect(read.ok && read.lines.map((l) => money(l.amount))).toEqual(["-30000.00", "5000.00"]);
    expect(read.ok && read.opening).toBe(null);
  });

  it("refuses a file read with its columns mixed up, or with lines it cannot read, saying where", () => {
    const swapped = HBL.replace("Debit,Credit", "Credit,Debit");
    const read = readStatement(swapped, "hbl");
    expect(!read.ok && read.problems[0]).toMatch(/^Row 8: the balance does not follow from the line before/);
    const bad = readStatement("Date,Description,Debit,Credit\n32/11/2026,X,100,\n01/11/2026,Y,abc,\n01/11/2026,Z,100,200\n01/11/2026,W,,\n", "auto");
    expect(!bad.ok && bad.problems).toEqual([
      'Row 2: "32/11/2026" is not a day.',
      "Row 3: an amount is not a number.",
      "Row 4: money both in and out on one line.",
      "Row 5: no money in or out.",
    ]);
    expect(readStatement("Name,Value\nA,1\n", "meezan")).toEqual({ ok: false, problems: ["No row of the file has the columns Meezan Bank files have. Choose the bank, or name the columns yourself."] });
  });
});

describe("matching the bank with the books", () => {
  const bank = (id: string, date: string, amount: number, description = "", reference: string | null = null): BankLine => ({ id, date, amount: d(amount), description, reference });
  const book = (id: string, date: string, amount: number, documentNumber: string | null = null, chequeNumber: string | null = null): BookLine => ({ id, date, amount: d(amount), documentNumber, chequeNumber });

  it("matches what the statement names first, then what is alone in its amount and days", () => {
    const pairs = autoMatch(
      [
        bank("s1", "2026-11-03", -20000, "Cheque paid", "000123"),
        bank("s2", "2026-11-05", 15000, "IBFT RC-2627-00004 Corner Shop"),
        bank("s3", "2026-11-04", 50000, "Cash deposit"),
        bank("s4", "2026-11-06", 5000, "Transfer"),
        bank("s5", "2026-11-06", 5000, "Transfer"),
        bank("s6", "2026-11-30", -250, "Bank charges"),
      ],
      [
        book("b1", "2026-11-01", -20000, "SP-2627-00001", "123"),
        book("b2", "2026-11-01", 15000, "RC-2627-00004"),
        book("b3", "2026-11-02", 50000, "TR-2627-00001"),
        // Two entries of 5,000 and two statement lines of 5,000: none is sure, so none is matched.
        book("b4", "2026-11-05", 5000),
        book("b5", "2026-11-05", 5000),
        // A cheque of 15,000 the statement does not name, beside the one it does.
        book("b6", "2026-11-04", 15000, "RC-2627-00005"),
      ],
    );
    expect(pairs).toEqual([
      { statementId: "s1", journalLineId: "b1", rule: "reference" },
      { statementId: "s2", journalLineId: "b2", rule: "reference" },
      { statementId: "s3", journalLineId: "b3", rule: "amount_date" },
    ]);
  });

  it("never matches across amounts, or a bank line from before the entry by more than three days", () => {
    expect(autoMatch([bank("s", "2026-11-01", 100)], [book("b", "2026-11-05", 100)])).toEqual([]);
    expect(autoMatch([bank("s", "2026-11-05", 100)], [book("b", "2026-11-05", 101)])).toEqual([]);
  });
});

describe("the reconciliation", () => {
  const line = (id: string, date: string, amount: number, matchId: string | null = null) => ({ id, date, amount: d(amount), matchId });

  it("acceptance: with everything explained, the books reconciled equal the bank", () => {
    const books = [line("b0", "2026-10-15", 100000), line("b1", "2026-11-02", 50000, "m1"), line("b2", "2026-11-03", -20000, "m2"), line("b3", "2026-11-28", -7000)];
    const bank = [line("s1", "2026-11-02", 50000, "m1"), line("s2", "2026-11-03", -20000, "m2"), line("s3", "2026-11-05", -250)];
    const r = reconcile("2026-11-30", { startsOn: "2026-11-02", opening: d(100000) }, bank, books);
    expect([r.bankBalance, r.bookBalance, r.unmatchedBooks, r.unmatchedBank, r.adjustedBooks, r.difference].map(money)).toEqual([
      "129750.00",
      "123000.00",
      "-7000.00",
      "-250.00",
      "129750.00",
      "0.00",
    ]);
  });

  it("counts a match only when all of it is on or before the day, and says when the start disagreed", () => {
    const books = [line("b1", "2026-11-29", -5000, "m1")];
    const bank = [line("s1", "2026-12-02", -5000, "m1")];
    const november = reconcile("2026-11-30", { startsOn: "2026-11-01", opening: d(1000) }, bank, books);
    expect([november.unmatchedBooks, november.unmatchedBank, november.difference].map(money)).toEqual(["-5000.00", "0.00", "1000.00"]);
    expect(money(november.bankOpening.minus(november.booksAtStart))).toBe("1000.00");
    const december = reconcile("2026-12-31", { startsOn: "2026-11-01", opening: null }, bank, books);
    expect([december.unmatchedBooks, december.difference, december.openingFromBooks].map((v) => (typeof v === "boolean" ? v : money(v)))).toEqual(["0.00", "0.00", true]);
  });
});
