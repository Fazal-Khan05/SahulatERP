import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { readCsvTable } from "@/lib/csv-table";
import { ITEM_COLUMNS } from "@/modules/items/rules";
import { IMPORT_KINDS, columnLetter, findHeadingRow, headingsOf, mappedCsv, readLeftOut, readMapping, sampleRows, suggestMapping, templateHeadings } from "./rules";

// Step 49's rules on their own: finding the headings in another system's file, matching its
// columns to ours, and the file in our own layout that each kind's import then reads.

const customers = IMPORT_KINDS.customers;
const field = (fields: Record<string, string>) => (name: string) => fields[name] ?? "";

describe("another system's file", () => {
  it("finds the headings under the company's name, the report's name and the date", () => {
    const rows = [["Old Ledger Pro - Customer List"], ["Printed on", "20-11-2026"], [""], ["Cust Code", "Customer Name", "Mobile No", "City"], ["C-1", "Zeta", "0300", "Lahore"]];
    expect(findHeadingRow(rows)).toBe(3);
    // A file that starts with its headings, and one with a single column.
    expect(findHeadingRow([["Name", "City"], ["Zeta", "Lahore"]])).toBe(0);
    expect(findHeadingRow([[""], ["Name"], ["Zeta"]])).toBe(1);
  });

  it("names a heading the file left blank by its column's letter, and drops empty columns at the end", () => {
    expect(headingsOf(["Code", "", "  Customer   Name ", "", ""])).toEqual(["Code", "Column B", "Customer Name"]);
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("guesses each column from the heading it was read from last time, then ours, then another system's, never one heading twice", () => {
    const headings = ["Party", "Customer Name", "Phone No", "Code"];
    expect(suggestMapping(customers, headings, null)).toMatchObject({ code: 3, name: 1, phone: 2, contactName: null });
    // Last time "Party" was the name: it wins, and "Customer Name" is not offered for anything else.
    const remembered = suggestMapping(customers, headings, { name: "Party", code: "Not in this file" });
    expect(remembered).toMatchObject({ name: 0, code: 3 });
    expect(Object.values(remembered).filter((index) => index === 1)).toEqual([]);
  });

  it("refuses a column read as two of ours, or a needed one left out, in words", () => {
    const headings = ["Name", "City"];
    expect(readMapping(customers, field({ map_name: "0", map_city: "1" }), headings)).toEqual({ ok: true, mapping: expect.objectContaining({ name: 0, city: 1, code: null }) });
    expect(readMapping(customers, field({ map_name: "0", map_code: "0" }), headings)).toEqual({ ok: false, reason: 'The column "Name" is chosen for both "Code" and "Name". Choose one column of the file for each.' });
    expect(readMapping(customers, field({ map_city: "1" }), headings)).toEqual({ ok: false, reason: 'Choose the column of the file that holds "Name": it is needed.' });
    expect(readMapping(IMPORT_KINDS.items, field({ map_name: "0" }), headings)).toEqual({ ok: false, reason: 'Choose the column of the file that holds "Code" and "Unit": they are needed.' });
    expect(readMapping(customers, field({ map_name: "7" }), headings)).toEqual({ ok: false, reason: 'Choose again which column of the file holds "Name".' });
  });

  it("reads the rows to leave out as numbers and ranges", () => {
    expect(readLeftOut("7, 120-122 9")).toEqual({ ok: true, rows: new Set([7, 120, 121, 122, 9]) });
    expect(readLeftOut("")).toEqual({ ok: true, rows: new Set() });
    expect(readLeftOut("12-3")).toEqual({ ok: false, reason: '"12-3" is not a row number or a range of rows, such as 7 or 120-125.' });
    expect(readLeftOut("0")).toMatchObject({ ok: false });
  });
});

describe("the file in our own layout", () => {
  const rows = [["Customer List"], [""], ["Cust Code", "Customer Name", "Mobile No"], ["C-1", 'Zeta "Z" Traders, Lahore', "0300-1"], [""], ["C-2", "Eta", ""], ["", "Total", ""]];
  const mapping = { code: 0, name: 1, phone: 2 } as Record<string, number | null>;

  it("keeps every row in its place, so a problem is named by the file's own row, and quotes what needs quoting", () => {
    const csv = mappedCsv(customers, rows, 2, mapping, new Set([7]));
    const parsed = parseCsv(csv);
    // An empty row of the file comes through as a row of empty cells, still in its place.
    expect(parsed.ok && parsed.rows.slice(0, 7)).toEqual([[""], [""], ["Code", "Name", "Phone"], ["C-1", 'Zeta "Z" Traders, Lahore', "0300-1"], ["", "", ""], ["C-2", "Eta", ""], [""]]);
    // Read as each kind's import reads it: the rows keep the file's numbers.
    const table = readCsvTable(csv, [{ key: "code", header: "Code" }, { key: "name", header: "Name" }, { key: "phone", header: "Phone" }], "name", 10);
    expect(table.ok && table.rows.map((row) => row.row)).toEqual([4, 6]);
  });

  it("shows the first rows as ours, without the rows left out or empty ones", () => {
    expect(sampleRows(customers, rows, 2, mapping, new Set([7]), 5)).toEqual([
      { row: 4, cells: ["C-1", 'Zeta "Z" Traders, Lahore', "0300-1"] },
      { row: 6, cells: ["C-2", "Eta", ""] },
    ]);
  });

  it("has a template for every kind with the very headings its import reads", () => {
    expect(templateHeadings(IMPORT_KINDS.items)).toEqual(ITEM_COLUMNS.map((column) => column.header));
    expect(templateHeadings(IMPORT_KINDS.opening_stock)).toEqual(["Item code", "Quantity", "Unit cost", "Warehouse"]);
    expect(templateHeadings(IMPORT_KINDS.ledger_balances)).toEqual(["Account code", "Account name", "Debit", "Credit"]);
    expect(templateHeadings(IMPORT_KINDS.customer_balances)).toEqual(["Customer", "Invoice number", "Invoice date", "Due date", "Amount unpaid"]);
  });
});
