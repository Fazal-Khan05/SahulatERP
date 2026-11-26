import { createHash } from "node:crypto";
import { parseCsv } from "@/lib/csv";
import { readSheet } from "@/modules/bank-reconciliation/statement-file";

// Step 49: the rows of a file brought in from another system, an Excel workbook (.xlsx) or a CSV
// file, as text cells. A workbook is read by the same reader as a bank's Excel statement (Step
// 35), which unpacks it with a ceiling before the library opens it and refuses an older .xls.

/** The largest file taken: 2,000 full rows of any kind fit in it several times over. */
export const IMPORT_FILE_MAX_BYTES = 2 * 1024 * 1024;

export type FileRows = { ok: true; rows: string[][]; excel: boolean } | { ok: false; reason: string };

const startsWith = (bytes: Uint8Array, magic: readonly number[]) => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
/** A workbook: a ZIP (.xlsx), or an OLE compound file (.xls, or an .xlsx with a password, which the reader refuses in words). */
const isWorkbook = (bytes: Uint8Array) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export async function readImportFile(bytes: Uint8Array): Promise<FileRows> {
  if (bytes.length === 0) return { ok: false, reason: "The file is empty." };
  if (bytes.length > IMPORT_FILE_MAX_BYTES) return { ok: false, reason: "The file is too large. Import at most 2,000 rows at a time." };
  if (isWorkbook(bytes)) {
    const sheet = await readSheet(bytes);
    return sheet.ok ? { ok: true, rows: sheet.rows, excel: true } : { ok: false, reason: sheet.reason };
  }
  const text = new TextDecoder().decode(bytes);
  // Bytes that are not UTF-8 arrive as this character; importing them would store garbled text.
  if (text.includes("�")) return { ok: false, reason: 'The file is neither an Excel workbook nor a CSV file saved as UTF-8. In Excel, save it as "Excel Workbook (.xlsx)" or as "CSV UTF-8", and import it again.' };
  const parsed = parseCsv(text);
  return parsed.ok ? { ok: true, rows: parsed.rows, excel: false } : { ok: false, reason: parsed.reason };
}

/** The SHA-256 of a file's bytes, in hex: the same file uploaded again is known by it. */
export const fileSha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A file's name as kept: no control characters, no folders, at most 200 characters. */
export function cleanFileName(name: unknown): string {
  const base = (typeof name === "string" ? name : "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\P{Cc}]/gu, "").trim().slice(0, 200);
  return cleaned === "" ? "import" : cleaned;
}
