import "server-only";
import writeExcelFile from "write-excel-file/node";
import type { ReportTable } from "@/modules/reports/rules";

/** A spreadsheet holds a number as a binary fraction; beyond this many digits it would lose the last ones. */
const EXACT_IN_A_SPREADSHEET = 1e11;

/**
 * The table as an Excel file: the company, the report and its period, then the headings and the
 * rows, with amounts as numbers shown to two decimals, or to four where an amount has them. An amount too large for a spreadsheet to
 * hold exactly is written as text, so that no digit is ever lost. Nothing is calculated here.
 */
export async function tableToXlsx(table: ReportTable, company: string): Promise<Buffer> {
  const bold = { fontWeight: "bold" as const };
  const rows = [
    [{ value: company, ...bold }],
    [{ value: table.title, ...bold }],
    [{ value: table.period }],
    [],
    table.columns.map((column) => ({ value: column.label, ...bold, align: column.numeric ? ("right" as const) : ("left" as const) })),
    ...table.rows.map((row) =>
      row.cells.map((cell, at) => {
        const style = row.kind === "line" ? {} : bold;
        if (cell === null) return null;
        if (typeof cell === "string") return { value: cell, type: String, ...style, ...(table.columns[at]?.numeric ? { align: "right" as const } : {}) };
        // The spreadsheet's own number type is the only JS number an amount ever becomes.
        if (cell.abs().lt(EXACT_IN_A_SPREADSHEET)) return { value: Number(cell.toFixed(4)), type: Number, format: "#,##0.00##", ...style };
        return { value: cell.toFixed(4), type: String, align: "right" as const, ...style };
      }),
    ),
    ...table.notes.map((note) => [{ value: note }]),
  ];
  return writeExcelFile(rows, { columns: table.columns.map((column) => ({ width: column.numeric ? 18 : column.label === "Code" || column.label === "Date" ? 12 : 44 })) }).toBuffer();
}
