import ExcelJS from "exceljs";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { getDailyChoices } from "@/modules/daily-expenses/queries";
import { SHEET_COLUMNS } from "@/modules/daily-expenses/rules";
import { can } from "@/modules/tenant/rules";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

// The sheet to fill in: its headings on the first sheet, and on a second the names this company
// may write under "What for" and "Paid from". Made for whoever may enter expenses.
export async function GET() {
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.cash_bank || !can(session.role, "cash_bank.manage")) return notFound();
  try {
    const choices = await getDailyChoices(session);
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Expenses");
    sheet.columns = [
      { header: SHEET_COLUMNS[0], width: 14, style: { numFmt: "dd/mm/yyyy" } },
      { header: SHEET_COLUMNS[1], width: 32 },
      { header: SHEET_COLUMNS[2], width: 14, style: { numFmt: "#,##0.00" } },
      { header: SHEET_COLUMNS[3], width: 28 },
      { header: SHEET_COLUMNS[4], width: 28 },
      { header: SHEET_COLUMNS[5], width: 40 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const names = book.addWorksheet("Names to use");
    names.columns = [
      { header: "What for: your expense accounts", width: 40 },
      { header: "Paid from: your cash and bank accounts", width: 40 },
    ];
    names.getRow(1).font = { bold: true };
    const rows = Math.max(choices.expenseAccounts.length, choices.moneyAccounts.length);
    for (let i = 0; i < rows; i++) names.addRow([choices.expenseAccounts[i]?.name ?? "", choices.moneyAccounts[i]?.name ?? ""]);
    const bytes = await book.xlsx.writeBuffer();
    return new Response(bytes as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="daily-expenses.xlsx"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof UserError) return notFound();
    logFailure("expense sheet template", error);
    return new Response("The template could not be made. Try again.", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
