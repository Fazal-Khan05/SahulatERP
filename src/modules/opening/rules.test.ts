import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { CONTROL_TYPES } from "@/modules/ledger/rules";
import { AGE_BANDS, OPENING_BLOCKED_CONTROLS, accountLineRefusal, ageBand, ageOpenItems, dateOrderUnproven, daysBetween, openingJournal, readAccountImport, readAmounts, readDate, readDocument, readPartyImport, type StoredLine } from "./rules";

const d = (value: string) => new Decimal(value);
const OPENING = "2026-07-01";

describe("opening balances as typed", () => {
  it("reads a date written the way people write it, day first", () => {
    expect([readDate("2026-06-30"), readDate("30-06-2026"), readDate("30/06/2026"), readDate("1.7.2026"), readDate(" 05-06-2026 ")]).toEqual(["2026-06-30", "2026-06-30", "2026-06-30", "2026-07-01", "2026-06-05"]);
    // Never guessed at: a month-first date, a day that does not exist, two-digit years, words.
    for (const bad of ["06/30/2026", "31-02-2026", "30-06-26", "June 30", "", null, 20260630]) expect(readDate(bad), String(bad)).toBeNull();
  });

  it("reads an account's balance as a debit or a credit", () => {
    const read = readAmounts({ debit: "125000.50", credit: "" });
    expect(read.ok && [read.debit.toFixed(2), read.credit.toFixed(2)]).toEqual(["125000.50", "0.00"]);
    expect(readAmounts({ credit: "0.0001" }).ok).toBe(true);
    expect(readAmounts({ debit: "", credit: "" })).toEqual({ ok: false, reason: "Enter a debit or a credit. An account with no balance needs no line." });
    expect(readAmounts({ debit: "5", credit: "5" })).toEqual({ ok: false, reason: "Enter a debit or a credit, not both: the balance the account stood at." });
    expect(readAmounts({ debit: "1,25,000" })).toMatchObject({ ok: false });
    expect(readAmounts({ credit: "-5" })).toMatchObject({ ok: false });
  });

  it("reads an unpaid invoice: its number, its original date, its due date and what is unpaid", () => {
    const read = readDocument({ documentNumber: " SI-0412 ", documentDate: "05-03-2026", dueDate: "04/04/2026", amount: "84500" }, "receivable", OPENING);
    expect(read.ok && { ...read.document, amount: read.document.amount.toFixed(2) }).toEqual({ documentNumber: "SI-0412", documentDate: "2026-03-05", dueDate: "2026-04-04", amount: "84500.00" });
    expect(readDocument({ documentNumber: "B-1", documentDate: "2026-06-30", amount: "1" }, "payable", OPENING)).toMatchObject({ ok: true, document: { dueDate: null } });
    const bad = (raw: Parameters<typeof readDocument>[0], kind: "receivable" | "payable" = "receivable") => {
      const result = readDocument(raw, kind, OPENING);
      return result.ok ? null : result.reason;
    };
    expect(bad({ documentDate: "2026-06-30", amount: "1" })).toBe("Enter the invoice's number.");
    expect(bad({ documentNumber: "x".repeat(41), documentDate: "2026-06-30", amount: "1" })).toBe("The invoice's number: use at most 40 characters.");
    expect(bad({ documentNumber: "B-1", documentDate: "30 June", amount: "1" }, "payable")).toBe("Enter the bill's date, such as 30-06-2026.");
    // An invoice dated on or after the opening date is not an opening balance.
    expect(bad({ documentNumber: "S-1", documentDate: "2026-07-01", amount: "1" })).toBe("The invoice's date must be before the opening date. One dated on or after it is entered as an ordinary invoice.");
    expect(bad({ documentNumber: "S-1", documentDate: "2026-06-30", dueDate: "2026-06-29", amount: "1" })).toBe("The due date cannot be before the invoice's date.");
    expect(bad({ documentNumber: "S-1", documentDate: "2026-06-30", dueDate: "soon", amount: "1" })).toBe("Enter the due date as a date, such as 30-07-2026, or leave it empty.");
    expect(bad({ documentNumber: "S-1", documentDate: "2026-06-30", amount: "0" })).toBe("Amount unpaid: it must be more than zero. A paid invoice is left out.");
    expect(bad({ documentNumber: "S-1", documentDate: "2026-06-30", amount: "" })).toBe("Amount unpaid: Enter the amount.");
  });

  it("says which accounts cannot have a line of their own, and why", () => {
    expect(accountLineRefusal(null)).toBeNull();
    for (const open of ["bank", "cash", "retained_earnings", "sales", "input_tax", "wht_income_tax"]) expect(accountLineRefusal(open), open).toBeNull();
    expect(accountLineRefusal("ar")).toContain("customer by customer");
    expect(accountLineRefusal("ap")).toContain("supplier by supplier");
    expect(accountLineRefusal("inventory")).toContain("item by item");
    expect(accountLineRefusal("opening_equity")).toContain("balancing account");
    // Everything the database closes to the opening journal is refused here first, in words.
    for (const control of OPENING_BLOCKED_CONTROLS) {
      expect(Object.keys(CONTROL_TYPES)).toContain(control);
      expect(accountLineRefusal(control), control).not.toBeNull();
    }
  });
});

