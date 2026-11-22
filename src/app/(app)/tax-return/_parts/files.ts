import "server-only";
import writeExcelFile from "write-excel-file/node";
import type { ReportTable } from "@/modules/reports/rules";
import { annexSheet } from "@/modules/tax-return/rules";

/** A spreadsheet holds a number as a binary fraction; beyond this many digits it would lose the last ones. */
const EXACT_IN_A_SPREADSHEET = 1e11;

/**
 * An annex as an Excel sheet for upload: the headings in the first row and a row for each line,
 * with nothing above and no total below. Amounts are numbers; an amount too large for a
 * spreadsheet to hold exactly is written as text. Nothing is calculated here.
 */
export async function annexToXlsx(table: ReportTable): Promise<Buffer> {
  const sheet = annexSheet(table);
  const rows = [
    sheet.columns.map((column) => ({ value: column.label, fontWeight: "bold" as const })),
    ...sheet.rows.map((row) =>
      row.map((cell) => {
        if (cell === null) return null;
        if (typeof cell === "string") return { value: cell, type: String };
        if (cell.abs().lt(EXACT_IN_A_SPREADSHEET)) return { value: Number(cell.toFixed(4)), type: Number, format: "0.00##" };
        return { value: cell.toFixed(4), type: String };
      }),
    ),
  ];
  return writeExcelFile(rows, { columns: sheet.columns.map((column) => ({ width: column.numeric ? 18 : Math.min(40, Math.max(12, column.label.length + 2)) })) }).toBuffer();
}
