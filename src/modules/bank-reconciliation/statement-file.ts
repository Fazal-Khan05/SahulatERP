import { inflateRawSync } from "node:zlib";
import Decimal from "decimal.js";
import ExcelJS from "exceljs";
import { MAX_STATEMENT_LINES, readStatement, readStatementRows, type ColumnNames, type Layout, type ReadStatement } from "./rules";

// Step 35: a bank's statement file as it arrives, a CSV file or an Excel workbook (.xlsx), read
// by the same rules (readStatementRows). The workbook comes from outside, so it is not trusted:
// before the library opens it, the ZIP it is made of is unpacked once here, with a ceiling, so
// that a small file cannot unpack to gigabytes (a "zip bomb"), and anything this reading and the
// library's might see differently is refused.

export type SheetRows = { ok: true; rows: string[][] } | { ok: false; reason: string };

/** All the parts of a workbook unpacked together, at most. A 5,000-line statement is under 5 MB. */
export const MAX_UNPACKED_BYTES = 40 * 1024 * 1024;
const MAX_PARTS = 500;
/** The rows of a sheet read, at most: a statement's lines, and room for the bank's heading and notes. */
export const MAX_SHEET_ROWS = MAX_STATEMENT_LINES + 200;
const MAX_COLUMNS = 60;

const UNREADABLE = 'The Excel file could not be read. Open it in Excel and save it again as "Excel Workbook (.xlsx)", or as "CSV UTF-8".';
const TOO_BIG = "The Excel file is too large. Import at most 5,000 lines at a time.";
const OLD_EXCEL =
  'This is an older Excel file (.xls), or one with a password. Open it in Excel and save it as "Excel Workbook (.xlsx)" without a password, or as "CSV UTF-8", and import it again.';

const startsWith = (bytes: Uint8Array, magic: readonly number[]) => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
/** A ZIP file, as an .xlsx workbook is. */
const isZip = (bytes: Uint8Array) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
/** An OLE compound file: an .xls workbook, or an .xlsx one with a password. */
const isCompoundFile = (bytes: Uint8Array) => startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * Why the ZIP may not be opened, or null when every part of it unpacks within the ceiling. Each
 * part is really unpacked (its stated size is not trusted), and the directory must be laid out
 * plainly: nothing before the parts or between them and the directory, no ZIP64, no encryption,
 * and only the two ways of packing an .xlsx uses.
 */
export function zipProblem(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  // The end of the directory: the last record of the file, or before a comment of up to 65,535 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 65_535; at--) {
    if (u32(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end === -1) return UNREADABLE;
  const parts = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryAt = u32(end + 16);
  if (parts === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff || parts > MAX_PARTS) return TOO_BIG;
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== parts || directoryAt + directorySize !== end || end + 22 + u16(end + 20) !== bytes.length) {
    return UNREADABLE;
  }
  let unpacked = 0;
  let at = directoryAt;
  for (let i = 0; i < parts; i++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) return UNREADABLE;
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const packed = u32(at + 20);
    const local = u32(at + 42);
    at += 46 + u16(at + 28) + u16(at + 30) + u16(at + 32);
    if (at > end || flags & 0x1 || local + 30 > directoryAt || u32(local) !== 0x04034b50) return UNREADABLE;
    const dataAt = local + 30 + u16(local + 26) + u16(local + 28);
    if (dataAt + packed > directoryAt) return UNREADABLE;
    if (method === 0) unpacked += packed;
    else if (method === 8) {
      try {
        unpacked += inflateRawSync(bytes.subarray(dataAt, dataAt + packed), { maxOutputLength: MAX_UNPACKED_BYTES - unpacked + 1 }).length;
      } catch (error) {
        return (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? TOO_BIG : UNREADABLE;
      }
    } else return UNREADABLE;
    if (unpacked > MAX_UNPACKED_BYTES) return TOO_BIG;
  }
  return at === end ? null : UNREADABLE;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A cell as text, as the bank's CSV file would give it. A day Excel keeps as a day is written
 * 2026-11-05; a number as Excel shows it, to 15 significant figures (the file holds a binary
 * fraction, so 1234.56 can be stored as 1234.5600000000002: it is never used as a JS number).
 */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? new Decimal(value).toSignificantDigits(15).toFixed() : "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if ("richText" in value) return value.richText.map((run) => run.text).join("");
  if ("formula" in value || "sharedFormula" in value) return cellText((value.result ?? null) as ExcelJS.CellValue);
  if ("hyperlink" in value) return typeof value.text === "string" ? value.text : cellText(value.text as ExcelJS.CellValue);
  return ""; // an error such as #N/A, or anything else
}

/**
 * The rows of the first sheet that is shown and has anything in it, each row in its place (row
 * r + 1 is rows[r]; an empty row is one empty cell). Only the first cell of merged cells holds
 * their text, as in a CSV file Excel saves.
 */
export async function readSheet(bytes: Uint8Array): Promise<SheetRows> {
  if (isCompoundFile(bytes)) return { ok: false, reason: OLD_EXCEL };
  if (!isZip(bytes)) return { ok: false, reason: UNREADABLE };
  const problem = zipProblem(bytes);
  if (problem) return { ok: false, reason: problem };
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as unknown as ExcelJS.Buffer);
  } catch {
    return { ok: false, reason: UNREADABLE };
  }
  const sheet = workbook.worksheets.find((s) => s.state === "visible" && s.actualRowCount > 0);
  if (!sheet) return { ok: false, reason: "The Excel file has no sheet with anything in it." };
  if (sheet.rowCount > MAX_SHEET_ROWS) return { ok: false, reason: TOO_BIG };
  const rows: string[][] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.findRow(r);
    if (!row) {
      rows.push([""]);
      continue;
    }
    const cells: string[] = [];
    for (let c = 1; c <= Math.min(row.cellCount, MAX_COLUMNS); c++) {
      const cell = row.getCell(c);
      cells.push(cell.type === ExcelJS.ValueType.Merge ? "" : cellText(cell.value));
    }
    rows.push(cells.length > 0 ? cells : [""]);
  }
  return { ok: true, rows };
}

/**
 * A statement read from the file the company chose: an Excel workbook by what it is (not by its
 * name), anything else as CSV text.
 */
export async function readStatementFile(bytes: Uint8Array, layout: Layout, columns: ColumnNames = {}): Promise<ReadStatement> {
  if (isZip(bytes) || isCompoundFile(bytes)) {
    const sheet = await readSheet(bytes);
    return sheet.ok ? readStatementRows(sheet.rows, layout, columns) : { ok: false, problems: [sheet.reason] };
  }
  return readStatement(new TextDecoder().decode(bytes), layout, columns);
}
