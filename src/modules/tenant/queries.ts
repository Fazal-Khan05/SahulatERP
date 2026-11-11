import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { enterTenant, isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import {
  DEFAULT_PRODUCT_NAME,
  can,
  resolveActiveMembership,
  resolveModules,
  type MembershipSummary,
  type ModuleKey,
  type ModuleState,
  type TenantContext,
} from "./rules";
import { auditLog, branches, invitations, memberships, modulesEnabled, settings, tenants } from "./schema";

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

export type Branding = {
  productName: string;
  /**
   * Where the logo is served, or null when there is none. The address names the company and the
   * logo's version, so a browser can keep it for good and can never show one company's logo, or
   * an old logo, under another's address.
   */
  logoUrl: string | null;
};

export function logoUrl(tenantId: string, updatedAt: Date): string {
  return `/branding/logo?t=${tenantId}&v=${updatedAt.getTime()}`;
}

export type Workspace = {
  memberships: MembershipSummary[];
  /** The company this request runs in, or null when the user belongs to none. */
  active: (MembershipSummary & { branding: Branding; modules: ModuleState }) | null;
};

function selectBranding(tx: Tx, tenantId: string) {
  return tx
    .select({
      productName: settings.productName,
      hasLogo: sql<boolean>`${settings.logo} is not null`,
      updatedAt: settings.updatedAt,
    })
    .from(settings)
    .where(eq(settings.tenantId, tenantId));
}

function selectSwitches(tx: Tx, tenantId: string) {
  return tx
    .select({ module: modulesEnabled.module, enabled: modulesEnabled.enabled })
    .from(modulesEnabled)
    .where(eq(modulesEnabled.tenantId, tenantId));
}

/**
 * Everything the frame of a page needs, in one transaction: the user's companies, which one this
 * request runs in, and that company's product name, logo and module switches.
 *
 * This runs on every page, so it is written for few network round trips. The company the browser
 * asked for is tried straight away, alongside the membership list; the three queries travel
 * together. That is safe because the policies check the membership themselves: for a company the
 * user does not belong to, the settings and switches simply come back empty, and the company the
 * user really belongs to is then read in a second step.
 */
export async function loadWorkspace(userId: string, preferredTenantId: string | null | undefined): Promise<Workspace> {
  const preferred = isUuid(preferredTenantId) ? preferredTenantId : null;
  return withTenant(userId, preferred, async (tx) => {
    const [all, askedBranding, askedSwitches] = await Promise.all([
      selectMyMemberships(tx, userId),
      preferred ? selectBranding(tx, preferred) : [],
      preferred ? selectSwitches(tx, preferred) : [],
    ]);
    let saved = askedBranding;
    let switches = askedSwitches;
    const membership = resolveActiveMembership(all, preferred);
    if (!membership) return { memberships: all, active: null };

    if (membership.tenantId !== preferred) {
      await enterTenant(tx, membership.tenantId);
      [saved, switches] = await Promise.all([
        selectBranding(tx, membership.tenantId),
        selectSwitches(tx, membership.tenantId),
      ]);
    }

    const choices: Partial<Record<ModuleKey, boolean>> = {};
    for (const row of switches) choices[row.module] = row.enabled;
    return {
      memberships: all,
      active: {
        ...membership,
        branding: {
          productName: saved[0]?.productName ?? DEFAULT_PRODUCT_NAME,
          logoUrl: saved[0]?.hasLogo ? logoUrl(membership.tenantId, saved[0].updatedAt) : null,
        },
        modules: resolveModules(choices),
      },
    };
  });
}

/**
 * A company's logo, for the header and printed documents. The company is named by the address,
 * not taken from the session, so a page left open in one company still gets that company's logo
 * after the user switches to another in a different tab. Row-level security returns nothing
 * unless the user is an active member of it.
 */
export async function getLogo(
  userId: string,
  tenantId: string,
): Promise<{ bytes: Uint8Array; contentType: string; version: number } | null> {
  const [row] = await withTenant(userId, tenantId, (tx) =>
    tx
      .select({ logo: settings.logo, contentType: settings.logoContentType, updatedAt: settings.updatedAt })
      .from(settings)
      .where(eq(settings.tenantId, tenantId)),
  );
  return row?.logo && row.contentType
    ? { bytes: row.logo, contentType: row.contentType, version: row.updatedAt.getTime() }
    : null;
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
  if (!can(ctx.role, "member.read")) throw new UserError("Only an owner or an auditor can see the members.");
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
  if (!can(ctx.role, "member.invite")) throw new UserError("Only an owner can see invitations.");
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
