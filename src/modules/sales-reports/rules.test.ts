import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { tableToCsv, type Cell } from "@/modules/reports/rules";
import { can } from "@/modules/tenant/rules";
import { SALES_REPORT_PERMISSION, isSalesReportKey, monthLabel, readSalesFilter, salesBreakdownTable, salesFilterQuery, salesRegisterTable, type SalesFilter, type SalesRow } from "./rules";

const d = (value: string) => new Decimal(value);
const filter: SalesFilter = { from: "2026-11-01", to: "2026-11-30", branchId: null };
const text = (cell: Cell) => (cell === null ? "" : typeof cell === "string" ? cell : cell.toFixed(2));
const show = (table: { rows: { cells: Cell[] }[] }) => table.rows.map((row) => row.cells.map(text).join(" | "));
const row = (label: string, amount: string, cost: string | null, over: Partial<SalesRow> = {}): SalesRow => ({ label, detail: null, quantity: null, unit: null, amount: d(amount), cost: cost === null ? null : d(cost), ...over });

describe("the filter", () => {
  it("takes the fiscal year so far when no dates are given, turns a period round, and drops what is not an id", () => {
    expect(readSalesFilter({}, { yearStart: "2026-07-01", today: "2026-11-17" })).toEqual({ from: "2026-07-01", to: "2026-11-17", branchId: null });
    expect(readSalesFilter({ from: "2026-12-01", to: "2026-11-30", branch: "nope" }, { yearStart: "2026-07-01", today: "2026-11-17" })).toEqual({ from: "2026-11-30", to: "2026-11-30", branchId: null });
    const branch = "11111111-1111-4111-8111-111111111111";
    expect(salesFilterQuery({ ...filter, branchId: branch }, { report: "sales-register" })).toBe(`from=2026-11-01&to=2026-11-30&branch=${branch}&report=sales-register`);
  });

  it("knows its reports, and a salesperson is not among the readers", () => {
    expect(isSalesReportKey("sales-by-city")).toBe(true);
    expect(isSalesReportKey("trial-balance")).toBe(false);
    expect(["owner", "accountant", "auditor", "sales_manager"].every((role) => can(role as never, SALES_REPORT_PERMISSION))).toBe(true);
    expect(["salesperson", "warehouse_manager", "recovery_officer"].some((role) => can(role as never, SALES_REPORT_PERMISSION))).toBe(false);
  });

  it("writes a month in words", () => {
    expect([monthLabel("2026-01"), monthLabel("2026-11")]).toEqual(["January 2026", "November 2026"]);
  });
});

describe("a breakdown", () => {
  it("sorts largest first, adds up a total and a margin, and sets the total beside the books", () => {
    const table = salesBreakdownTable("sales-by-customer", [row("Small", "1000", "600"), row("Big", "8400", "5520"), row("Mid", "4000", "2500")], d("13400"), filter);
    expect(table.columns.map((c) => c.label)).toEqual(["Customer", "Sales", "Cost of goods sold", "Profit", "Margin"]);
    expect(show(table)).toEqual([
      "Big | 8400.00 | 5520.00 | 2880.00 | 34.3%",
      "Mid | 4000.00 | 2500.00 | 1500.00 | 37.5%",
      "Small | 1000.00 | 600.00 | 400.00 | 40.0%",
      "Total | 13400.00 | 8620.00 | 4780.00 | 35.7%",
      "Sales in the books for the period | 13400.00 |  |  | ",
      "Difference | 0.00 |  |  | ",
    ]);
    expect(table.notes.some((note) => note.includes("do not agree"))).toBe(false);
  });

  it("shows the difference to the paisa, and says so when the books do not agree", () => {
    const table = salesBreakdownTable("sales-by-month", [row("November 2026", "12400.50", null)], d("12400"), filter);
    expect(show(table)).toEqual(["November 2026 | 12400.50", "Total | 12400.50", "Sales in the books for the period | 12400.00", "Difference | 0.50"]);
    expect(table.notes.some((note) => note.includes("do not agree"))).toBe(true);
  });

  it("has no cost, profit or margin for a reader who may not see costs, and no books line for one who cannot read them", () => {
    const table = salesBreakdownTable("sales-by-city", [row("Lahore", "100", null), row("Karachi", "300", null)], null, filter);
    expect(table.columns.map((c) => c.label)).toEqual(["City", "Sales"]);
    expect(show(table)).toEqual(["Karachi | 300.00", "Lahore | 100.00", "Total | 400.00"]);
  });

  it("takes a credit note's quantity and amount off, and never divides by nothing", () => {
    const table = salesBreakdownTable("sales-by-item", [row("HL-1", "0", "0", { detail: "Helmet", quantity: d("0"), unit: "pc" }), row("CH-2", "-500", "-300", { detail: "Chain", quantity: d("-2"), unit: "pc" })], null, filter);
    expect(show(table)).toEqual(["HL-1 | Helmet | 0 pc | 0.00 | 0.00 | 0.00 | ", "CH-2 | Chain | -2 pc | -500.00 | -300.00 | -200.00 | 40.0%", "Total |  |  | -500.00 | -300.00 | -200.00 | 40.0%"]);
  });

  it("downloads with the same figures", () => {
    const table = salesBreakdownTable("sales-by-customer", [row("Khan, Autos", "8400", "5520")], null, filter);
    expect(tableToCsv(table, "Acme").split(/\r?\n/).slice(4, 7)).toEqual(["Customer,Sales,Cost of goods sold,Profit,Margin", '"Khan, Autos",8400.00,5520.00,2880.00,34.3%', "Total,8400.00,5520.00,2880.00,34.3%"]);
  });
});

describe("the register", () => {
  it("lists each document with its tax, credit notes as minus, with totals and the books beside the amount", () => {
    const table = salesRegisterTable(
      [
        { date: "2026-11-05", kind: "invoice", number: "INV-1", customer: "Khan Autos", salesperson: "a@x", amount: d("1000"), tax: d("180"), total: d("1180") },
        { date: "2026-11-20", kind: "credit_note", number: "CN-1", customer: "Khan Autos", salesperson: "a@x", amount: d("-500"), tax: d("-90"), total: d("-590") },
      ],
      d("500"),
      filter,
    );
    expect(show(table)).toEqual([
      "05-11-2026 | Invoice INV-1 | Khan Autos | a@x | 1000.00 | 180.00 | 1180.00",
      "20-11-2026 | Credit note CN-1 | Khan Autos | a@x | -500.00 | -90.00 | -590.00",
      "Total |  |  |  | 500.00 | 90.00 | 590.00",
      "Sales in the books for the period |  |  |  | 500.00 |  | ",
      "Difference |  |  |  | 0.00 |  | ",
    ]);
  });
});
