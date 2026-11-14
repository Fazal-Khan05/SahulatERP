import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { listDocumentEmails } from "@/modules/sales-email/queries";
import type { SalesDocument } from "@/modules/sales/queries";
import { isSalesKind, type SalesStatus } from "@/modules/sales/rules";
import { salesDocumentLinks, salesDocuments } from "@/modules/sales/schema";
import { memberships } from "@/modules/tenant/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { buildTimeline, type TimelineEvent } from "./rules";

/**
 * What happened to a sales document the member has already opened, oldest first. Members are
 * named by email where this member may see them (their own, the sales team, or everyone for an
 * owner or an auditor), and as "another member" otherwise.
 */
export async function getTimeline(ctx: TenantContext & { email: string }, document: Pick<SalesDocument, "id" | "kind" | "source"> & { madeFrom: { kind: SalesDocument["kind"]; number: string | null }[] }): Promise<TimelineEvent[]> {
  const [facts, emails] = await Promise.all([
    withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [row] = await tx
        .select({
          createdAt: salesDocuments.createdAt,
          createdBy: salesDocuments.createdBy,
          heldAt: salesDocuments.heldAt,
          heldBy: salesDocuments.heldBy,
          submittedAt: salesDocuments.submittedAt,
          submittedBy: salesDocuments.submittedBy,
          overrideBy: salesDocuments.creditOverrideBy,
          overrideReason: salesDocuments.creditOverrideReason,
          cancelledAt: salesDocuments.cancelledAt,
          cancelledBy: salesDocuments.cancelledBy,
          cancelReason: salesDocuments.cancelReason,
        })
        .from(salesDocuments)
        .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, document.id)));
      const [into, members, team] = await Promise.all([
        tx
          .select({ id: salesDocuments.id, kind: salesDocuments.kind, number: salesDocuments.number, status: salesDocuments.status, createdAt: salesDocuments.createdAt })
          .from(salesDocumentLinks)
          .innerJoin(salesDocuments, and(eq(salesDocuments.tenantId, salesDocumentLinks.tenantId), eq(salesDocuments.id, salesDocumentLinks.toDocumentId)))
          .where(and(eq(salesDocumentLinks.tenantId, ctx.tenantId), eq(salesDocumentLinks.fromDocumentId, document.id)))
          .orderBy(asc(salesDocuments.createdAt)),
        // The database shows a member their own membership, and an owner or an auditor everyone's.
        tx.select({ userId: memberships.userId, email: memberships.email }).from(memberships).where(eq(memberships.tenantId, ctx.tenantId)),
        can(ctx.role, "sales.read") ? tx.execute<{ user_id: string; email: string }>(sql`select user_id, email from app.sales_people()`) : Promise.resolve([]),
      ]);
      return { row, into, members, team };
    }),
    listDocumentEmails(ctx, document.id),
  ]);
  if (!facts.row) return [];

  const names = new Map<string, string>();
  for (const member of facts.members) names.set(member.userId, member.email);
  for (const member of facts.team) names.set(member.user_id, member.email);
  names.set(ctx.userId, `you (${ctx.email})`);
  const nameOf = (userId: string) => names.get(userId) ?? "Another member";

  const from = document.source ?? document.madeFrom[0] ?? null;
  return buildTimeline(
    {
      kind: document.kind,
      ...facts.row,
      madeFrom: from ? { kind: from.kind, number: from.number } : null,
      madeInto: facts.into.flatMap((into) => (isSalesKind(into.kind) ? [{ id: into.id, kind: into.kind, number: into.number, status: into.status as SalesStatus, createdAt: into.createdAt }] : [])),
      emails: emails.map((email) => ({ id: email.id, at: email.finishedAt ?? email.createdAt, by: email.createdBy, to: email.toAddress, status: email.status, error: email.error })),
    },
    nameOf,
  );
}
