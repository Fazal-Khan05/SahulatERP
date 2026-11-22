import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { getPurchaseReport } from "@/modules/purchase-reports/queries";
import { PURCHASE_REPORTS, isPurchaseReportKey } from "@/modules/purchase-reports/rules";
import { tableToCsv } from "@/modules/reports/rules";
import { tableToXlsx } from "../../reports/_parts/files";
import { loadPurchaseFilter } from "../_parts/load";

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

// Downloads a buying report as a file: /purchase-reports/export?report=aged-payables&format=xlsx&to=...
// The same figures the screen shows, for the same reader, built again from the member's session.
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.purchasing) return plain(404, "Not found");
  const query = request.nextUrl.searchParams;
  const report = query.get("report");
  const format = query.get("format");
  if (!isPurchaseReportKey(report) || (format !== "csv" && format !== "xlsx")) return plain(404, "Not found");

  try {
    const filter = await loadPurchaseFilter(session, Object.fromEntries(query));
    const table = await getPurchaseReport(session, report, filter);
    const about = PURCHASE_REPORTS[report];
    const day = !about.dated ? todayIso(new Date()) : about.period ? `${filter.from}-to-${filter.to}` : filter.to;
    const name = `${report}-${day}.${format}`;
    const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (format === "csv") return new Response(tableToCsv(table, session.tenantName), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
    const file = await tableToXlsx(table, session.tenantName);
    return new Response(new Uint8Array(file), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  } catch (error) {
    if (error instanceof UserError) return plain(404, "Not found");
    logFailure("export buying report", error);
    return plain(500, "The report could not be made. Try again.");
  }
}
