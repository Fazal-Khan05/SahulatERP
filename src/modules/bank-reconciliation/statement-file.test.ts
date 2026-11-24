import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import Decimal from "decimal.js";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { readBankAmount, readBankDate, readStatement, type ReadStatement } from "./rules";
import { MAX_SHEET_ROWS, MAX_UNPACKED_BYTES, readSheet, readStatementFile, zipProblem } from "./statement-file";

// Step 35: a statement that arrives as an Excel workbook is read exactly as the same statement in
// a CSV file, and a workbook that is not what it seems is refused before it is opened.

const SAMPLE = readFileSync(new URL("../../../docs/examples/step-35-statement.csv", import.meta.url), "utf8");

async function workbookBytes(fill: (workbook: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  fill(workbook);
  return new Uint8Array((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
}

/**
 * The sample CSV as Excel holds such a statement: days as days, money as numbers (a fixture: Excel
 * itself keeps a binary fraction), the cheque number as text so that its noughts stay.
 */
function sampleSheet(workbook: ExcelJS.Workbook) {
  const sheet = workbook.addWorksheet("Statement");
  const rows = (parseCsv(SAMPLE) as { ok: true; rows: string[][] }).rows;
  const heading = 4;
  rows.forEach((cells, r) => {
    const row = sheet.getRow(r + 1);
    cells.forEach((text, c) => {
      if (text === "") return;
      const cell = row.getCell(c + 1);
      if (r > heading && c <= 1 && readBankDate(text)) {
        const [y, m, d] = readBankDate(text)!.split("-").map(Number);
        cell.value = new Date(Date.UTC(y, m - 1, d));
        cell.numFmt = "dd-mmm-yyyy";
      } else if (r > heading && c >= 4) cell.value = (readBankAmount(text) as Decimal).toNumber();
      else cell.value = text;
    });
  });
}

const lines = (read: ReadStatement) => {
  if (!read.ok) throw new Error(read.problems.join(" "));
  return {
    lines: read.lines.map((l) => ({ ...l, amount: l.amount.toFixed(2), balance: l.balance?.toFixed(2) ?? null })),
    opening: read.opening?.toFixed(2),
    closing: read.closing?.toFixed(2),
    from: read.from,
    to: read.to,
  };
};

/** A ZIP file of the parts given, packed; `stated` is the size its directory claims a part unpacks to. */
function zipOf(parts: { name: string; data: Buffer; stated?: number }[]): Uint8Array {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    const packed = deflateRawSync(part.data);
    const stated = part.stated ?? part.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(stated, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(stated, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    directory.push(entry, name);
    offset += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

describe("an Excel statement", () => {
  it("is read line for line as the same statement in a CSV file, fingerprints and all", async () => {
    const bytes = await workbookBytes(sampleSheet);
    const fromExcel = lines(await readStatementFile(bytes, "hbl"));
    expect(fromExcel).toEqual(lines(readStatement(SAMPLE, "hbl")));
    expect(fromExcel.lines).toHaveLength(10);
    expect(fromExcel.lines[1]).toMatchObject({ row: 8, date: "2026-11-05", reference: "000412", amount: "-20000.00", balance: "30000.00" });
    expect([fromExcel.opening, fromExcel.closing]).toEqual(["0.00", "49595.67"]);
    // Read by the column names too, and by names given by hand.
    expect(lines(await readStatementFile(bytes, "auto"))).toEqual(fromExcel);
    const named = await readStatementFile(bytes, "columns", { date: "Transaction Date", description: "Transaction Details", out: "Debit", in: "Credit", balance: "Balance" });
    expect(lines(named).lines.map((l) => l.amount)).toEqual(fromExcel.lines.map((l) => l.amount));
  });

  it("reads a figure as Excel shows it, a formula by its result, rich text, an Excel day number, and merged cells once", async () => {
    const bytes = await workbookBytes((workbook) => {
      const sheet = workbook.addWorksheet("Statement");
      sheet.getCell("A1").value = "Meezan Bank";
      sheet.mergeCells("A1:F1");
      sheet.addRow([]);
      sheet.addRow(["Date", "Description", "Cheque No", "Debit", "Credit", "Balance"]);
      sheet.addRow([new Date(Date.UTC(2026, 10, 2)), { richText: [{ text: "Cash " }, { font: { bold: true }, text: "deposit" }] }, null, null, 1000.1, 1000.1]);
      // 1000.1 + 0.2 is 1000.3000000000001 as a binary fraction: read as 1,000.30.
      sheet.addRow([46331, "Profit credited", null, null, 0.2, { formula: "F4+E5", result: 1000.1 + 0.2 }]);
    });
    const read = lines(await readStatementFile(bytes, "meezan"));
    expect(read.lines.map((l) => [l.row, l.date, l.description, l.amount, l.balance])).toEqual([
      [4, "2026-11-02", "Cash deposit", "1000.10", "1000.10"],
      [5, "2026-11-05", "Profit credited", "0.20", "1000.30"],
    ]);
    const sheet = await readSheet(bytes);
    expect(sheet.ok && sheet.rows.slice(0, 2)).toEqual([["Meezan Bank", "", "", "", "", ""], [""]]);
  });

  it("is read from its first sheet that is shown and has anything in it", async () => {
    const bytes = await workbookBytes((workbook) => {
      workbook.addWorksheet("Hidden", { state: "hidden" }).addRow(["Date", "Description", "Amount"]);
      workbook.addWorksheet("Empty");
      sampleSheet(workbook);
    });
    expect(lines(await readStatementFile(bytes, "hbl")).lines).toHaveLength(10);
  });

  it("is refused when it is an older .xls file, or not a workbook at all, or has more than a statement's rows", async () => {
    const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Array(504).fill(0)]);
    expect(await readStatementFile(xls, "auto")).toEqual({ ok: false, problems: [expect.stringContaining("older Excel file (.xls)")] });
    const notAWorkbook = zipOf([{ name: "notes.txt", data: Buffer.from("hello") }]);
    expect(zipProblem(notAWorkbook)).toBeNull();
    expect(await readStatementFile(notAWorkbook, "auto")).toEqual({ ok: false, problems: [expect.stringContaining("could not be read")] });
    const long = await workbookBytes((workbook) => {
      const sheet = workbook.addWorksheet("Statement");
      sheet.addRow(["Date", "Description", "Amount"]);
      for (let i = 0; i < MAX_SHEET_ROWS; i++) sheet.addRow(["2026-11-05", "Line", "1"]);
    });
    expect(await readStatementFile(long, "auto")).toEqual({ ok: false, problems: [expect.stringContaining("too large")] });
  });

  it("is not opened when it unpacks to more than the ceiling, whatever its directory says", async () => {
    const bomb = zipOf([{ name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(MAX_UNPACKED_BYTES + 1) }]);
    expect(bomb.length).toBeLessThan(100_000);
    expect(zipProblem(bomb)).toContain("too large");
    const lying = zipOf([{ name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(MAX_UNPACKED_BYTES + 1), stated: 100 }]);
    expect(zipProblem(lying)).toContain("too large");
    expect(await readStatementFile(lying, "auto")).toEqual({ ok: false, problems: [expect.stringContaining("too large")] });
    // Many small parts add up.
    const many = zipOf(Array.from({ length: 5 }, (_, i) => ({ name: `xl/part${i}.xml`, data: Buffer.alloc(MAX_UNPACKED_BYTES / 4) })));
    expect(zipProblem(many)).toContain("too large");
  });

  it("is not opened when its ZIP is laid out in any way another reader might read otherwise", async () => {
    const good = await workbookBytes(sampleSheet);
    expect(zipProblem(good)).toBeNull();
    const after = new Uint8Array([...good, 0x00]);
    const before = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...good]);
    const cut = good.subarray(0, good.length - 30);
    for (const bytes of [after, before, cut]) expect(zipProblem(bytes)).toContain("could not be read");
  });
});

describe("a CSV statement as bytes", () => {
  it("is read as the same CSV text, with or without Excel's byte-order mark", async () => {
    const expected = lines(readStatement(SAMPLE, "hbl"));
    expect(lines(await readStatementFile(new TextEncoder().encode(SAMPLE), "hbl"))).toEqual(expected);
    expect(lines(await readStatementFile(new TextEncoder().encode(`﻿${SAMPLE}`), "hbl"))).toEqual(expected);
    expect(await readStatementFile(new Uint8Array([0x44, 0x61, 0x74, 0x65, 0xe9, 0x0a]), "auto")).toEqual({ ok: false, problems: [expect.stringContaining("not saved as UTF-8")] });
  });
});
