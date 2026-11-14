"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { emailSalesDocument, settleEmail } from "@/modules/sales-email/commands";
import { mailSenderFromEnvironment } from "@/modules/sales-email/sender";
import { renderSalesPdf } from "@/modules/sales-print/pdf";
import { getPrintableDocument } from "@/modules/sales-print/queries";
import { pdfFileName } from "@/modules/sales-print/rules";
import { printView } from "@/modules/sales-print/view";
import { getLogo } from "@/modules/tenant/queries";

// Step 23: emailing a sales document. The company comes from the verified session; the document's
// id arrives bound to the action and is checked again in the command.

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

async function requireSales() {
  const session = await requireTenant();
  if (!session.modules.sales) throw new UserError("Sales is switched off for this company.");
  return session;
}

const SAID: Record<string, string> = {
  sent: "Sent.",
  failed: "The email service refused it. The reason is in the list below.",
  unknown: "The email service gave no clear answer, so it is not known whether it went. Ask the customer before sending it again.",
};

export async function emailSalesAction(documentId: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireSales();
    const outcome = await emailSalesDocument(session, mailSenderFromEnvironment(), { documentId, form: { to: formData.get("to"), subject: formData.get("subject"), message: formData.get("message") } }, async () => {
      const [printable, logo] = await Promise.all([getPrintableDocument(session, documentId, session.tenantName), getLogo(session.userId, session.tenantId)]);
      if (!printable) throw new UserError("That document was not found.");
      const bytes = await renderSalesPdf({ view: printView(printable), companyName: session.tenantName, productName: session.branding.productName, logo, printedAt: new Date() });
      return { filename: pdfFileName(printable.document.number), bytes };
    });
    refresh();
    return outcome === "sent" ? { ok: true, message: SAID.sent } : { error: SAID[outcome] };
  } catch (error) {
    return refusal("email sales document", error);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the form's state and fields are not needed: the answer is bound to the button
export async function settleEmailAction(emailId: string, arrived: boolean, _: FormState, __: FormData): Promise<FormState> {
  try {
    const session = await requireSales();
    await settleEmail(session, emailId, arrived);
    refresh();
    return { ok: true };
  } catch (error) {
    return refusal("settle sales document email", error);
  }
}