describe("opening balance files", () => {
  const account = (id: string, code: string, name: string, refusal: string | null = null) => ({ id, code, name, refusal });
  const accounts = {
    byCode: new Map([["1111", account("cash", "1111", "Cash in hand")], ["3100", account("capital", "3100", "Owner's capital")], ["1200", account("ar", "1200", "Trade receivables", "is entered customer by customer.")], ["BR-1", account("br", "BR-1", "Branch float")]]),
    byName: new Map([["cash in hand", account("cash", "1111", "Cash in hand")], ["owner's capital", account("capital", "3100", "Owner's capital")]]),
  };

  it("reads a trial balance by account code, skipping accounts that stand at nil", () => {
    const read = readAccountImport("Account code,Account name,Debit,Credit\n1111,CASH IN HAND,50000,\n5230,Rent,0,0.00\n,Owner's capital,,50000\nbr-1,,12.5,\n", accounts);
    expect(read.status === "read" && read.problems).toEqual([]);
    expect(read.status === "read" && read.lines.map((l) => `${l.row} ${l.line.accountId} ${l.line.debit.toFixed(2)} ${l.line.credit.toFixed(2)}`)).toEqual(["2 cash 50000.00 0.00", "4 capital 0.00 50000.00", "5 br 12.50 0.00"]);
  });

  it("lists every bad row of a trial balance with what is wrong", () => {
    const read = readAccountImport("Account code,Debit,Credit\n1111,50000,\n9999,10,\n1200,700,\n1111,,20\n3100,5,5\n,7,\n1111,1,,stray\n", accounts);
    expect(read.status === "read" && read.lines.map((l) => l.row)).toEqual([2]);
    expect(read.status === "read" && read.problems).toEqual([
      { row: 3, name: "9999", problems: ["No account has the code 9999. Add it under Settings, Accounts, or correct the code."] },
      { row: 4, name: "1200", problems: ["1200 Trade receivables is entered customer by customer."] },
      { row: 5, name: "1111", problems: ["The same account is in row 2."] },
      { row: 6, name: "3100", problems: ["Enter a debit or a credit, not both: the balance the account stood at."] },
      { row: 7, name: "", problems: ["Give the account's code."] },
      { row: 8, name: "1111", problems: ["This row has more cells than the file has columns. Check for a stray comma.", "The same account is in row 2."] },
    ]);
    // A file from another system carries that system's codes: a name that is not the code's own stops the row.
    const foreign = readAccountImport("Account code,Account name,Debit,Credit\n1111,Meezan Bank,900000,\n3100,Owner's capital,,900000\n", accounts);
    expect(foreign.status === "read" && foreign.problems).toEqual([{ row: 2, name: "1111 Meezan Bank", problems: ['Code 1111 is "Cash in hand" here, but the file calls it "Meezan Bank". Correct the code, or remove the name if the code is right.'] }]);
    expect(readAccountImport("Code,Amount\n1111,5\n", accounts)).toMatchObject({ status: "unreadable" });
    expect(readAccountImport("Account code,Credit\n1111,5\n", accounts)).toEqual({ status: "unreadable", reason: 'The file needs a "Debit" column in its first row.' });
  });

  const parties = { byCode: new Map([["c-001", "alpha"], ["beta traders", "gamma"]]), byName: new Map([["alpha motors", "alpha"], ["beta traders", "beta"]]) };

  it("reads unpaid invoices by the customer's code or name; a code beats a name", () => {
    const read = readPartyImport("Customer,Invoice number,Invoice date,Due date,Amount unpaid\nC-001,SI-1,05-03-2026,04-04-2026,84500\nAlpha Motors,SI-2,2026-06-20,,1500.75\nBeta Traders,SI-1,30/06/2026,,10\n", "receivable", OPENING, parties);
    expect(read.status === "read" && read.problems).toEqual([]);
    expect(read.status === "read" && read.lines.map((l) => `${l.row} ${l.line.partyId} ${l.line.documentNumber} ${l.line.documentDate} ${l.line.dueDate} ${l.line.amount.toFixed(2)}`)).toEqual([
      "2 alpha SI-1 2026-03-05 2026-04-04 84500.00",
      "3 alpha SI-2 2026-06-20 null 1500.75",
      // "Beta Traders" is one customer's name and another's code: the code wins.
      "4 gamma SI-1 2026-06-30 null 10.00",
    ]);
  });

  it("does not guess whether a file's dates are day first or month first", () => {
    // 03/04/2026 could be 3 April or 4 March; a 20/06 elsewhere in the file settles it as day first.
    expect(dateOrderUnproven(["03/04/2026", "05-06-2026"])).toBe(true);
    expect(dateOrderUnproven(["03/04/2026", "20/06/2026"])).toBe(false);
    expect(dateOrderUnproven(["2026-04-03", "05/05/2026", "", undefined])).toBe(false);
    const doubtful = readPartyImport("Customer,Invoice number,Invoice date,Due date,Amount unpaid\nC-001,SI-1,03/04/2026,,100\nC-001,SI-2,05/06/2026,,100\n", "receivable", OPENING, parties);
    expect(doubtful).toEqual({ status: "unreadable", reason: "The dates in this file could be day first or month first: none has a day above 12 to tell which. Write them year first, as 2026-06-30, and import the file again." });
    // A due date with a day above 12 settles it for the whole file.
    const settled = readPartyImport("Customer,Invoice number,Invoice date,Due date,Amount unpaid\nC-001,SI-1,03/04/2026,15/05/2026,100\n", "receivable", OPENING, parties);
    expect(settled.status === "read" && settled.lines.map((l) => l.line.documentDate)).toEqual(["2026-04-03"]);
  });

  it("lists every bad row of an invoice file with what is wrong", () => {
    const read = readPartyImport("Supplier,Bill number,Bill date,Amount unpaid\nC-001,B-1,2026-06-01,100\nNobody,B-2,2026-06-01,100\nc-001,b-1,2026-06-02,5\nC-001,B-3,2026-07-01,5\n,B-4,2026-06-01,5\n", "payable", OPENING, parties);
    expect(read.status === "read" && read.lines.map((l) => l.row)).toEqual([2]);
    expect(read.status === "read" && read.problems).toEqual([
      { row: 3, name: "Nobody B-2", problems: ['No supplier has the code or name "Nobody". Add the supplier first, or correct it.'] },
      { row: 4, name: "c-001 b-1", problems: ["The same bill of this supplier is in row 2."] },
      { row: 5, name: "C-001 B-3", problems: ["The bill's date must be before the opening date. One dated on or after it is entered as an ordinary bill."] },
      { row: 6, name: "B-4", problems: ["Give the supplier's code or name."] },
    ]);
    expect(readPartyImport("Customer,Invoice number\nC-001,1\n", "payable", OPENING, parties)).toMatchObject({ status: "unreadable" });
  });
});

