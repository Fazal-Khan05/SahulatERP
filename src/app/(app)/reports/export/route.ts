import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { LEDGER_FILE } from "@/modules/reports/queries";
import { isReportKey, tableToCsv } from "@/modules/reports/rules";
import { tableToXlsx } from "../_parts/files";
import { loadFilter, loadReport } from "../_parts/load";

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

// Downloads a report as a file: /reports/export?report=trial-balance&format=xlsx&from=...&to=...
// The same figures the screen shows, for the same reader: the report is built again here from
// the signed-in member's own session, never from anything in the address but the period asked for.
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session) return plain(404, "Not found");
  const query = request.nextUrl.searchParams;
  const report = query.get("report");
  const format = query.get("format");
  if (!isReportKey(report) || (format !== "csv" && format !== "xlsx")) return plain(404, "Not found");

  try {
    const filter = await loadFilter(session, { from: query.get("from"), to: query.get("to"), branch: query.get("branch"), account: query.get("account") });
    const table = await loadReport(session, report, filter, LEDGER_FILE);
    if (!table) return plain(404, "Not found");
    const name = `${report}-${report === "balance-sheet" ? filter.to : `${filter.from}-to-${filter.to}`}.${format}`;
    const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (format === "csv") return new Response(tableToCsv(table, session.tenantName), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
    const file = await tableToXlsx(table, session.tenantName);
    return new Response(new Uint8Array(file), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  } catch (error) {
    if (error instanceof UserError) return plain(404, "Not found");
    logFailure("export report", error);
    return plain(500, "The report could not be made. Try again.");
  }
}
