import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  ANNEX_KEYS,
  annexCProblems,
  annexCsv,
  annexSheet,
  annexTable,
  fbrDate,
  fbrRate,
  groupH1,
  isAnnexKey,
  neighbouringMonths,
  readReturnPeriod,
  reconcile,
  type AnnexCRow,
  type AnnexH1Row,
  type TaxReturn,
} from "./rules";

const d = (value: string | number) => new Decimal(value);
const period = readReturnPeriod("2026-11", "2026-12-05");

const line = (over: Partial<AnnexCRow> = {}): AnnexCRow => ({
  docKind: "invoice", number: "SI-1", date: "2026-11-05",
  buyerName: "Registered Dealer", buyerNtn: "1234567", buyerCnic: null, buyerStrn: "3277876123457", buyerRegistered: true, buyerProvince: "punjab",
  originalNumber: null, originalDate: null,
  lineNo: 1, hsCode: "6506.1000", description: "Helmet", saleType: "Goods at standard rate (default)", taxKind: "standard", taxRate: d(18),
  quantity: d(4), uom: "Piece", value: d(4000), retailValue: null, salesTax: d(720), extraTax: d(0), furtherTax: d(0),
  sroScheduleNo: null, sroItemSerial: null, total: d(4720),
  ...over,
});
const stock = (over: Partial<AnnexH1Row> = {}): AnnexH1Row => ({
  itemCode: "HL-1", itemName: "Helmet", hsCode: "6506.1000", uom: "Piece", taxRate: d(18),
  openingQuantity: d(0), openingValue: d(0), importedQuantity: d(0), importedValue: d(0), purchasedQuantity: d(8), purchasedValue: d(4800),
  suppliedQuantity: d(5), suppliedValue: d(3000), otherQuantity: d(0), otherValue: d(0), closingQuantity: d(3), closingValue: d(1800),
  ...over,
});
const data = (over: Partial<TaxReturn> = {}): TaxReturn => ({ period, province: "sindh", c: [], c1: [], a: [], b: [], h1: [], ledger: [], ...over });

