import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { listCustomerAgeing } from "@/modules/recovery/queries";
import { ageingTable } from "@/modules/recovery/rules";
import { tableToCsv } from "@/modules/reports/rules";
import { can } from "@/modules/tenant/rules";
import { tableToXlsx } from "../../../reports/_parts/files";

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

// Downloads the aged receivables as a file: the same rows the screen shows, for the same reader.
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.collections || !can(session.role, "recovery.read")) return plain(404, "Not found");
  const format = request.nextUrl.searchParams.get("format");
  if (format !== "csv" && format !== "xlsx") return plain(404, "Not found");
  try {
    const today = todayIso(new Date());
    const table = ageingTable(await listCustomerAgeing(session, today), today);
    const headers = { "Content-Disposition": `attachment; filename="aged-receivables-${today}.${format}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (format === "csv") return new Response(tableToCsv(table, session.tenantName), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
    const file = await tableToXlsx(table, session.tenantName);
    return new Response(new Uint8Array(file), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  } catch (error) {
    if (error instanceof UserError) return plain(404, "Not found");
    logFailure("export aged receivables", error);
    return plain(500, "The report could not be made. Try again.");
  }
}