describe("the opening journal", () => {
  const controls = { receivables: "AR", payables: "AP", openingEquity: "OBE" };
  const show = (lines: ReturnType<typeof openingJournal>["lines"]) => lines.map((l) => `${l.accountId} ${(l.debit ?? d("0")).toFixed(2)} ${(l.credit ?? d("0")).toFixed(2)} ${l.customerId ?? l.supplierId ?? "-"}`);

  it("puts each account at its balance, receivables per customer, payables per supplier, and balances on equity", () => {
    const lines: StoredLine[] = [
      { kind: "account", accountId: "cash", debit: d("50000"), credit: d("0") },
      { kind: "account", accountId: "bank", debit: d("450000"), credit: d("0") },
      { kind: "account", accountId: "capital", debit: d("0"), credit: d("900000") },
      { kind: "receivable", customerId: "alpha", amount: d("84500") },
      { kind: "receivable", customerId: "alpha", amount: d("1500.75") },
      { kind: "receivable", customerId: "beta", amount: d("10") },
      { kind: "payable", supplierId: "sigma", amount: d("36010.75") },
    ];
    const journal = openingJournal(lines, controls);
    expect(show(journal.lines)).toEqual([
      "cash 50000.00 0.00 -",
      "bank 450000.00 0.00 -",
      "capital 0.00 900000.00 -",
      "AR 86000.75 0.00 alpha",
      "AR 10.00 0.00 beta",
      "AP 0.00 36010.75 sigma",
      // Debits 586,010.75 less credits 936,010.75: equity is debited with the 350,000 still missing (the stock).
      "OBE 350000.00 0.00 -",
    ]);
    expect(journal.difference.toFixed(2)).toBe("-350000.00");
    expect(journal.lines.find((l) => l.customerId === "alpha")?.description).toBe("Opening balance: 2 unpaid invoices");
    expect(journal.lines.find((l) => l.supplierId === "sigma")?.description).toBe("Opening balance: 1 unpaid bill");
    const debits = journal.lines.reduce((sum, l) => sum.plus(l.debit ?? 0), d("0"));
    const credits = journal.lines.reduce((sum, l) => sum.plus(l.credit ?? 0), d("0"));
    expect(debits.toFixed(4)).toBe(credits.toFixed(4));
  });

  it("credits equity when debits are the larger side, and adds no line when they already agree", () => {
    const more = openingJournal([{ kind: "account", accountId: "cash", debit: d("0.0001"), credit: d("0") }], controls);
    expect(show(more.lines)).toEqual(["cash 0.00 0.00 -", "OBE 0.00 0.00 -"]);
    expect(more.lines[1].credit?.toFixed(4)).toBe("0.0001");
    const even = openingJournal([{ kind: "account", accountId: "cash", debit: d("5"), credit: d("0") }, { kind: "account", accountId: "capital", debit: d("0"), credit: d("5") }], controls);
    expect(even.lines).toHaveLength(2);
    expect(even.difference.isZero()).toBe(true);
    expect(openingJournal([], controls)).toEqual({ lines: [], difference: d("0") });
  });
});

