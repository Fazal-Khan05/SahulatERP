import ExcelJS from "exceljs";
import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { IMPORT_KINDS, isDataImportKind, templateHeadings } from "@/modules/data-import/rules";
import { can } from "@/modules/tenant/rules";

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

// Step 49: the template a kind of file is imported from: /settings/import/customers/template?format=xlsx.
// Our headings, in order, and nothing else: no company's data is in it.
export async function GET(request: NextRequest, { params }: RouteContext<"/settings/import/[kind]/template">) {
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  const { kind } = await params;
  const format = request.nextUrl.searchParams.get("format");
  if (!session || !can(session.role, "opening.manage") || !isDataImportKind(kind) || (format !== "csv" && format !== "xlsx")) return plain(404, "Not found");
  const about = IMPORT_KINDS[kind];
  const headings = templateHeadings(about);
  const name = `${kind.replace(/_/g, "-")}-template.${format}`;
  const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (format === "csv") {
    // With Excel's byte-order mark, so that Excel opens it as UTF-8.
    return new Response(`﻿${headings.map(csvCell).join(",")}\r\n`, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
  }
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(about.title.slice(0, 31));
  sheet.addRow(headings).font = { bold: true };
  sheet.columns.forEach((column) => (column.width = 20));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const notes = book.addWorksheet("Columns");
  notes.addRow(["Column", "Needed"]).font = { bold: true };
  for (const column of about.columns) notes.addRow([column.header, column.required ? "Yes" : "No"]);
  notes.getColumn(1).width = 24;
  const file = await book.xlsx.writeBuffer();
  return new Response(new Uint8Array(file as ArrayBuffer), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
}
