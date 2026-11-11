import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { can, type MembershipSummary, type TenantContext } from "./rules";
import { auditLog, branches, invitations, memberships, tenants } from "./schema";

// Read models for the tenant screens. Every query names its tenant as well as relying on
// row-level security, so a missing policy would show up as a test failure, not a leak.

/** Every company the user is an active member of, inside a transaction the caller already has. */
export async function selectMyMemberships(tx: Tx, userId: string): Promise<MembershipSummary[]> {
  return tx
    .select({
      tenantId: memberships.tenantId,
      tenantName: tenants.name,
      role: memberships.role,
      branchIds: memberships.branchIds,
      active: memberships.active,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(eq(memberships.userId, userId), eq(memberships.active, true)))
    .orderBy(asc(memberships.createdAt));
}

/** Every company the user is an active member of. Runs before a company is selected. */
export async function listMyMemberships(userId: string): Promise<MembershipSummary[]> {
  return withTenant(userId, null, (tx) => selectMyMemberships(tx, userId));
}

/** The branches this member may work in; the database applies their branch scope. */
export async function listBranches(ctx: TenantContext) {
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name, createdAt: branches.createdAt })
      .from(branches)
      .where(eq(branches.tenantId, ctx.tenantId))
      .orderBy(asc(branches.name)),
  );
}

export async function listMembers(ctx: TenantContext) {
  if (!can(ctx.role, "member.read")) throw new UserError("Only an owner can see the members.");
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        userId: memberships.userId,
        email: memberships.email,
        role: memberships.role,
        branchIds: memberships.branchIds,
        active: memberships.active,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .where(eq(memberships.tenantId, ctx.tenantId))
      .orderBy(asc(memberships.createdAt)),
  );
}

export async function listPendingInvitations(ctx: TenantContext) {
  if (!can(ctx.role, "member.read")) throw new UserError("Only an owner can see invitations.");
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        branchIds: invitations.branchIds,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(and(eq(invitations.tenantId, ctx.tenantId), eq(invitations.status, "pending")))
      .orderBy(asc(invitations.createdAt)),
  );
}

/** The most recent audit rows, with the actor's email where the reader may see it. */
export async function listActivity(ctx: TenantContext, limit = 100) {
  if (!can(ctx.role, "audit.read")) throw new UserError("Only an owner or an auditor can see the activity log.");
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        id: auditLog.id,
        at: auditLog.at,
        actorUserId: auditLog.actorUserId,
        actorEmail: memberships.email,
        actorRole: auditLog.actorRole,
        action: auditLog.action,
        entity: auditLog.entity,
        after: auditLog.after,
      })
      .from(auditLog)
      .leftJoin(
        memberships,
        and(eq(memberships.tenantId, auditLog.tenantId), eq(memberships.userId, auditLog.actorUserId)),
      )
      .where(eq(auditLog.tenantId, ctx.tenantId))
      .orderBy(desc(auditLog.at))
      .limit(limit),
  );
}
