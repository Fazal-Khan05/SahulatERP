import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { addItemCategory, addUnit, createItem } from "@/modules/items/commands";
import { createParty } from "@/modules/parties/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { deletePlan, savePlan, setManager } from "./commands";
import { getPlan, listPlans, listTeam, planTerms } from "./queries";
import { commissionOnLine, managerShare, type RawPlan } from "./rules";

// Step 37 against a real database: plans and the hierarchy written through the app's own path,
// the database's refusals, and app.commission_on_line (what Step 38 calls) giving exactly what
// rules.ts gives on the old prototype's figures. Skipped without the database URLs.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-commissions-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "sales_manager", "salesperson", "warehouse_manager"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
// Salespeople, one for each kind of plan, and two managers above them.
const sellers = Object.fromEntries(["flat", "category", "klass", "unit", "tiered", "target", "none"].map((key) => [key, randomUUID()])) as Record<string, string>;
const area = randomUUID();
const region = randomUUID();
const ownerB = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@commissions.test`, tenantId, tenantName: "x", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const other = ctx(ownerB, tenantB, "owner");
const d = (value: string | number) => new Decimal(value);

let admin: AdminSql;
let lighting: string;
let home: string;
let lamp: string;
let towel: string;
let wholesaler: string;
let retailer: string;

const base = (over: Partial<RawPlan> = {}): RawPlan => ({ name: "Standard plan", kind: "flat", rate: "2", from: "2026-07-01", to: "", ...over });

/** What the database works out for a line, as Step 38 will ask it. */
async function inDatabase(user: string, date: string, item: string, customer: string, lineBase: string, quantity: string, before: string): Promise<{ plan: string; amount: string } | null> {
  const [row] = await admin<{ plan_id: string; amount: string }[]>`select plan_id, amount::text from app.commission_on_line(${tenantA}::uuid, ${user}::uuid, ${date}::date, ${item}::uuid, ${customer}::uuid, ${lineBase}::numeric, ${quantity}::numeric, ${before}::numeric)`;
  return row ? { plan: row.plan_id, amount: new Decimal(row.amount).toFixed(4) } : null;
}
async function codeOf(who: TenantContext, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

describe.skipIf(!hasDb)("commission plans and the sales hierarchy", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      ...Object.entries(sellers).map(([key, id]) => ({ tenant_id: tenantA, user_id: id, email: `${key}@commissions.test`, role: "salesperson", branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: area, email: "area@commissions.test", role: "sales_manager", branch_ids: null, created_by: userIds.owner },
      { tenant_id: tenantA, user_id: region, email: "region@commissions.test", role: "sales_manager", branch_ids: null, created_by: userIds.owner },
      { tenant_id: tenantB, user_id: ownerB, email: other.email, role: "owner", branch_ids: null, created_by: ownerB },
    ])}`;
    const piece = (await addUnit(as.owner, { code: "pc", name: "Piece" })).id;
    lighting = (await addItemCategory(as.owner, "Lighting")).id;
    home = (await addItemCategory(as.owner, "Home")).id;
    lamp = (await createItem(as.owner, { code: "LT-1", name: "Lamp", unit: piece, category: lighting, defaultPrice: "100" })).id;
    towel = (await createItem(as.owner, { code: "HM-1", name: "Towel", unit: piece, category: home, defaultPrice: "100" })).id;
    wholesaler = (await createParty(as.owner, "customer", { name: "Big Buyer", code: "C-001", customerClass: "Wholesaler" })).id;
    retailer = (await createParty(as.owner, "customer", { name: "Corner Shop", code: "C-002", customerClass: "Retailer" })).id;
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("lets only the owner set up plans, and refuses overlapping dates for the same person", async () => {
    for (const who of [as.accountant, as.sales_manager, as.salesperson]) await expect(savePlan(who, null, base()), who.role).rejects.toThrow("Only the owner can set up commission plans.");
    // The default plan, from 1 July with no end; a second default overlapping it is refused (COM-004).
    const standard = await savePlan(as.owner, null, base());
    await expect(savePlan(as.owner, null, base({ name: "Overlap", from: "2030-01-01", to: "2030-12-31" }))).rejects.toThrow("Commission plan dates overlap.");
    // End it on 30 June 2027; the next one may start the day after (COM-005).
    await savePlan(as.owner, standard.id, base({ to: "2027-06-30" }));
    const next = await savePlan(as.owner, null, base({ name: "Next year", rate: "2.5", from: "2027-07-01" }));
    // A person's own plan may sit over the default; two of their own may not overlap.
    await savePlan(as.owner, null, base({ name: "Flat 2%", userId: sellers.flat }));
    await expect(savePlan(as.owner, null, base({ name: "Flat 3%", userId: sellers.flat, rate: "3", from: "2026-09-01", to: "2026-09-30" }))).rejects.toThrow("Commission plan dates overlap.");
    await deletePlan(as.owner, next.id);
    expect((await listPlans(as.auditor)).map((p) => `${p.name} ${p.userId === null ? "default" : "own"} ${p.from} ${p.to ?? "open"}`)).toEqual(["Standard plan default 2026-07-01 2027-06-30", "Flat 2% own 2026-07-01 open"]);
    await expect(listPlans(as.salesperson)).rejects.toThrow("Your role does not include commission plans.");
    const audits = await admin<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantA} and entity = 'commission_plan' order by at`;
    expect(audits.map((a) => a.action)).toEqual(["commission_plan.create", "commission_plan.update", "commission_plan.create", "commission_plan.create", "commission_plan.delete"]);
  });

  it("works out in the database exactly what rules.ts works out, on the old prototype's figures", async () => {
    const plans: [string, RawPlan][] = [
      ["category", base({ name: "Category", userId: sellers.category, kind: "category", rate: "1", categoryRates: [{ categoryId: lighting, rate: "2.5" }] })],
      ["klass", base({ name: "Class", userId: sellers.klass, kind: "customer_class", rate: "3", classRates: [{ customerClass: "wholesaler ", rate: "1" }] })],
      ["unit", base({ name: "Per unit", userId: sellers.unit, kind: "per_unit", rate: "10" })],
      ["tiered", base({ name: "Slabs", userId: sellers.tiered, kind: "tiered", tiers: [{ threshold: "0", rate: "2" }, { threshold: "500000", rate: "3" }] })],
      ["target", base({ name: "Target", userId: sellers.target, target: "15000", multiplier: "2" })],
    ];
    for (const [, raw] of plans) await savePlan(as.owner, null, raw);
    const cases: [string, string, string, string, string, string, string][] = [
      // seller, item, customer, base, quantity, month before, expected (old test)
      ["category", lamp, retailer, "10000", "100", "0", "250.0000"], // COM-011
      ["category", towel, retailer, "10000", "100", "0", "100.0000"], // COM-011
      ["klass", lamp, wholesaler, "10000", "100", "0", "100.0000"], // COM-012
      ["klass", lamp, retailer, "10000", "100", "0", "300.0000"], // COM-012
      ["unit", lamp, retailer, "700", "7", "0", "70.0000"], // COM-013
      ["unit", lamp, retailer, "50", "0.5", "0", "5.0000"], // COM-071
      ["tiered", lamp, retailer, "600000", "6000", "0", "13000.0000"], // COM-014
      ["tiered", lamp, retailer, "100000", "1000", "600000", "3000.0000"], // COM-014, the founder's month total
      ["tiered", lamp, retailer, "500001", "1", "0", "10000.0300"], // COM-072
      ["target", lamp, retailer, "10000", "100", "0", "200.0000"], // COM-015
      ["target", lamp, retailer, "10000", "100", "10000", "400.0000"], // COM-015
      ["target", lamp, retailer, "10000", "100", "20000", "400.0000"], // COM-015
      ["flat", lamp, retailer, "33.33", "1", "0", "0.6666"], // COM-077
      ["flat", lamp, retailer, "9000", "90", "0", "180.0000"], // COM-038
    ];
    const all = await listPlans(as.owner);
    for (const [key, item, customer, lineBase, quantity, before, expected] of cases) {
      const fromDb = await inDatabase(sellers[key], "2026-11-10", item, customer, lineBase, quantity, before);
      const plan = all.find((p) => p.id === fromDb?.plan)!;
      const fromRules = commissionOnLine(planTerms(plan), { base: d(lineBase), quantity: d(quantity), categoryId: item === lamp ? lighting : home, customerClass: customer === wholesaler ? "Wholesaler" : "Retailer" }, d(before)).toFixed(4);
      expect([key, fromDb?.amount, fromRules], `${key} ${lineBase} after ${before}`).toEqual([key, expected, expected]);
    }
  });

  it("finds the plan by person and day: their own, else the default, else none", async () => {
    // The seller with no plan of their own falls back to the default plan (2%).
    const fallback = await inDatabase(sellers.none, "2026-11-10", lamp, retailer, "10000", "100", "0");
    expect(fallback?.amount).toBe("200.0000");
    const standard = (await listPlans(as.owner)).find((p) => p.name === "Standard plan")!;
    expect(fallback?.plan).toBe(standard.id);
    // Before any plan, and after the default ends, nothing applies (COM-067); a person's own open plan still does.
    expect(await inDatabase(sellers.none, "2026-06-30", lamp, retailer, "10000", "100", "0")).toBeNull();
    expect(await inDatabase(sellers.none, "2027-07-01", lamp, retailer, "10000", "100", "0")).toBeNull();
    expect((await inDatabase(sellers.flat, "2027-07-01", lamp, retailer, "10000", "100", "0"))?.amount).toBe("200.0000");
    // Amounts below nothing, "infinity" and "not a number" are refused.
    for (const bad of ["-1", "Infinity", "NaN"]) {
      await expect(admin`select * from app.commission_on_line(${tenantA}::uuid, ${sellers.flat}::uuid, '2026-11-10'::date, ${lamp}::uuid, ${retailer}::uuid, ${bad}::numeric, 1, 0)`, bad).rejects.toMatchObject({ code: "SE303" });
    }
  });

  it("keeps the hierarchy free of circles, and gives each manager above a seller their team rate", async () => {
    await savePlan(as.owner, null, base({ name: "Area manager", userId: area, rate: "0", teamRate: "0.5" }));
    await savePlan(as.owner, null, base({ name: "Region manager", userId: region, rate: "0", teamRate: "0.25" }));
    await setManager(as.owner, sellers.flat, area);
    await setManager(as.owner, area, region);
    await expect(setManager(as.sales_manager, sellers.flat, region)).rejects.toThrow("Only the owner can set up commission plans.");
    // COM-049 and COM-050.
    await expect(setManager(as.owner, region, sellers.flat)).rejects.toThrow("The sales hierarchy cannot contain a cycle.");
    await expect(setManager(as.owner, region, region)).rejects.toThrow("The sales hierarchy cannot contain a cycle.");
    const managers = await admin<{ level: number; manager_user_id: string; team_rate: string }[]>`select level, manager_user_id, team_rate::text from app.commission_managers(${tenantA}::uuid, ${sellers.flat}::uuid, '2026-11-10'::date)`;
    expect(managers.map((m) => `${m.level} ${m.manager_user_id === area ? "area" : m.manager_user_id === region ? "region" : "?"} ${new Decimal(m.team_rate).toFixed()}`)).toEqual(["1 area 0.5", "2 region 0.25"]);
    expect(managers.map((m) => managerShare(new Decimal(m.team_rate), d(10000)).toFixed(4))).toEqual(["50.0000", "25.0000"]);
    // The team list shows who reports to whom; taking a manager away ends the line there.
    expect((await listTeam(as.accountant)).find((m) => m.userId === sellers.flat)?.managerUserId).toBe(area);
    await setManager(as.owner, area, null);
    expect((await admin`select count(*)::int as n from app.commission_managers(${tenantA}::uuid, ${sellers.flat}::uuid, '2026-11-10'::date)`)[0].n).toBe(1);
    expect(await getPlan(as.owner, randomUUID())).toBeNull();
  });

  it("holds the tables and functions to their rules for SQL written by hand as the app's role", async () => {
    const owner = as.owner;
    const me = userIds.owner;
    const insertPlan = (who: TenantContext, tenant: string, user: string | null, from: string) =>
      sql`insert into public.commission_plans (tenant_id, name, user_id, kind, rate, effective_from, created_by, updated_by) values (${tenant}, 'Sneaky', ${user}, 'flat', 1, ${from}, ${who.userId}, ${who.userId})`;
    // Not the owner, or not this company: refused.
    expect(await codeOf(as.accountant, insertPlan(as.accountant, tenantA, sellers.none, "2026-07-01"))).toBe("42501");
    expect(await codeOf(owner, insertPlan(owner, tenantB, null, "2026-07-01"))).toBe("42501");
    // Overlapping dates and circles are refused by the database itself (the flat seller reports to the area manager).
    expect(await codeOf(owner, insertPlan(owner, tenantA, null, "2026-08-01"))).toBe("SE301");
    expect(await codeOf(owner, sql`insert into public.sales_hierarchy (tenant_id, user_id, manager_user_id, created_by, updated_by) values (${tenantA}, ${area}, ${sellers.flat}, ${me}, ${me})`)).toBe("SE302");
    // The checks answer only the company's owner: a stranger or a salesperson learns nothing from them (SE301 would say a plan is there).
    expect(await codeOf(as.salesperson, insertPlan(as.salesperson, tenantA, null, "2026-08-01"))).toBe("42501");
    expect(await codeOf(other, insertPlan(other, tenantA, null, "2026-08-01"))).toBe("42501");
    expect(await codeOf(as.salesperson, sql`insert into public.sales_hierarchy (tenant_id, user_id, manager_user_id, created_by, updated_by) values (${tenantA}, ${area}, ${sellers.flat}, ${userIds.salesperson}, ${userIds.salesperson})`)).toBe("42501");
    // A transaction reading an older picture of the database is not let in: two of them could each miss the other's row.
    await expect(admin.begin("isolation level repeatable read", (tx) => tx`insert into public.sales_hierarchy (tenant_id, user_id, manager_user_id, created_by, updated_by) values (${tenantA}, ${sellers.none}, ${region}, ${me}, ${me})`)).rejects.toMatchObject({ code: "SE304" });
    // Out-of-range figures are refused.
    expect(await codeOf(owner, sql`insert into public.commission_plans (tenant_id, name, kind, rate, effective_from, created_by, updated_by) values (${tenantA}, 'Bad', 'flat', 101, '2040-01-01', ${me}, ${me})`)).toBe("23514");
    expect(await codeOf(owner, sql`insert into public.commission_plans (tenant_id, name, kind, rate, multiplier, effective_from, created_by, updated_by) values (${tenantA}, 'Bad', 'flat', 1, 'NaN', '2040-01-01', ${me}, ${me})`)).toBe("23514");
    expect(await codeOf(owner, sql`insert into public.commission_plans (tenant_id, name, kind, rate, effective_from, created_by, updated_by) values (${tenantA}, 'Bad', 'flat', 1, 'infinity', ${me}, ${me})`)).toBe("23514");
    // Who created a plan, and its company, never change.
    expect(await codeOf(owner, sql`update public.commission_plans set created_by = ${userIds.accountant}`)).toBe("42501");
    expect(await codeOf(owner, sql`update public.commission_plans set tenant_id = ${tenantB}`)).toBe("42501");
    // The functions for Step 38 are not for the app's role.
    for (const fn of [
      sql`select * from app.commission_on_line(${tenantA}::uuid, ${sellers.flat}::uuid, '2026-11-10'::date, ${lamp}::uuid, ${retailer}::uuid, 1, 1, 0)`,
      sql`select app.commission_plan_for(${tenantA}::uuid, ${sellers.flat}::uuid, '2026-11-10'::date)`,
      sql`select * from app.commission_managers(${tenantA}::uuid, ${sellers.flat}::uuid, '2026-11-10'::date)`,
      sql`select app.commission_slabs(${randomUUID()}::uuid, 1)`,
    ]) {
      expect(await codeOf(owner, fn)).toBe("42501");
    }
    // Who sees the plans.
    const count = async (who: TenantContext) => (await withTenant(who.userId, who.tenantId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from public.commission_plans`)))[0].n;
    expect(await count(as.sales_manager)).toBeGreaterThan(0);
    for (const who of [as.salesperson, as.warehouse_manager, other]) expect(await count(who), who.role).toBe(0);
  });
});
