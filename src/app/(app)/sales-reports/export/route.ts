import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { tableToCsv } from "@/modules/reports/rules";
import { getSalesReport } from "@/modules/sales-reports/queries";
import { isSalesReportKey } from "@/modules/sales-reports/rules";
import { tableToXlsx } from "../../reports/_parts/files";
import { loadSalesFilter } from "../_parts/load";

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

// Downloads a sales report as a file: /sales-reports/export?report=sales-by-customer&format=xlsx&from=...&to=...
// The same figures the screen shows, for the same reader, built again from the member's session.
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.sales) return plain(404, "Not found");
  const query = request.nextUrl.searchParams;
  const report = query.get("report");
  const format = query.get("format");
  if (!isSalesReportKey(report) || (format !== "csv" && format !== "xlsx")) return plain(404, "Not found");

  try {
    const filter = await loadSalesFilter(session, Object.fromEntries(query));
    const table = await getSalesReport(session, report, filter);
    const headers = { "Content-Disposition": `attachment; filename="${report}-${filter.from}-to-${filter.to}.${format}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (format === "csv") return new Response(tableToCsv(table, session.tenantName), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
    const file = await tableToXlsx(table, session.tenantName);
    return new Response(new Uint8Array(file), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  } catch (error) {
    if (error instanceof UserError) return plain(404, "Not found");
    logFailure("export sales report", error);
    return plain(500, "The report could not be made. Try again.");
  }
}
