import "server-only";
import Decimal from "decimal.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { itemCategories } from "@/modules/items/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { classKey, isPlanKind, type PlanKind, type PlanTerms } from "./rules";
import { commissionPlanRates, commissionPlanTiers, commissionPlans, salesHierarchy } from "./schema";

const d = (value: string | null | undefined) => new Decimal(value ?? "0");

export function requireCommissionAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "commission.read")) throw new UserError("Your role does not include commission plans.");
}

export type Plan = {
  id: string;
  name: string;
  userId: string | null;
  kind: PlanKind;
  rate: Decimal;
  target: Decimal;
  multiplier: Decimal;
  teamRate: Decimal;
  from: string;
  to: string | null;
  categoryRates: { categoryId: string; categoryName: string; rate: Decimal }[];
  classRates: { customerClass: string; rate: Decimal }[];
  tiers: { threshold: Decimal; rate: Decimal }[];
  updatedAt: Date;
};

/** Every plan, with its rates and slabs, by person (the default plans first) and start date. */
export async function listPlans(ctx: TenantContext): Promise<Plan[]> {
  requireCommissionAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [plans, rates, tiers] = await Promise.all([
      tx.select().from(commissionPlans).where(eq(commissionPlans.tenantId, ctx.tenantId)).orderBy(sql`${commissionPlans.userId} nulls first`, asc(commissionPlans.effectiveFrom)),
      tx
        .select({ planId: commissionPlanRates.planId, categoryId: commissionPlanRates.categoryId, categoryName: itemCategories.name, customerClass: commissionPlanRates.customerClass, rate: commissionPlanRates.rate })
        .from(commissionPlanRates)
        .leftJoin(itemCategories, and(eq(itemCategories.tenantId, commissionPlanRates.tenantId), eq(itemCategories.id, commissionPlanRates.categoryId)))
        .where(eq(commissionPlanRates.tenantId, ctx.tenantId)),
      tx.select().from(commissionPlanTiers).where(eq(commissionPlanTiers.tenantId, ctx.tenantId)).orderBy(asc(commissionPlanTiers.threshold)),
    ]);
    return plans.flatMap((plan) =>
      isPlanKind(plan.kind)
        ? [
            {
              id: plan.id,
              name: plan.name,
              userId: plan.userId,
              kind: plan.kind,
              rate: d(plan.rate),
              target: d(plan.target),
              multiplier: d(plan.multiplier),
              teamRate: d(plan.teamRate),
              from: plan.effectiveFrom,
              to: plan.effectiveTo,
              categoryRates: rates.filter((r) => r.planId === plan.id && r.categoryId !== null).map((r) => ({ categoryId: r.categoryId!, categoryName: r.categoryName ?? "", rate: d(r.rate) })),
              classRates: rates.filter((r) => r.planId === plan.id && r.customerClass !== null).map((r) => ({ customerClass: r.customerClass!, rate: d(r.rate) })),
              tiers: tiers.filter((t) => t.planId === plan.id).map((t) => ({ threshold: d(t.threshold), rate: d(t.rate) })),
              updatedAt: plan.updatedAt,
            },
          ]
        : [],
    );
  });
}

export async function getPlan(ctx: TenantContext, id: string): Promise<Plan | null> {
  if (!isUuid(id)) return null;
  return (await listPlans(ctx)).find((plan) => plan.id === id) ?? null;
}

/** A plan as rules.ts works it out. */
export function planTerms(plan: Pick<Plan, "kind" | "rate" | "target" | "multiplier" | "teamRate" | "categoryRates" | "classRates" | "tiers">): PlanTerms {
  return {
    kind: plan.kind,
    rate: plan.rate,
    target: plan.target,
    multiplier: plan.multiplier,
    teamRate: plan.teamRate,
    categoryRates: new Map(plan.categoryRates.map((r) => [r.categoryId, r.rate])),
    classRates: new Map(plan.classRates.map((r) => [classKey(r.customerClass), r.rate])),
    tiers: plan.tiers,
  };
}

export type TeamMember = { userId: string; email: string; role: string; managerUserId: string | null };

/** The sales team (owners, sales managers and salespeople) and who each reports to. */
export async function listTeam(ctx: TenantContext): Promise<TeamMember[]> {
  requireCommissionAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [people, links] = await Promise.all([
      tx.execute<{ user_id: string; email: string; role: string }>(sql`select user_id, email, role from app.sales_people() order by email`),
      tx.select({ userId: salesHierarchy.userId, managerUserId: salesHierarchy.managerUserId }).from(salesHierarchy).where(eq(salesHierarchy.tenantId, ctx.tenantId)),
    ]);
    const managerOf = new Map(links.map((link) => [link.userId, link.managerUserId]));
    return people.map((person) => ({ userId: person.user_id, email: person.email, role: person.role, managerUserId: managerOf.get(person.user_id) ?? null }));
  });
}

/** The item categories and customer classes a plan's rates can name. */
export async function listRateChoices(ctx: TenantContext): Promise<{ categories: { id: string; name: string }[]; classes: string[] }> {
  requireCommissionAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [categories, classes] = await Promise.all([
      tx.select({ id: itemCategories.id, name: itemCategories.name }).from(itemCategories).where(eq(itemCategories.tenantId, ctx.tenantId)).orderBy(asc(sql`lower(${itemCategories.name})`)),
      tx.execute<{ customer_class: string }>(sql`select distinct btrim(customer_class) as customer_class from public.customers where tenant_id = ${ctx.tenantId} and customer_class is not null order by 1`),
    ]);
    return { categories, classes: classes.map((row) => row.customer_class) };
  });
}
