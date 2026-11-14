import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { renderSalesPdf } from "@/modules/sales-print/pdf";
import { getPrintableDocument } from "@/modules/sales-print/queries";
import { pdfFileName } from "@/modules/sales-print/rules";
import { printView } from "@/modules/sales-print/view";
import { getLogo } from "@/modules/tenant/queries";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

// The PDF of a sales document, made fresh each time from the document, which never changes once
// it has its number. Only a signed-in member who may see the document gets it; anyone else, and a
// document of another company, is simply not found.
export async function GET(_: Request, { params }: RouteContext<"/print/sales/[id]/pdf">) {
  const { id } = await params;
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.sales) return notFound();

  try {
    const [printable, logo] = await Promise.all([getPrintableDocument(session, id, session.tenantName), getLogo(session.userId, session.tenantId)]);
    if (!printable) return notFound();
    const bytes = await renderSalesPdf({ view: printView(printable), companyName: session.tenantName, productName: session.branding.productName, logo, printedAt: new Date() });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${pdfFileName(printable.document.number)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof UserError) return notFound();
    logFailure("sales document pdf", error);
    return new Response("The PDF could not be made. Try again.", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