describe("ageing", () => {
  it("counts days between two dates across months, years and leap days", () => {
    expect([daysBetween("2026-06-30", "2026-07-01"), daysBetween("2026-03-01", "2026-07-01"), daysBetween("2027-12-31", "2028-03-01"), daysBetween("2026-07-01", "2026-07-01"), daysBetween("2026-07-02", "2026-07-01")]).toEqual([1, 122, 61, 0, -1]);
  });

  it("puts an age in its band", () => {
    expect([0, 30, 31, 60, 61, 90, 91, 400, -5].map(ageBand)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 0]);
    expect(AGE_BANDS.map((b) => b.label)).toEqual(["0 to 30 days", "31 to 60 days", "61 to 90 days", "Over 90 days"]);
  });

  it("ages what is owed from each invoice's own date, customer by customer", () => {
    const items = [
      { partyId: "b", partyName: "Beta Traders", documentDate: "2026-06-25", amount: d("10") },
      { partyId: "a", partyName: "Alpha Motors", documentDate: "2026-03-05", amount: d("84500") },
      { partyId: "a", partyName: "Alpha Motors", documentDate: "2026-06-20", amount: d("1500.75") },
      { partyId: "a", partyName: "Alpha Motors", documentDate: "2026-05-15", amount: d("200") },
      { partyId: "b", partyName: "Beta Traders", documentDate: "2026-04-20", amount: d("40") },
    ];
    const aged = ageOpenItems(items, "2026-07-01");
    const show = (bands: Decimal[]) => bands.map((b) => b.toFixed(2));
    expect(aged.parties.map((p) => [p.partyName, ...show(p.bands), p.total.toFixed(2)])).toEqual([
      // 20 June is 11 days old, 15 May 47, 5 March 118.
      ["Alpha Motors", "1500.75", "200.00", "0.00", "84500.00", "86200.75"],
      // 25 June is 6 days old, 20 April 72.
      ["Beta Traders", "10.00", "0.00", "40.00", "0.00", "50.00"],
    ]);
    expect([...show(aged.bands), aged.total.toFixed(2)]).toEqual(["1510.75", "200.00", "40.00", "84500.00", "86250.75"]);
    // A month later every invoice is a month older: age runs from the invoice, not from when it was entered.
    expect(show(ageOpenItems(items, "2026-08-01").bands)).toEqual(["0.00", "1510.75", "200.00", "84540.00"]);
    expect(ageOpenItems([], "2026-07-01")).toEqual({ parties: [], bands: show([]).length === 0 ? AGE_BANDS.map(() => d("0")) : [], total: d("0") });
  });
});
