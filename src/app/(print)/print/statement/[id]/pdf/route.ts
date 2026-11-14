import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { getCustomerStatement } from "@/modules/recovery/queries";
import { readPeriod } from "@/modules/recovery/rules";
import { renderStatementPdf, statementFileName } from "@/modules/recovery/statement-pdf";
import { getLogo } from "@/modules/tenant/queries";
import { can } from "@/modules/tenant/rules";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

// The PDF of a customer statement, made fresh from the books. Only a signed-in member who works
// or reads recovery gets it; anyone else, and a customer of another company, is not found.
export async function GET(request: NextRequest, { params }: RouteContext<"/print/statement/[id]/pdf">) {
  const { id } = await params;
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.collections || !can(session.role, "recovery.read")) return notFound();
  try {
    const period = readPeriod(Object.fromEntries(request.nextUrl.searchParams), todayIso(new Date()));
    const [data, logo] = await Promise.all([getCustomerStatement(session, id, period), getLogo(session.userId, session.tenantId)]);
    if (!data) return notFound();
    const bytes = await renderStatementPdf({ data, companyName: session.tenantName, productName: session.branding.productName, logo, printedAt: new Date() });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${statementFileName(data)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof UserError) return notFound();
    logFailure("customer statement pdf", error);
    return new Response("The PDF could not be made. Try again.", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
