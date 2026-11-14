import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { readPlan, type RawPlan } from "./rules";
import { commissionPlanRates, commissionPlanTiers, commissionPlans, salesHierarchy } from "./schema";

// Commission plans and the sales hierarchy (Step 37). Only the owner writes them; the database
// checks it again, refuses overlapping dates and circles, and every command writes an audit row.

function requireOwner(ctx: TenantContext): void {
  if (!can(ctx.role, "commission.manage")) throw new UserError("Only the owner can set up commission plans.");
}

/** Turns the database's refusals into words. */
function refused(error: unknown): never {
  const code = pgCode(error);
  if (code === "SE301") throw new UserError("Commission plan dates overlap.");
  if (code === "SE302") throw new UserError("The sales hierarchy cannot contain a cycle.");
  if (code === "23503") throw new UserError("That person or category is not part of this company.");
  throw error;
}

/** Creates a plan (`id` null) or replaces one, with its category or class rates and its slabs. */
export async function savePlan(ctx: TenantContext, id: string | null, raw: RawPlan): Promise<{ id: string }> {
  requireOwner(ctx);
  if (id !== null && !isUuid(id)) throw new UserError("That plan was not found.");
  const read = readPlan(raw);
  if (!read.ok) throw new UserError(read.reason);
  const plan = read.draft;
  const values = {
    name: plan.name,
    userId: plan.userId,
    kind: plan.kind,
    rate: plan.rate.toFixed(4),
    target: plan.target.toFixed(4),
    multiplier: plan.multiplier.toFixed(4),
    teamRate: plan.teamRate.toFixed(4),
    effectiveFrom: plan.from,
    effectiveTo: plan.to,
    updatedBy: ctx.userId,
    updatedAt: sql`now()`,
  };
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      let planId: string;
      let before: unknown = null;
      if (id === null) {
        const [row] = await tx.insert(commissionPlans).values({ ...values, tenantId: ctx.tenantId, createdBy: ctx.userId }).returning({ id: commissionPlans.id });
        planId = row.id;
      } else {
        const [old] = await tx.select().from(commissionPlans).where(and(eq(commissionPlans.tenantId, ctx.tenantId), eq(commissionPlans.id, id)));
        if (!old) throw new UserError("That plan was not found.");
        before = old;
        await tx.update(commissionPlans).set(values).where(and(eq(commissionPlans.tenantId, ctx.tenantId), eq(commissionPlans.id, id)));
        await tx.delete(commissionPlanRates).where(and(eq(commissionPlanRates.tenantId, ctx.tenantId), eq(commissionPlanRates.planId, id)));
        await tx.delete(commissionPlanTiers).where(and(eq(commissionPlanTiers.tenantId, ctx.tenantId), eq(commissionPlanTiers.planId, id)));
        planId = id;
      }
      const rates = [
        ...plan.categoryRates.map((r) => ({ tenantId: ctx.tenantId, planId, categoryId: r.categoryId, customerClass: null, rate: r.rate.toFixed(4) })),
        ...plan.classRates.map((r) => ({ tenantId: ctx.tenantId, planId, categoryId: null, customerClass: r.customerClass, rate: r.rate.toFixed(4) })),
      ];
      if (rates.length > 0) await tx.insert(commissionPlanRates).values(rates);
      if (plan.tiers.length > 0) await tx.insert(commissionPlanTiers).values(plan.tiers.map((t) => ({ tenantId: ctx.tenantId, planId, threshold: t.threshold.toFixed(4), rate: t.rate.toFixed(4) })));
      await audit(tx, ctx, {
        action: id === null ? "commission_plan.create" : "commission_plan.update",
        entity: "commission_plan",
        entityId: planId,
        before,
        after: { ...values, updatedAt: undefined, categoryRates: plan.categoryRates.map((r) => [r.categoryId, r.rate.toFixed()]), classRates: plan.classRates.map((r) => [r.customerClass, r.rate.toFixed()]), tiers: plan.tiers.map((t) => [t.threshold.toFixed(), t.rate.toFixed()]) },
      });
      return { id: planId };
    });
  } catch (error) {
    if (error instanceof UserError) throw error;
    refused(error);
  }
}

/** Removes a plan set up by mistake. Once Step 38 has accrued on it, the database keeps it. */
export async function deletePlan(ctx: TenantContext, id: string): Promise<void> {
  requireOwner(ctx);
  if (!isUuid(id)) throw new UserError("That plan was not found.");
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [gone] = await tx.delete(commissionPlans).where(and(eq(commissionPlans.tenantId, ctx.tenantId), eq(commissionPlans.id, id))).returning();
      if (!gone) throw new UserError("That plan was not found.");
      await audit(tx, ctx, { action: "commission_plan.delete", entity: "commission_plan", entityId: id, before: gone });
    });
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (pgCode(error) === "23503") throw new UserError("Commission has been worked out on this plan, so it is kept. End it with a date instead.");
    throw error;
  }
}

/** Says who a member reports to; `managerUserId` null takes their manager away. */
export async function setManager(ctx: TenantContext, userId: string, managerUserId: string | null): Promise<void> {
  requireOwner(ctx);
  if (!isUuid(userId) || (managerUserId !== null && !isUuid(managerUserId))) throw new UserError("Choose the member and their manager.");
  if (managerUserId === userId) throw new UserError("The sales hierarchy cannot contain a cycle.");
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [before] = await tx.select({ managerUserId: salesHierarchy.managerUserId }).from(salesHierarchy).where(and(eq(salesHierarchy.tenantId, ctx.tenantId), eq(salesHierarchy.userId, userId)));
      if (managerUserId === null) {
        await tx.delete(salesHierarchy).where(and(eq(salesHierarchy.tenantId, ctx.tenantId), eq(salesHierarchy.userId, userId)));
      } else if (before) {
        await tx.update(salesHierarchy).set({ managerUserId, updatedBy: ctx.userId, updatedAt: sql`now()` }).where(and(eq(salesHierarchy.tenantId, ctx.tenantId), eq(salesHierarchy.userId, userId)));
      } else {
        await tx.insert(salesHierarchy).values({ tenantId: ctx.tenantId, userId, managerUserId, createdBy: ctx.userId, updatedBy: ctx.userId });
      }
      await audit(tx, ctx, { action: "sales_hierarchy.set", entity: "membership", entityId: userId, before: before ?? null, after: { managerUserId } });
    });
  } catch (error) {
    if (error instanceof UserError) throw error;
    refused(error);
  }
}
