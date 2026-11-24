import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { getReturnStanding, getTaxReturn } from "@/modules/tax-return/queries";
import { annexCsv, annexTable, isAnnexKey, readReturnPeriod } from "@/modules/tax-return/rules";
import { annexToXlsx } from "../_parts/files";

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

// Downloads one annex of a month's return as a sheet for upload:
// /tax-return/export?annex=annex-c&month=2026-11&format=xlsx
// The same rows the screen shows, for the same reader, built again from the member's session.
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session) return plain(404, "Not found");
  const query = request.nextUrl.searchParams;
  const annex = query.get("annex");
  const format = query.get("format");
  if (!isAnnexKey(annex) || (format !== "csv" && format !== "xlsx")) return plain(404, "Not found");

  try {
    if (!(await getReturnStanding(session)).registered) return plain(404, "Not found");
    const period = readReturnPeriod(query.get("month"), todayIso(new Date()));
    const table = annexTable(await getTaxReturn(session, period), annex);
    const name = `${annex}-${period.month}.${format}`;
    const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (format === "csv") return new Response(annexCsv(table), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
    const file = await annexToXlsx(table);
    return new Response(new Uint8Array(file), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  } catch (error) {
    if (error instanceof UserError) return plain(404, "Not found");
    logFailure("export sales tax annex", error);
    return plain(500, "The annex could not be made. Try again.");
  }
}
