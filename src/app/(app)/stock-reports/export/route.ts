import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { tableToCsv } from "@/modules/reports/rules";
import { getStockReport } from "@/modules/stock-reports/queries";
import { STOCK_REPORTS, isStockReportKey } from "@/modules/stock-reports/rules";
import { tableToXlsx } from "../../reports/_parts/files";
import { loadStockFilter } from "../_parts/load";

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

// Downloads a stock report as a file: /stock-reports/export?report=valuation&format=xlsx&to=...
// The same figures the screen shows, for the same reader, built again from the member's session.
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.inventory) return plain(404, "Not found");
  const query = request.nextUrl.searchParams;
  const report = query.get("report");
  const format = query.get("format");
  if (!isStockReportKey(report) || (format !== "csv" && format !== "xlsx")) return plain(404, "Not found");

  try {
    const filter = await loadStockFilter(session, Object.fromEntries(query));
    const today = todayIso(new Date());
    const table = await getStockReport(session, report, filter, today);
    const day = report === "low-stock" ? today : STOCK_REPORTS[report].period ? `${filter.from}-to-${filter.to}` : filter.to;
    const name = `${report}-${day}.${format}`;
    const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (format === "csv") return new Response(tableToCsv(table, session.tenantName), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
    const file = await tableToXlsx(table, session.tenantName);
    return new Response(new Uint8Array(file), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  } catch (error) {
    if (error instanceof UserError) return plain(404, "Not found");
    logFailure("export stock report", error);
    return plain(500, "The report could not be made. Try again.");
  }
}
