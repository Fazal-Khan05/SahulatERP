import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { getAnnualStatement } from "@/modules/staff-loans/queries";
import { can } from "@/modules/tenant/rules";

const plain = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });

// Step 42. The year's salary statement (s.149) as a file: /payroll/annual/export?year=2026 for
// the tax year from July 2026. Built from the signed-in member's own session; a member who does
// not read payroll, or a company with payroll switched off, is not found.
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.payroll || !can(session.role, "payroll.read")) return plain(404, "Not found");
  const year = Number(request.nextUrl.searchParams.get("year"));
  try {
    const { csv } = await getAnnualStatement(session, year);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="salary-statement-${year}-${String(year + 1).slice(2)}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof UserError) return plain(404, "Not found");
    logFailure("salary statement", error);
    return plain(500, "The statement could not be made. Try again.");
  }
}
