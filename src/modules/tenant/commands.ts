import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { audit, enterTenant, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { selectMyMemberships } from "./queries";
import {
  MODULES,
  branchNameSchema,
  can,
  checkLogo,
  checkModuleChange,
  companyNameSchema,
  firstIssue,
  inviteSchema,
  productNameSchema,
  resolveModules,
  type MembershipSummary,
  type ModuleKey,
  type TenantContext,
} from "./rules";
import { branches, invitations, memberships, modulesEnabled, settings } from "./schema";

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

/**
 * Saves what the company calls the product and, optionally, its logo.
 * `logo`: bytes to set a new one, null to remove it, undefined to leave it alone.
 */
export async function updateBranding(
  ctx: TenantContext,
  input: { productName: unknown; logo?: Uint8Array | null },
): Promise<void> {
  if (!can(ctx.role, "branding.update")) throw new UserError("Only an owner can change these settings.");
  const name = productNameSchema.safeParse(input.productName);
  if (!name.success) throw new UserError(firstIssue(name.error));

  let logo: { logo: Uint8Array | null; logoContentType: string | null } | undefined;
  if (input.logo === null) logo = { logo: null, logoContentType: null };
  if (input.logo instanceof Uint8Array) {
    const checked = checkLogo(input.logo);
    if (!checked.ok) throw new UserError(checked.reason);
    logo = { logo: input.logo, logoContentType: checked.contentType };
  }

  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: settings.id, productName: settings.productName, hasLogo: sql<boolean>`${settings.logo} is not null` })
      .from(settings)
      .where(eq(settings.tenantId, ctx.tenantId));

    let id: string;
    if (existing) {
      id = existing.id;
      await tx
        .update(settings)
        .set({ productName: name.data, ...logo, updatedAt: sql`now()`, updatedBy: ctx.userId })
        .where(eq(settings.tenantId, ctx.tenantId));
    } else {
      const [row] = await tx
        .insert(settings)
        .values({ tenantId: ctx.tenantId, productName: name.data, ...logo, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning({ id: settings.id });
      id = row.id;
    }
    const hadLogo = existing?.hasLogo ?? false;
    // The audit row says whether there is a logo, never the image itself.
    await audit(tx, ctx, {
      action: "settings.update",
      entity: "settings",
      entityId: id,
      before: existing ? { productName: existing.productName, logo: hadLogo } : null,
      after: { productName: name.data, logo: logo ? logo.logo !== null : hadLogo },
    });
  });
}

/** Switches a module on or off for the company, within the dependency rules. */
export async function setModuleEnabled(ctx: TenantContext, rawModule: unknown, enabled: boolean): Promise<void> {
  if (!can(ctx.role, "module.update")) throw new UserError("Only an owner can switch modules.");
  if (typeof rawModule !== "string" || !(MODULES as readonly string[]).includes(rawModule)) {
    throw new UserError("That module does not exist.");
  }
  const key = rawModule as ModuleKey;

  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: modulesEnabled.id, module: modulesEnabled.module, enabled: modulesEnabled.enabled })
      .from(modulesEnabled)
      .where(eq(modulesEnabled.tenantId, ctx.tenantId));
    const choices: Partial<Record<ModuleKey, boolean>> = {};
    for (const row of rows) choices[row.module] = row.enabled;
    const state = resolveModules(choices);

    if (state[key] === enabled) return; // Already so; nothing to change or record.
    const verdict = checkModuleChange(state, key, enabled);
    if (!verdict.ok) throw new UserError(verdict.reason);

    const existing = rows.find((row) => row.module === key);
    let id: string;
    if (existing) {
      id = existing.id;
      await tx
        .update(modulesEnabled)
        .set({ enabled, updatedAt: sql`now()`, updatedBy: ctx.userId })
        .where(and(eq(modulesEnabled.tenantId, ctx.tenantId), eq(modulesEnabled.module, key)));
    } else {
      const [row] = await tx
        .insert(modulesEnabled)
        .values({ tenantId: ctx.tenantId, module: key, enabled, createdBy: ctx.userId, updatedBy: ctx.userId })
        .returning({ id: modulesEnabled.id });
      id = row.id;
    }
    await audit(tx, ctx, {
      action: "module.update",
      entity: "module",
      entityId: id,
      before: { module: key, enabled: !enabled },
      after: { module: key, enabled },
    });
  });
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