describe("the return's period", () => {
  it("is one calendar month, the one asked for", () => {
    expect(readReturnPeriod("2026-11", "2026-12-05")).toEqual({ month: "2026-11", from: "2026-11-01", to: "2026-11-30", label: "November 2026" });
    expect(readReturnPeriod("2028-02", "2026-12-05")).toMatchObject({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("is the month before today's when none, or nonsense, is asked for", () => {
    expect(readReturnPeriod(undefined, "2026-12-05").month).toBe("2026-11");
    expect(readReturnPeriod("2026-13", "2026-12-05").month).toBe("2026-11");
    expect(readReturnPeriod("November", "2027-01-15")).toMatchObject({ month: "2026-12", to: "2026-12-31", label: "December 2026" });
    expect(readReturnPeriod(["2026-10"], "2026-12-05").month).toBe("2026-11");
  });

  it("steps to the month before and after, over the year's end", () => {
    expect(neighbouringMonths(readReturnPeriod("2026-11", "2026-12-05"))).toEqual({ previous: "2026-10", next: "2026-12" });
    expect(neighbouringMonths(readReturnPeriod("2026-12", "2026-12-05"))).toEqual({ previous: "2026-11", next: "2027-01" });
    expect(neighbouringMonths(readReturnPeriod("2027-01", "2026-12-05"))).toEqual({ previous: "2026-12", next: "2027-02" });
  });
});

describe("how FBR's files write things", () => {
  it("writes a day as DD-MM-YYYY and a rate as a percentage", () => {
    expect(fbrDate("2026-11-05")).toBe("05-11-2026");
    expect(fbrDate(null)).toBeNull();
    expect(fbrRate(d(18))).toBe("18%");
    expect(fbrRate(d("12.5"))).toBe("12.5%");
    expect(fbrRate(null)).toBeNull();
  });

  it("knows its five annexes and no other", () => {
    expect(ANNEX_KEYS).toEqual(["annex-c", "annex-c1", "annex-a", "annex-b", "annex-h1"]);
    expect(isAnnexKey("annex-c1")).toBe(true);
    expect(isAnnexKey("annex-z")).toBe(false);
    expect(isAnnexKey(undefined)).toBe(false);
  });
});

describe("Annex-C", () => {
  it("takes credit notes away in its totals, and lists them with their own amounts", () => {
    const table = annexTable(data({ c: [line(), line({ docKind: "credit_note", number: "CN-1", date: "2026-11-08", quantity: d(1), value: d(1000), salesTax: d(180), total: d(1180), originalNumber: "SI-1", originalDate: "2026-11-05" })] }), "annex-c");
    const at = (label: string) => table.columns.findIndex((column) => column.label === label);
    expect(table.rows.map((row) => row.kind)).toEqual(["line", "line", "grand"]);
    expect(String(table.rows[1].cells[at("Sales Tax / FED in ST Mode")])).toBe("180");
    expect([String(table.rows[2].cells[at("Value of Sales Excluding Sales Tax")]), String(table.rows[2].cells[at("Sales Tax / FED in ST Mode")]), String(table.rows[2].cells[at("Total Value of Sales")])]).toEqual(["3000", "540", "3540"]);
    expect(table.rows[2].cells[0]).toBe("Total");
  });

  it("says what stands in the way of a clean file", () => {
    expect(annexCProblems([line()], "sindh")).toEqual([]);
    expect(annexCProblems([], null)).toEqual([]);
    expect(
      annexCProblems(
        [
          line({ number: "SI-1", hsCode: null, uom: null }),
          line({ number: "SI-1", lineNo: 2, saleType: null }),
          line({ number: "SI-2", buyerRegistered: false, buyerNtn: null, buyerStrn: null }),
          line({ number: "SI-3", buyerNtn: null, buyerStrn: null }),
          line({ number: "SI-4", taxKind: "third_schedule", retailValue: null }),
        ],
        null,
      ),
    ).toEqual([
      "The province the company supplies from is not set. Set it on the sales tax return page.",
      "1 document is to an unregistered buyer with no CNIC or NTN.",
      "1 document is to a registered buyer with no STRN or NTN.",
      "1 line has no HS code.",
      "1 line has no unit of measure.",
      "1 line has no sale type.",
      "1 Third Schedule line has no retail price.",
    ]);
  });

  it("is uploaded as headings and rows, with no total, and no cell that a spreadsheet would run", () => {
    const table = annexTable(data({ c: [line({ buyerName: "=HYPERLINK(1)", description: 'Helmet, "large"' })] }), "annex-c");
    expect(annexSheet(table).rows).toHaveLength(1);
    const [, row] = annexCsv(table).slice(1).trim().split("\r\n");
    expect(row).toContain("'=HYPERLINK(1)");
    expect(row).toContain('"Helmet, ""large"""');
    expect(row).toContain(",4000.00,");
  });
});

describe("Annex-H1", () => {
  it("is by HS code, unit and rate: items of one kind are one row", () => {
    const groups = groupH1([stock(), stock({ itemCode: "HL-2", itemName: "Helmet, large", closingQuantity: d(2), closingValue: d(1400) }), stock({ itemCode: "GL-1", itemName: "Glove", hsCode: "4203.2100" }), stock({ itemCode: "X", itemName: "Chain", hsCode: null })]);
    expect(groups.map((g) => `${g.hsCode} ${g.description} ${g.closingQuantity} ${g.closingValue}`)).toEqual(["6506.1000 2 items 5 3200", "4203.2100 Glove 3 1800", "null Chain 3 1800"]);
    const table = annexTable(data({ h1: [stock(), stock({ itemCode: "X", itemName: "Chain", hsCode: null })] }), "annex-h1");
    expect(table.notes[0]).toBe("Items with no HS code (1) are listed together on a row without one.");
  });
});

describe("beside the ledger", () => {
  const ledger = (control: "output_tax" | "further_tax" | "input_tax" | "wht_sales_tax", sourceType: string, debit: number, credit: number) => ({ control, sourceType, debit: d(debit), credit: d(credit) });

  it("agrees when the journals of an annex's own documents carry what the annex adds up to", () => {
    const lines = reconcile(data({ c: [line()], ledger: [ledger("output_tax", "sales_invoice", 0, 720)] }));
    expect(lines[0]).toMatchObject({ agrees: true });
    expect([lines[0].annex.toString(), lines[0].ledger.toString(), lines[0].other.toString()]).toEqual(["720", "720", "0"]);
  });

  it("shows a journal written by hand on the tax account beside the annex, without calling the annex wrong", () => {
    const [output] = reconcile(data({ c: [line()], ledger: [ledger("output_tax", "sales_invoice", 0, 720), ledger("output_tax", "manual_journal", 0, 50)] }));
    expect([output.agrees, output.other.toString()]).toEqual([true, "50"]);
  });

  it("differs when the books and the annex do not carry the same", () => {
    const [output] = reconcile(data({ c: [line()], ledger: [ledger("output_tax", "sales_invoice", 0, 700)] }));
    expect(output.agrees).toBe(false);
  });

  it("keeps purchases and imports apart on the one input tax account", () => {
    const lines = reconcile(data({ ledger: [ledger("input_tax", "supplier_bill", 1080, 0), ledger("input_tax", "supplier_return", 0, 216), ledger("input_tax", "landed_cost", 3000, 0), ledger("input_tax", "opening", 10, 0)] }));
    const purchases = lines.find((l) => l.label.startsWith("Input tax on purchases"))!;
    const imports = lines.find((l) => l.label.startsWith("Input tax paid at import"))!;
    expect([purchases.ledger.toString(), purchases.other.toString(), imports.ledger.toString(), imports.other.toString()]).toEqual(["864", "10", "3000", "10"]);
  });
});
