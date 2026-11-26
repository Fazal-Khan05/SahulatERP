import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { tableToCsv } from "@/modules/reports/rules";
import { ageBand, agedPayablesTable, purchaseFilterQuery, readPurchaseFilter, supplierStatementTable, withholdingRegisterTable, type PurchaseFilter, type WithheldEntry } from "./rules";

const d = (value: string) => new Decimal(value);
const filter: PurchaseFilter = { from: "2026-11-01", to: "2026-11-30", branchId: null, supplierId: null };
const show = (table: { rows: { cells: (string | Decimal | null)[] }[] }) => table.rows.map((row) => row.cells.map((cell) => (cell === null ? "" : typeof cell === "string" ? cell : cell.toFixed(2))).join(" | "));

describe("the filter", () => {
  it("takes the fiscal year so far when no dates are given, and turns a period round", () => {
    expect(readPurchaseFilter({}, { yearStart: "2026-07-01", today: "2026-11-17" })).toEqual({ from: "2026-07-01", to: "2026-11-17", branchId: null, supplierId: null });
    expect(readPurchaseFilter({ from: "2026-12-01", to: "2026-11-30", supplier: "not-an-id" }, { yearStart: "2026-07-01", today: "2026-11-17" })).toEqual({ from: "2026-11-30", to: "2026-11-30", branchId: null, supplierId: null });
    expect(purchaseFilterQuery({ ...filter, supplierId: "11111111-1111-4111-8111-111111111111" }, { report: "aged-payables" })).toBe("from=2026-11-01&to=2026-11-30&supplier=11111111-1111-4111-8111-111111111111&report=aged-payables");
  });
});

describe("ageing what is owed", () => {
  it("counts from the day an amount is due", () => {
    expect([ageBand("2026-12-01", "2026-11-30"), ageBand("2026-11-30", "2026-11-30"), ageBand("2026-11-29", "2026-11-30"), ageBand("2026-10-31", "2026-11-30"), ageBand("2026-10-30", "2026-11-30"), ageBand("2026-09-01", "2026-11-30"), ageBand("2026-08-31", "2026-11-30"), ageBand("2025-01-01", "2026-11-30")]).toEqual([0, 0, 1, 1, 2, 3, 4, 4]);
  });

  it("adds each supplier up by age, takes off what the supplier holds, and sets the total beside the books", () => {
    const items = [
      { supplierId: "k", supplierName: "Karachi Motors", document: "PB-2627-00002", reference: "KM-7", date: "2026-11-04", due: "2026-12-04", owed: d("90000") },
      { supplierId: "k", supplierName: "Karachi Motors", document: "PB-2627-00003", reference: "KM-8", date: "2026-08-01", due: "2026-08-01", owed: d("9000") },
      { supplierId: "l", supplierName: "Lahore Parts", document: "Opening: OLD-1", reference: null, date: "2026-06-01", due: "2026-06-15", owed: d("2250") },
    ];
    const credits = [{ supplierId: "k", supplierName: "Karachi Motors", advances: d("500"), credits: d("200") }, { supplierId: "m", supplierName: "Multan Traders", advances: d("300"), credits: d("0") }];
    expect(show(agedPayablesTable(items, credits, d("100250"), filter, false))).toEqual([
      "Karachi Motors |  |  | 90000.00 |  |  |  | 9000.00 | 99000.00 | 700.00 | 98300.00",
      "Lahore Parts |  |  |  |  |  |  | 2250.00 | 2250.00 |  | 2250.00",
      // A supplier that is owed nothing and holds an advance is owed less than nothing.
      "Multan Traders |  |  |  |  |  |  |  | 0.00 | 300.00 | -300.00",
      "Total |  |  | 90000.00 | 0.00 | 0.00 | 0.00 | 11250.00 | 101250.00 | 1000.00 | 100250.00",
      "Trade payables less advances to suppliers, in the books |  |  |  |  |  |  |  |  |  | 100250.00",
      "Difference |  |  |  |  |  |  |  |  |  | 0.00",
    ]);
    // With a supplier chosen, each thing owed is listed.
    const detail = agedPayablesTable(items.slice(0, 2), credits.slice(0, 1), d("98000"), filter, true);
    expect(show(detail).slice(0, 4)).toEqual([
      "Karachi Motors |  |  |  |  |  |  |  |  |  | ",
      "PB-2627-00002 (KM-7) | 04-11-2026 | 04-12-2026 | 90000.00 |  |  |  |  | 90000.00 |  | ",
      "PB-2627-00003 (KM-8) | 01-08-2026 | 01-08-2026 |  |  |  |  | 9000.00 | 9000.00 |  | ",
      "Total, Karachi Motors |  |  | 90000.00 |  |  |  | 9000.00 | 99000.00 | 700.00 | 98300.00",
    ]);
    expect(detail.notes.at(-1)).toMatch(/do not agree/);
  });
});

