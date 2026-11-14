import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { audit, isUuid, withTenant } from "@/db";
import { UserError, logFailure } from "@/lib/errors";
import { salesDocuments } from "@/modules/sales/schema";
import { can, firstIssue, type TenantContext } from "@/modules/tenant/rules";
import { SENDING_GRACE_MS, emailFormSchema, failureWords, type EmailStatus, type MailSender, type SendResult } from "./rules";
import { salesDocumentEmails } from "./schema";

const NOT_SET_UP = "Email is not set up yet. Download the PDF and send it yourself for now.";

/**
 * Emails a sales document to a customer, with its PDF attached.
 *
 * The email service is outside the database, so the intent is written first (a row marked
 * "sending", with its audit row), the service is called, and the outcome is written after. An
 * earlier email of the same document whose outcome is not known is settled first: the service is
 * asked what became of it, and while nobody can say, the document is not sent again.
 */
export async function emailSalesDocument(
  ctx: TenantContext & { email?: string | null },
  sender: MailSender | null,
  input: { documentId: string; form: { to: unknown; subject: unknown; message: unknown } },
  makePdf: () => Promise<{ filename: string; bytes: Uint8Array }>,
  now: () => Date = () => new Date(),
): Promise<EmailStatus> {
  if (!can(ctx.role, "sales.email")) throw new UserError("Your role cannot email sales documents.");
  const form = emailFormSchema.safeParse(input.form);
  if (!form.success) throw new UserError(firstIssue(form.error));
  if (!sender) throw new UserError(NOT_SET_UP);
  if (!isUuid(input.documentId)) throw new UserError("That document was not found.");

  const [document] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ status: salesDocuments.status, number: salesDocuments.number })
      .from(salesDocuments)
      .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, input.documentId))),
  );
  if (!document) throw new UserError("That document was not found.");
  if (document.status !== "submitted" || document.number === null) throw new UserError("Only a document that has its number, and is not cancelled, can be emailed.");

  await settleOpenEmails(ctx, sender, input.documentId, now());

  const pdf = await makePdf();
  const id = randomUUID();
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    await tx.insert(salesDocumentEmails).values({ id, tenantId: ctx.tenantId, documentId: input.documentId, toAddress: form.data.to, subject: form.data.subject, createdBy: ctx.userId });
    await audit(tx, ctx, { action: "sales_document.email", entity: "sales_document", entityId: input.documentId, after: { emailId: id, number: document.number, to: form.data.to, subject: form.data.subject } });
  });

  let result: SendResult;
  try {
    result = await sender.send(
      { to: form.data.to, subject: form.data.subject, text: form.data.message, replyTo: ctx.email ?? null, attachment: { filename: pdf.filename, content: pdf.bytes, contentType: "application/pdf" } },
      id,
    );
  } catch (error) {
    // The message may have been handed over before the connection failed.
    logFailure("email sales document", error);
    result = { outcome: "unknown", reason: "The connection to the email service failed part-way." };
  }
  await recordOutcome(ctx, sender.provider, input.documentId, id, result);
  return result.outcome;
}

/** Writes what the service said about one email, with its audit row. */
async function recordOutcome(ctx: TenantContext, provider: string, documentId: string, emailId: string, result: SendResult): Promise<void> {
  const outcome = {
    status: result.outcome,
    provider,
    providerMessageId: result.outcome === "sent" ? result.messageId.slice(0, 200) || null : null,
    error: result.outcome === "sent" ? null : failureWords(result.reason),
  };
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const marked = await tx
      .update(salesDocumentEmails)
      .set({ ...outcome, finishedAt: sql`now()`, finishedBy: ctx.userId })
      .where(and(eq(salesDocumentEmails.tenantId, ctx.tenantId), eq(salesDocumentEmails.id, emailId), inArray(salesDocumentEmails.status, ["sending", "unknown"])))
      .returning({ id: salesDocumentEmails.id });
    // Nothing marked means this member lost the right to the document while it was being sent.
    if (marked.length === 0) throw new UserError("The email was handed to the email service, but what happened could not be recorded. Look at the document again.");
    await audit(tx, ctx, { action: "sales_document.email_outcome", entity: "sales_document", entityId: documentId, after: { emailId, ...outcome } });
  });
}

/**
 * Settles the document's emails whose outcome is not known. One being sent right now stops a
 * second; one interrupted, or one the service could not account for, is asked about; one still
 * unaccounted for stops the document being sent again until a member says what happened.
 */
async function settleOpenEmails(ctx: TenantContext, sender: MailSender, documentId: string, at: Date): Promise<void> {
  const open = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: salesDocumentEmails.id, status: salesDocumentEmails.status, provider: salesDocumentEmails.provider, toAddress: salesDocumentEmails.toAddress, createdAt: salesDocumentEmails.createdAt })
      .from(salesDocumentEmails)
      .where(and(eq(salesDocumentEmails.tenantId, ctx.tenantId), eq(salesDocumentEmails.documentId, documentId), inArray(salesDocumentEmails.status, ["sending", "unknown"])))
      .orderBy(asc(salesDocumentEmails.createdAt)),
  );
  for (const email of open) {
    if (email.status === "sending" && at.getTime() - email.createdAt.getTime() < SENDING_GRACE_MS) {
      throw new UserError("This document is being emailed right now. Wait a minute, then look at the document again.");
    }
    // Another service cannot answer for a message it never saw.
    let answer: SendResult | null = null;
    if (email.provider === null || email.provider === sender.provider) {
      try {
        answer = await sender.lookup(email.id);
      } catch (error) {
        logFailure("look up sales document email", error);
      }
    }
    if (answer && answer.outcome !== "unknown") {
      await recordOutcome(ctx, sender.provider, documentId, email.id, answer);
    } else {
      if (email.status === "sending") {
        await recordOutcome(ctx, email.provider ?? sender.provider, documentId, email.id, { outcome: "unknown", reason: "Sending was interrupted, and the email service cannot say whether it went." });
      }
      throw new UserError(`An earlier email of this document, to ${email.toAddress}, may or may not have arrived, and the email service cannot say. Ask the customer, then mark it as arrived or not before sending it again.`);
    }
  }
}

/** A member says what became of an email whose outcome was not known: it arrived, or it did not. */
export async function settleEmail(ctx: TenantContext, emailId: string, arrived: boolean): Promise<void> {
  if (!can(ctx.role, "sales.email")) throw new UserError("Your role cannot email sales documents.");
  if (!isUuid(emailId)) throw new UserError("That email was not found.");
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [email] = await tx
      .update(salesDocumentEmails)
      .set({ status: arrived ? "sent" : "failed", error: arrived ? null : "A member said it did not arrive.", finishedAt: sql`now()`, finishedBy: ctx.userId })
      .where(and(eq(salesDocumentEmails.tenantId, ctx.tenantId), eq(salesDocumentEmails.id, emailId), eq(salesDocumentEmails.status, "unknown")))
      .returning({ documentId: salesDocumentEmails.documentId });
    if (!email) throw new UserError("That email is no longer waiting for an answer. Look at the document again.");
    await audit(tx, ctx, { action: "sales_document.email_settle", entity: "sales_document", entityId: email.documentId, after: { emailId, arrived } });
  });
}
