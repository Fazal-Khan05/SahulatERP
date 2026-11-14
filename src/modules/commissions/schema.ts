import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { itemCategories } from "../items/schema";
import { memberships, tenants } from "../tenant/schema";

// Commission plans and the sales hierarchy (Step 37). Plans and who reports to whom are kept
// here; what a sale earns is worked out by app.commission_on_line (this step's migration) and
// accrued by Step 38. Only the owner writes these tables (the founder's decision, 2026-11-14).

// A plan: for one salesperson (user_id), or the company's default plan for everyone without one
// (user_id empty). Each person's plans, and the default plans, never overlap in time.
export const commissionPlans = pgTable(
  "commission_plans",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text().notNull(),
    userId: uuid("user_id"),
    // flat, category, customer_class, per_unit or tiered.
    kind: text().notNull(),
    // A percentage; rupees a unit on a per-unit plan.
    rate: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    // The month's sales from which the multiplier applies; 0 for none.
    target: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    multiplier: numeric({ precision: 9, scale: 4 }).notNull().default("1"),
    // What a manager on this plan earns on the sales of everyone under them, in percent.
    teamRate: numeric("team_rate", { precision: 9, scale: 4 }).notNull().default("0"),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    // Empty: no end yet.
    effectiveTo: date("effective_to", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("commission_plans_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "commission_plans_user_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    index("commission_plans_lookup_idx").on(t.tenantId, t.userId, t.effectiveFrom),
    check("commission_plans_name_length", sql`char_length(btrim(${t.name})) between 2 and 100`),
    check("commission_plans_kind_known", sql`${t.kind} in ('flat', 'category', 'customer_class', 'per_unit', 'tiered')`),
    // "Not a number" passes ">= 0"; the upper bound refuses it.
    check("commission_plans_rate_range", sql`${t.rate} >= 0 and ${t.rate} < 1e12 and (${t.kind} = 'per_unit' or ${t.rate} <= 100)`),
    check("commission_plans_target_range", sql`${t.target} >= 0 and ${t.target} < 1e16`),
    check("commission_plans_multiplier_range", sql`${t.multiplier} > 0 and ${t.multiplier} <= 10`),
    check("commission_plans_team_rate_range", sql`${t.teamRate} >= 0 and ${t.teamRate} <= 100`),
    check("commission_plans_dates", sql`isfinite(${t.effectiveFrom}) and (${t.effectiveTo} is null or (isfinite(${t.effectiveTo}) and ${t.effectiveTo} >= ${t.effectiveFrom}))`),
  ],
);

// The rates of a category plan (category_id) or of a customer-class plan (customer_class).
export const commissionPlanRates = pgTable(
  "commission_plan_rates",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    planId: uuid("plan_id").notNull(),
    categoryId: uuid("category_id"),
    customerClass: text("customer_class"),
    rate: numeric({ precision: 9, scale: 4 }).notNull(),
  },
  (t) => [
    unique("commission_plan_rates_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "commission_plan_rates_plan_fk", columns: [t.tenantId, t.planId], foreignColumns: [commissionPlans.tenantId, commissionPlans.id] }).onDelete("cascade"),
    foreignKey({ name: "commission_plan_rates_category_fk", columns: [t.tenantId, t.categoryId], foreignColumns: [itemCategories.tenantId, itemCategories.id] }),
    uniqueIndex("commission_plan_rates_category_key").on(t.tenantId, t.planId, t.categoryId).where(sql`${t.categoryId} is not null`),
    uniqueIndex("commission_plan_rates_class_key").on(t.tenantId, t.planId, sql`lower(btrim(${t.customerClass}))`).where(sql`${t.customerClass} is not null`),
    check("commission_plan_rates_one_key", sql`(${t.categoryId} is null) <> (${t.customerClass} is null)`),
    check("commission_plan_rates_class_length", sql`char_length(btrim(${t.customerClass})) between 1 and 40`),
    check("commission_plan_rates_rate_range", sql`${t.rate} >= 0 and ${t.rate} <= 100`),
  ],
);

// The slabs of a tiered plan: from `threshold` of the salesperson's sales in the month, `rate` percent.
export const commissionPlanTiers = pgTable(
  "commission_plan_tiers",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    planId: uuid("plan_id").notNull(),
    threshold: numeric({ precision: 20, scale: 4 }).notNull(),
    rate: numeric({ precision: 9, scale: 4 }).notNull(),
  },
  (t) => [
    unique("commission_plan_tiers_tenant_id_id_key").on(t.tenantId, t.id),
    unique("commission_plan_tiers_threshold_key").on(t.tenantId, t.planId, t.threshold),
    foreignKey({ name: "commission_plan_tiers_plan_fk", columns: [t.tenantId, t.planId], foreignColumns: [commissionPlans.tenantId, commissionPlans.id] }).onDelete("cascade"),
    check("commission_plan_tiers_threshold_range", sql`${t.threshold} >= 0 and ${t.threshold} < 1e16`),
    check("commission_plan_tiers_rate_range", sql`${t.rate} >= 0 and ${t.rate} <= 100`),
  ],
);

// Who reports to whom in the sales team: one manager for a member, never in a circle.
export const salesHierarchy = pgTable(
  "sales_hierarchy",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id").notNull(),
    managerUserId: uuid("manager_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("sales_hierarchy_tenant_id_id_key").on(t.tenantId, t.id),
    unique("sales_hierarchy_member_key").on(t.tenantId, t.userId),
    foreignKey({ name: "sales_hierarchy_user_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    foreignKey({ name: "sales_hierarchy_manager_fk", columns: [t.tenantId, t.managerUserId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    index("sales_hierarchy_manager_idx").on(t.tenantId, t.managerUserId),
    check("sales_hierarchy_not_own_manager", sql`${t.userId} <> ${t.managerUserId}`),
  ],
);