describe("a supplier's statement", () => {
  it("runs the balance through every entry, and asks for a supplier when none is chosen", () => {
    const table = supplierStatementTable("Lahore Parts", d("100"), [
      { date: "2026-11-04", document: "Bill PB-2627-00001", details: "Bill INV-1 from Lahore Parts", amount: d("2400") },
      { date: "2026-11-06", document: "Payment PV-2627-00001", details: "Paid to Lahore Parts", amount: d("-3400") },
    ], filter);
    expect(show(table)).toEqual([
      " | Owed before |  |  |  | 100.00",
      "04-11-2026 | Bill PB-2627-00001 | Bill INV-1 from Lahore Parts | 2400.00 |  | 2500.00",
      "06-11-2026 | Payment PV-2627-00001 | Paid to Lahore Parts |  | 3400.00 | -900.00",
      " | Owed after |  | 2400.00 | 3400.00 | -900.00",
    ]);
    expect(table.notes).toEqual(["The supplier holds more of the company's money than it is owed: an advance, or credit for goods sent back."]);
    expect(supplierStatementTable(null, d("0"), [], filter)).toMatchObject({ rows: [], notes: ["Choose a supplier to see its statement."] });
  });
});

describe("the withholding register", () => {
  const entry = (over: Partial<WithheldEntry>): WithheldEntry => ({ date: "2026-11-04", kind: "income_tax", supplierName: "Karachi Motors", supplierType: "company", ntn: "7654321", cnic: null, billNumber: "PB-2627-00002", supplierInvoiceNo: "KM-7", label: "Goods, from a company", legalReference: "s.153(1)(a)", onActiveList: false, base: d("100000"), rate: d("10"), amount: d("10000"), challanNo: null, paidOn: null, ...over });

  it("totals each kind of tax, and sets what is still to be paid over beside the books", () => {
    const zero = { income_tax: d("0"), sales_tax: d("0"), provincial_sales_tax: d("0") };
    const table = withholdingRegisterTable(
      [entry({ challanNo: "IT-1", paidOn: "2026-11-10" }), entry({ date: "2026-11-08", billNumber: "PB-2627-00004", base: d("10000"), amount: d("1000") }), entry({ kind: "provincial_sales_tax", supplierName: "Karachi Clearing", ntn: null, cnic: "35202-1234567-1", label: "Sindh", rate: d("15"), base: d("3000"), amount: d("450") })],
      { unpaid: { ...zero, income_tax: d("1000"), provincial_sales_tax: d("450") }, books: { ...zero, income_tax: d("1000"), provincial_sales_tax: d("450") }, salaries: d("0"), onExpenses: d("0") },
      filter,
    );
    expect(show(table)).toEqual([
      "Income tax |  |  |  |  |  |  |  |  |  |  | ",
      "04-11-2026 | Karachi Motors | 7654321 | PB-2627-00002 | KM-7 | Goods, from a company | No | 100000.00 | 10.00 | 10000.00 | IT-1 | 10-11-2026",
      "08-11-2026 | Karachi Motors | 7654321 | PB-2627-00004 | KM-7 | Goods, from a company | No | 10000.00 | 10.00 | 1000.00 |  | ",
      " | Total, income tax |  |  |  |  |  |  |  | 11000.00 |  | ",
      "Provincial sales tax |  |  |  |  |  |  |  |  |  |  | ",
      "04-11-2026 | Karachi Clearing | 35202-1234567-1 | PB-2627-00002 | KM-7 | Sindh | No | 3000.00 | 15.00 | 450.00 |  | ",
      " | Total, provincial sales tax |  |  |  |  |  |  |  | 450.00 |  | ",
      " | Withheld in the period |  |  |  |  |  |  |  | 11450.00 |  | ",
      "Still to be paid to the government, as at the end of 30-11-2026 |  |  |  |  |  |  |  |  |  |  | ",
      " | Income tax |  |  |  |  |  |  |  | 1000.00 |  | ",
      " | Provincial sales tax |  |  |  |  |  |  |  | 450.00 |  | ",
      " | Withheld and not yet paid over |  |  |  |  |  |  |  | 1450.00 |  | ",
      " | Withholding payable accounts in the books |  |  |  |  |  |  |  | 1450.00 |  | ",
      " | Difference |  |  |  |  |  |  |  | 0.00 |  | ",
    ]);
    expect(table.notes).toEqual([]);
    // A file of it keeps every figure.
    expect(tableToCsv(table, "Lahore Bike Parts")).toContain("Withheld and not yet paid over,,,,,,,,1450.00");
  });

  it("says so when the two do not agree, and leaves the comparison out for one branch or supplier", () => {
    const zero = { income_tax: d("0"), sales_tax: d("0"), provincial_sales_tax: d("0") };
    expect(withholdingRegisterTable([entry({})], { unpaid: { ...zero, income_tax: d("10000") }, books: { ...zero, income_tax: d("9000") }, salaries: d("0"), onExpenses: d("0") }, filter).notes[0]).toMatch(/do not agree/);
    expect(withholdingRegisterTable([entry({})], null, filter).notes[0]).toMatch(/challans are for the whole company/);
  });

  it("sets the income tax deducted from salaries in a section of its own, and counts it in what is still to be paid", () => {
    const zero = { income_tax: d("0"), sales_tax: d("0"), provincial_sales_tax: d("0") };
    // 10,000 withheld on a bill and paid over; 2,800 withheld on an expense; 3,800 deducted from October's salaries.
    // The income tax account holds the last two.
    const table = withholdingRegisterTable(
      [entry({ challanNo: "IT-1", paidOn: "2026-11-10" }), entry({ date: "2026-11-12", billNumber: "EX-2627-00007", supplierInvoiceNo: "KM-SRV-9", label: "Services, other", base: d("10000"), rate: d("28"), amount: d("2800") })],
      { unpaid: { ...zero, income_tax: d("2800") }, books: { ...zero, income_tax: d("6600") }, salaries: d("3800"), onExpenses: d("2800") },
      filter,
      [{ date: "2026-11-30", month: "2026-11-01", runNumber: "PR-2627-00002", people: 1, taxable: d("130000"), amount: d("3800") }],
    );
    expect(show(table)).toEqual([
      "Income tax |  |  |  |  |  |  |  |  |  |  | ",
      "04-11-2026 | Karachi Motors | 7654321 | PB-2627-00002 | KM-7 | Goods, from a company | No | 100000.00 | 10.00 | 10000.00 | IT-1 | 10-11-2026",
      "12-11-2026 | Karachi Motors | 7654321 | EX-2627-00007 | KM-SRV-9 | Services, other | No | 10000.00 | 28.00 | 2800.00 |  | ",
      " | Total, income tax |  |  |  |  |  |  |  | 12800.00 |  | ",
      "Income tax deducted from salaries (section 149) |  |  |  |  |  |  |  |  |  |  | ",
      "30-11-2026 | Salaries for November 2026 |  | PR-2627-00002 |  | Salary, 1 person taxed |  | 130000.00 |  | 3800.00 |  | ",
      " | Total, income tax deducted from salaries |  |  |  |  |  |  |  | 3800.00 |  | ",
      " | Withheld in the period |  |  |  |  |  |  |  | 16600.00 |  | ",
      "Still to be paid to the government, as at the end of 30-11-2026 |  |  |  |  |  |  |  |  |  |  | ",
      " | Income tax |  |  |  |  |  |  |  | 2800.00 |  | ",
      " | Income tax deducted from salaries (section 149) |  |  |  |  |  |  |  | 3800.00 |  | ",
      " | Withheld and not yet paid over |  |  |  |  |  |  |  | 6600.00 |  | ",
      " | Withholding payable accounts in the books |  |  |  |  |  |  |  | 6600.00 |  | ",
      " | Difference |  |  |  |  |  |  |  | 0.00 |  | ",
    ]);
    // They agree; the one note says why these two stay under what is still to be paid.
    expect(table.notes).toEqual([expect.stringMatching(/^A challan here pays over tax withheld on supplier bills\./)]);
    // With no salary tax and nothing on an expense, the register is as it always was.
    expect(withholdingRegisterTable([], { unpaid: zero, books: zero, salaries: d("0"), onExpenses: d("0") }, filter).notes).toEqual([]);
  });
});
