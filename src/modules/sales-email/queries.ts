import "server-only";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { contacts } from "@/modules/parties/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { isEmailStatus, type EmailStatus } from "./rules";
import { salesDocumentEmails } from "./schema";

export type DocumentEmail = { id: string; toAddress: string; subject: string; status: EmailStatus; error: string | null; createdAt: Date; createdBy: string; finishedAt: Date | null };

/** The emails of one document, oldest first. The database shows only those of documents this member can see. */
export async function listDocumentEmails(ctx: TenantContext, documentId: string): Promise<DocumentEmail[]> {
  if (!isUuid(documentId)) return [];
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        id: salesDocumentEmails.id,
        toAddress: salesDocumentEmails.toAddress,
        subject: salesDocumentEmails.subject,
        status: salesDocumentEmails.status,
        error: salesDocumentEmails.error,
        createdAt: salesDocumentEmails.createdAt,
        createdBy: salesDocumentEmails.createdBy,
        finishedAt: salesDocumentEmails.finishedAt,
      })
      .from(salesDocumentEmails)
      .where(and(eq(salesDocumentEmails.tenantId, ctx.tenantId), eq(salesDocumentEmails.documentId, documentId)))
      .orderBy(asc(salesDocumentEmails.createdAt)),
  );
  return rows.flatMap((row) => (isEmailStatus(row.status) ? [{ ...row, status: row.status }] : []));
}

/** Where a customer's documents go by default: the primary contact's email, or any contact's. Null when none, or when this member may not read contacts. */
export async function getCustomerEmail(ctx: TenantContext, customerId: string): Promise<string | null> {
  if (!can(ctx.role, "customer.read") || !isUuid(customerId)) return null;
  const [row] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.tenantId, ctx.tenantId), eq(contacts.customerId, customerId), isNotNull(contacts.email)))
      .orderBy(desc(contacts.isPrimary), asc(contacts.createdAt))
      .limit(1),
  );
  return row?.email ?? null;
}
