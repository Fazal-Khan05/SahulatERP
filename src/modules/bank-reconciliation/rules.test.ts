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

  it("passes over totals and balances whatever their money columns hold, and reads a same-day newest-first file", () => {
    const csv = "Date,Description,Debit,Credit,Balance\n01/11/2026,Opening balance,,100.00,100.00\n02/11/2026,Sale,,50.00,150.00\n,Total,0.00,50.00,\n";
    const read = readStatement(csv, "auto");
    expect(read.ok && [read.lines.length, money(read.opening)]).toEqual([1, "100.00"]);
    const sameDay = "Date,Description,Debit,Credit,Balance\n05/11/2026,Second,20.00,,130.00\n05/11/2026,First,,50.00,150.00\n";
    const day = readStatement(sameDay, "auto");
    expect(day.ok && day.lines.map((l) => l.description)).toEqual(["First", "Second"]);
    expect(readStatement("Date,Description,Amount\n01/11/2026,IBAN,12345678901234567\n", "auto")).toEqual({ ok: false, problems: ["Row 2: an amount is not a number."] });
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
  const bankLine = (id: string, date: string, amount: number, balance: number | null, matchId: string | null = null) => ({ id, date, amount: d(amount), balance: balance === null ? null : d(balance), matchId });
  const figures = (r: ReturnType<typeof reconcile>) => [r.bankBalance, r.bookBalance, r.unmatchedBooks, r.unmatchedBank, r.adjustedBooks, r.difference].map(money);

  it("acceptance: with everything explained, the books reconciled equal what the bank says", () => {
    const books = [line("b0", "2026-10-15", 100000), line("b1", "2026-11-02", 50000, "m1"), line("b2", "2026-11-03", -20000, "m2"), line("b3", "2026-11-28", -7000)];
    const bank = [bankLine("s1", "2026-11-02", 50000, 150000, "m1"), bankLine("s2", "2026-11-03", -20000, 130000, "m2"), bankLine("s3", "2026-11-05", -250, 129750)];
    const r = reconcile("2026-11-30", { startsOn: "2026-11-02", opening: d(100000) }, bank, books);
    expect(figures(r)).toEqual(["129750.00", "123000.00", "-7000.00", "-250.00", "129750.00", "0.00"]);
    expect([money(r.missingFromStatements), r.bankBalanceGiven]).toEqual(["0.00", true]);
  });

  it("counts a cheque written before the first statement and presented after it as on its way, once matched", () => {
    // Books: 100,000 in, then a 20,000 cheque on 28 October: 80,000. The bank's November statement opens at 100,000.
    const books = [line("b0", "2026-10-01", 100000), line("b1", "2026-10-28", -20000)];
    const bank = [bankLine("s1", "2026-11-03", -20000, 80000)];
    const before = reconcile("2026-11-30", { startsOn: "2026-11-01", opening: d(100000) }, bank, books);
    // Unmatched, the cheque reads as a line the books do not have: 20,000 unexplained.
    expect(money(before.difference)).toBe("20000.00");
    const matched = reconcile("2026-11-30", { startsOn: "2026-11-01", opening: d(100000) }, [{ ...bank[0], matchId: "m" }], [books[0], { ...books[1], matchId: "m" }]);
    expect([money(matched.inTransitAtStart), money(matched.difference)]).toEqual(["-20000.00", "0.00"]);
    // On 31 October, before it was presented, it is still on its way.
    const october = reconcile("2026-10-31", { startsOn: "2026-11-01", opening: d(100000) }, [{ ...bank[0], matchId: "m" }], [books[0], { ...books[1], matchId: "m" }]);
    expect(figures(october)).toEqual(["100000.00", "80000.00", "-20000.00", "0.00", "100000.00", "0.00"]);
  });

  it("shows a statement that is missing: the bank's balance is not what its imported lines add up to", () => {
    // November and January imported, everything in them matched; December's statement never was.
    const books = [line("b1", "2026-11-05", 1000, "m1"), line("b2", "2026-12-10", 7000), line("b3", "2027-01-05", 500, "m3")];
    const bank = [bankLine("s1", "2026-11-05", 1000, 1000, "m1"), bankLine("s3", "2027-01-05", 500, 8500, "m3")];
    const r = reconcile("2027-01-31", { startsOn: "2026-11-01", opening: d(0) }, bank, books);
    expect([money(r.bankBalance), money(r.missingFromStatements), money(r.difference)]).toEqual(["8500.00", "7000.00", "7000.00"]);
  });

  it("works the bank's figure out from its lines when its files give no balance, and says so", () => {
    const books = [line("b1", "2026-11-29", -5000, "m1")];
    const bank = [bankLine("s1", "2026-12-02", -5000, null, "m1")];
    const november = reconcile("2026-11-30", { startsOn: "2026-11-01", opening: null }, bank, books);
    expect([money(november.unmatchedBooks), money(november.unmatchedBank), money(november.difference), november.openingFromBooks, november.bankBalanceGiven]).toEqual(["-5000.00", "0.00", "0.00", true, false]);
    const december = reconcile("2026-12-31", { startsOn: "2026-11-01", opening: null }, bank, books);
    expect([money(december.unmatchedBooks), money(december.difference)]).toEqual(["0.00", "0.00"]);
  });
});
