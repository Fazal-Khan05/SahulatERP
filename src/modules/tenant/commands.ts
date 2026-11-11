import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { audit, enterTenant, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { selectMyMemberships } from "./queries";
import {
  branchNameSchema,
  can,
  companyNameSchema,
  firstIssue,
  inviteSchema,
  type MembershipSummary,
  type TenantContext,
} from "./rules";
import { branches, invitations, memberships } from "./schema";

// The transactional handlers. Each one checks the role, makes its change and writes its audit
// row in a single transaction, so neither is ever stored without the other.

const UNIQUE_VIOLATION = "23505";

/** Creates a company and makes the user its owner. Returns the new tenant id. */
export async function createCompany(user: { id: string; email: string }, rawName: unknown): Promise<string> {
  const name = companyNameSchema.safeParse(rawName);
  if (!name.success) throw new UserError(firstIssue(name.error));
  return withTenant(user.id, null, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`select app.create_tenant(${name.data}, ${user.email}) as id`);
    const tenantId = rows[0].id;
    // The rest of this transaction runs inside the new company, so its first audit row is its own.
    await enterTenant(tx, tenantId);
    await audit(
      tx,
      { userId: user.id, tenantId, role: "owner" },
      { action: "tenant.create", entity: "tenant", entityId: tenantId, after: { name: name.data } },
    );
    return tenantId;
  });
}

export async function createBranch(ctx: TenantContext, rawName: unknown): Promise<{ id: string; name: string }> {
  if (!can(ctx.role, "branch.create")) throw new UserError("Only an owner can add a branch.");
  const name = branchNameSchema.safeParse(rawName);
  if (!name.success) throw new UserError(firstIssue(name.error));
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(branches)
        .values({ tenantId: ctx.tenantId, name: name.data, createdBy: ctx.userId })
        .returning({ id: branches.id, name: branches.name });
      await audit(tx, ctx, { action: "branch.create", entity: "branch", entityId: row.id, after: { name: row.name } });
      return row;
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError("A branch with this name already exists.");
    throw error;
  }
}

/**
 * Records an invitation. The account itself is created by `npm run invites:send`, which holds the
 * service-role key; the web app never does.
 */
export async function inviteMember(ctx: TenantContext, raw: unknown): Promise<{ id: string }> {
  if (!can(ctx.role, "member.invite")) throw new UserError("Only an owner can invite members.");
  const input = inviteSchema.safeParse(raw);
  if (!input.success) throw new UserError(firstIssue(input.error));
  const { email, role, branchIds } = input.data;
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      if (branchIds) {
        // Only this company's branches come back, so an id from another company is simply not found.
        const found = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.tenantId, ctx.tenantId), inArray(branches.id, branchIds)));
        if (found.length !== new Set(branchIds).size) throw new UserError("Choose branches from this company.");
      }
      const existing = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.tenantId, ctx.tenantId), eq(memberships.email, email)));
      if (existing.length > 0) throw new UserError("This person is already a member.");
      const [row] = await tx
        .insert(invitations)
        .values({ tenantId: ctx.tenantId, email, role, branchIds, createdBy: ctx.userId })
        .returning({ id: invitations.id });
      await audit(tx, ctx, {
        action: "member.invite",
        entity: "invitation",
        entityId: row.id,
        after: { email, role, branchIds },
      });
      return row;
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new UserError("This person already has a pending invitation.");
    throw error;
  }
}

export type AuthEvent = "auth.sign_in" | "auth.sign_out" | "auth.password_set";

/**
 * Writes a sign-in, sign-out or password change to the audit log of every company the user is an
 * active member of, in one transaction: every company gets its row or none does. A user with no
 * company yet has no log to write to.
 */
export async function recordAuthEvent(
  userId: string,
  action: AuthEvent,
  detail?: { method: "password" | "recovery" | "invite" },
): Promise<MembershipSummary[]> {
  return withTenant(userId, null, async (tx) => {
    const active = await selectMyMemberships(tx, userId);
    for (const membership of active) {
      await enterTenant(tx, membership.tenantId);
      await audit(
        tx,
        { userId, tenantId: membership.tenantId, role: membership.role },
        { action, entity: "user", entityId: userId, after: detail ?? null },
      );
    }
    return active;
  });
}
