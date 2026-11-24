import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { renderPayslipPdf } from "@/modules/payroll-runs/pdf";
import { getPayslip, payslipFileName } from "@/modules/payroll-runs/queries";
import { can } from "@/modules/tenant/rules";
import { getLogo } from "@/modules/tenant/queries";

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });

// The PDF of a payslip, made fresh from the payslip. Only a member who reads payroll gets it;
// anyone else, and a payslip of another company, is not found.
export async function GET(_: Request, { params }: RouteContext<"/print/payslip/[id]/pdf">) {
  const { id } = await params;
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.payroll || !can(session.role, "payroll.read")) return notFound();
  try {
    const [found, logo] = await Promise.all([getPayslip(session, id), getLogo(session.userId, session.tenantId)]);
    if (!found) return notFound();
    const bytes = await renderPayslipPdf({ ...found, companyName: session.tenantName, productName: session.branding.productName, logo, printedAt: new Date() });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${payslipFileName(found.payslip.code, found.run.month)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof UserError) return notFound();
    logFailure("payslip pdf", error);
    return new Response("The PDF could not be made. Try again.", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
