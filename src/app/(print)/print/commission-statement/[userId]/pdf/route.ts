import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { renderCommissionStatementPdf } from "@/modules/commission-statements/pdf";
import { canReadStatements, getCommissionStatement } from "@/modules/commission-statements/queries";
import { statementFileName } from "@/modules/commission-statements/rules";
import { readPeriod } from "@/modules/recovery/rules";
import { getLogo } from "@/modules/tenant/queries";

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

// The PDF of a commission statement, made fresh from the commission movements. Only a member who
// may read that person's statement gets it; anyone else, and a person of another company, is not found.
export async function GET(request: NextRequest, { params }: RouteContext<"/print/commission-statement/[userId]/pdf">) {
  const { userId } = await params;
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.commissions || !canReadStatements(session)) return notFound();
  try {
    const period = readPeriod(Object.fromEntries(request.nextUrl.searchParams), todayIso(new Date()));
    const [data, logo] = await Promise.all([getCommissionStatement(session, userId, period), getLogo(session.userId, session.tenantId)]);
    if (!data) return notFound();
    const bytes = await renderCommissionStatementPdf({
      data,
      companyName: session.tenantName,
      productName: session.branding.productName,
      logo,
      printedAt: new Date(),
    });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${statementFileName(data.person.name, data.from, data.to)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof UserError) return notFound();
    logFailure("commission statement pdf", error);
    return new Response("The PDF could not be made. Try again.", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
