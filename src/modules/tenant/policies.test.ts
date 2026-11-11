import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, closeDb, withTenant } from "@/db";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { getLogo, loadWorkspace } from "./queries";
import { auditLog, branches, invitations, memberships, modulesEnabled, settings, tenants } from "./schema";

// Row-level security, exercised through the real code path: the app_runtime role, the
// transaction pooler and withTenant(). Rows are seeded and removed over the migration
// connection. Skipped when the database URLs are absent (CI has none).

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);

const PREFIX = "zz-policy-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const ownerA = randomUUID();
const ownerB = randomUUID();
const salesA = randomUUID();
const auditorA = randomUUID();
const inactiveA = randomUUID();
const outsider = randomUUID();
const branchA1 = randomUUID();
const branchA2 = randomUUID();
const branchB1 = randomUUID();

let admin: AdminSql;
const createdTenants: string[] = [tenantA, tenantB];

/** The Postgres error code of a failed query, through Drizzle's wrapper. */
async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

const DENIED = "42501"; // insufficient_privilege: a missing grant or a row-level security refusal

describe.skipIf(!hasDb)("row-level security as app_runtime", () => {
  beforeAll(async () => {
    admin = adminSql();
    // Leftovers from a run that crashed before its cleanup.
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(
      admin,
      stale.map((r) => r.id),
    );

    await admin`insert into public.tenants (id, name, created_by) values
      (${tenantA}, ${PREFIX + " A"}, ${ownerA}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values
      (${branchA1}, ${tenantA}, 'A1', ${ownerA}),
      (${branchA2}, ${tenantA}, 'A2', ${ownerA}),
      (${branchB1}, ${tenantB}, 'B1', ${ownerB})`;
    await admin`insert into public.memberships (tenant_id, user_id, email, role, branch_ids, active, created_by) values
      (${tenantA}, ${ownerA}, 'owner-a@policy.test', 'owner', null, true, ${ownerA}),
      (${tenantB}, ${ownerB}, 'owner-b@policy.test', 'owner', null, true, ${ownerB}),
      (${tenantA}, ${salesA}, 'sales-a@policy.test', 'salesperson', ${[branchA1]}::uuid[], true, ${ownerA}),
      (${tenantA}, ${auditorA}, 'auditor-a@policy.test', 'auditor', null, true, ${ownerA}),
      (${tenantA}, ${inactiveA}, 'inactive-a@policy.test', 'accountant', null, false, ${ownerA})`;
    await admin`insert into public.invitations (tenant_id, email, role, created_by) values
      (${tenantA}, 'invited-a@policy.test', 'accountant', ${ownerA}),
      (${tenantB}, 'invited-b@policy.test', 'accountant', ${ownerB})`;
    await admin`insert into public.audit_log (tenant_id, actor_user_id, actor_role, action, entity) values
      (${tenantA}, ${ownerA}, 'owner', 'test.seed', 'tenant'),
      (${tenantB}, ${ownerB}, 'owner', 'test.seed', 'tenant')`;
    await admin`insert into public.settings (tenant_id, product_name, created_by, updated_by) values
      (${tenantB}, 'Beta Books', ${ownerB}, ${ownerB})`;
    await admin`insert into public.modules_enabled (tenant_id, module, enabled, created_by, updated_by) values
      (${tenantB}, 'payroll', true, ${ownerB}, ${ownerB})`;
  });

  afterAll(async () => {
    await deleteTenants(admin, createdTenants);
    await admin.end();
    await closeDb();
  });

  it("connects as app_runtime, which cannot bypass row-level security", async () => {
    const rows = await withTenant(outsider, null, (tx) =>
      tx.execute(sql`select current_user as name,
        (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) as privileged`),
    );
    expect(rows[0]).toEqual({ name: "app_runtime", privileged: false });
  });

  it("refuses ids that are not uuids before touching the database", async () => {
    await expect(withTenant("not-a-uuid", null, async () => 1)).rejects.toThrow(/userId/);
    await expect(withTenant(ownerA, "x' or '1'='1", async () => 1)).rejects.toThrow(/tenantId/);
  });

  it("shows nothing to a user with no membership", async () => {
    const seen = await withTenant(outsider, tenantA, async (tx) => ({
      tenants: await tx.select().from(tenants),
      memberships: await tx.select().from(memberships),
      branches: await tx.select().from(branches),
      invitations: await tx.select().from(invitations),
      audit: await tx.select().from(auditLog),
    }));
    expect(seen).toEqual({ tenants: [], memberships: [], branches: [], invitations: [], audit: [] });
  });

  it("shows an owner their own company and nothing of the other", async () => {
    const seen = await withTenant(ownerA, tenantA, async (tx) => ({
      tenants: await tx.select().from(tenants),
      memberships: await tx.select().from(memberships),
      branches: await tx.select().from(branches),
      invitations: await tx.select().from(invitations),
      audit: await tx.select().from(auditLog),
    }));
    expect(seen.tenants.map((t) => t.id)).toEqual([tenantA]);
    expect(seen.memberships).toHaveLength(4);
    expect(seen.branches.map((b) => b.name).sort()).toEqual(["A1", "A2"]);
    expect(seen.invitations.map((i) => i.email)).toEqual(["invited-a@policy.test"]);
    for (const rows of [seen.memberships, seen.branches, seen.invitations, seen.audit]) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenantId === tenantA)).toBe(true);
    }
  });

  it("returns zero rows of another company when the tenant id is forged", async () => {
    const seen = await withTenant(ownerA, tenantB, async (tx) => ({
      tenants: await tx.select().from(tenants),
      memberships: await tx.select().from(memberships),
      branches: await tx.select().from(branches),
      invitations: await tx.select().from(invitations),
      audit: await tx.select().from(auditLog),
      direct: await tx.select().from(branches).where(eq(branches.id, branchB1)),
    }));
    // Their own membership and company stay visible (the switcher needs them); nothing of B is.
    expect(seen.tenants.map((t) => t.id)).toEqual([tenantA]);
    expect(seen.memberships.map((m) => [m.tenantId, m.userId])).toEqual([[tenantA, ownerA]]);
    expect(seen.branches).toEqual([]);
    expect(seen.invitations).toEqual([]);
    expect(seen.audit).toEqual([]);
    expect(seen.direct).toEqual([]);
  });

  it("refuses to insert a row into another company", async () => {
    const intoB = { tenantId: tenantB, name: "smuggled", createdBy: ownerA };
    // From the owner's own company, and with the other company's id forged as the context.
    for (const context of [tenantA, tenantB]) {
      expect(await codeOf(() => withTenant(ownerA, context, (tx) => tx.insert(branches).values(intoB)))).toBe(DENIED);
      expect(
        await codeOf(() =>
          withTenant(ownerA, context, (tx) =>
            tx.insert(invitations).values({ tenantId: tenantB, email: "x@policy.test", role: "auditor", createdBy: ownerA }),
          ),
        ),
      ).toBe(DENIED);
      expect(
        await codeOf(() =>
          withTenant(ownerA, context, (tx) =>
            audit(tx, { userId: ownerA, tenantId: tenantB, role: "owner" }, { action: "test.forged", entity: "tenant" }),
          ),
        ),
      ).toBe(DENIED);
    }
    const leaked = await admin`select 1 from public.branches where tenant_id = ${tenantB} and name = 'smuggled'`;
    expect(leaked).toHaveLength(0);
  });

  it("lets an owner add a branch and writes the audit row in the same transaction", async () => {
    const id = await withTenant(ownerA, tenantA, async (tx) => {
      const [row] = await tx.insert(branches).values({ tenantId: tenantA, name: "A3", createdBy: ownerA }).returning();
      await audit(
        tx,
        { userId: ownerA, tenantId: tenantA, role: "owner" },
        { action: "branch.create", entity: "branch", entityId: row.id, after: { name: row.name } },
      );
      return row.id;
    });
    const logged = await admin`select actor_user_id, actor_role, action, after from public.audit_log where entity_id = ${id}`;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actor_user_id: ownerA, actor_role: "owner", action: "branch.create", after: { name: "A3" } });
  });

  it("rolls the change back when the audit row is refused", async () => {
    const code = await codeOf(() =>
      withTenant(ownerA, tenantA, async (tx) => {
        await tx.insert(branches).values({ tenantId: tenantA, name: "never-kept", createdBy: ownerA });
        // An audit row claiming a different actor is refused, which aborts the whole transaction.
        await audit(tx, { userId: ownerB, tenantId: tenantA, role: "owner" }, { action: "branch.create", entity: "branch" });
      }),
    );
    expect(code).toBe(DENIED);
    const kept = await admin`select 1 from public.branches where tenant_id = ${tenantA} and name = 'never-kept'`;
    expect(kept).toHaveLength(0);
  });

  it("limits a branch-scoped member to their branches", async () => {
    const seen = await withTenant(salesA, tenantA, (tx) => tx.select().from(branches));
    expect(seen.map((b) => b.name)).toEqual(["A1"]);
  });

  it("keeps owner-only actions from other roles", async () => {
    expect(
      await codeOf(() =>
        withTenant(salesA, tenantA, (tx) => tx.insert(branches).values({ tenantId: tenantA, name: "by-sales", createdBy: salesA })),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(auditorA, tenantA, (tx) =>
          tx.insert(invitations).values({ tenantId: tenantA, email: "y@policy.test", role: "auditor", createdBy: auditorA }),
        ),
      ),
    ).toBe(DENIED);
    const seen = await withTenant(salesA, tenantA, async (tx) => ({
      memberships: await tx.select().from(memberships),
      invitations: await tx.select().from(invitations),
      audit: await tx.select().from(auditLog),
    }));
    expect(seen.memberships.map((m) => m.userId)).toEqual([salesA]);
    expect(seen.invitations).toEqual([]);
    expect(seen.audit).toEqual([]);
  });

  it("lets an auditor read the audit log and the members behind it, in their company only", async () => {
    const seen = await withTenant(auditorA, tenantA, async (tx) => ({
      audit: await tx.select().from(auditLog),
      memberships: await tx.select().from(memberships),
    }));
    expect(seen.audit.length).toBeGreaterThan(0);
    expect(seen.audit.every((r) => r.tenantId === tenantA)).toBe(true);
    expect(seen.memberships).toHaveLength(4);
    expect(seen.memberships.every((m) => m.tenantId === tenantA)).toBe(true);
  });

  it("accepts an audit row only from the actor, in their real role", async () => {
    const asSelf = { userId: salesA, tenantId: tenantA, role: "salesperson" as const };
    expect(
      await codeOf(() => withTenant(salesA, tenantA, (tx) => audit(tx, asSelf, { action: "test.ok", entity: "tenant" }))),
    ).toBeUndefined();
    expect(
      await codeOf(() =>
        withTenant(salesA, tenantA, (tx) => audit(tx, { ...asSelf, role: "owner" }, { action: "test.role", entity: "tenant" })),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(salesA, tenantA, (tx) => audit(tx, { ...asSelf, userId: ownerA }, { action: "test.actor", entity: "tenant" })),
      ),
    ).toBe(DENIED);
  });

  it("never lets the app change or remove an audit row", async () => {
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.update(auditLog).set({ action: "edited" }))),
    ).toBe(DENIED);
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.delete(auditLog)))).toBe(DENIED);
  });

  it("gives the app no direct write on tenants or memberships", async () => {
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.insert(tenants).values({ name: "direct", createdBy: ownerA }))),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(ownerA, tenantA, (tx) =>
          tx.insert(memberships).values({ tenantId: tenantA, userId: outsider, email: "z@policy.test", role: "owner", createdBy: ownerA }),
        ),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() => withTenant(salesA, tenantA, (tx) => tx.update(memberships).set({ role: "owner", branchIds: null }))),
    ).toBe(DENIED);
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.delete(branches)))).toBe(DENIED);
  });

  it("shows an inactive member nothing", async () => {
    const seen = await withTenant(inactiveA, tenantA, async (tx) => ({
      tenants: await tx.select().from(tenants),
      branches: await tx.select().from(branches),
      audit: await tx.select().from(auditLog),
    }));
    expect(seen).toEqual({ tenants: [], branches: [], audit: [] });
  });

  it("creates a company with its owner through app.create_tenant", async () => {
    const id = await withTenant(outsider, null, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select app.create_tenant(${PREFIX + " C"}, ${"Outsider@Policy.Test"}) as id`,
      );
      return rows[0].id;
    });
    createdTenants.push(id);
    const seen = await withTenant(outsider, id, async (tx) => ({
      tenants: await tx.select().from(tenants),
      memberships: await tx.select().from(memberships),
    }));
    expect(seen.tenants.map((t) => [t.id, t.tenantId, t.name])).toEqual([[id, id, PREFIX + " C"]]);
    expect(seen.memberships.map((m) => [m.userId, m.role, m.email, m.branchIds, m.active])).toEqual([
      [outsider, "owner", "outsider@policy.test", null, true],
    ]);
  });

  it("lets an owner save the company's settings and module switches, and every member read them", async () => {
    await withTenant(ownerA, tenantA, async (tx) => {
      await tx.insert(settings).values({ tenantId: tenantA, productName: "Alpha Desk", createdBy: ownerA, updatedBy: ownerA });
      await tx
        .insert(modulesEnabled)
        .values({ tenantId: tenantA, module: "commissions", enabled: false, createdBy: ownerA, updatedBy: ownerA });
    });
    await withTenant(ownerA, tenantA, (tx) =>
      tx.update(settings).set({ productName: "Alpha Desk 2", updatedAt: new Date(), updatedBy: ownerA }).where(eq(settings.tenantId, tenantA)),
    );
    const seen = await withTenant(salesA, tenantA, async (tx) => ({
      settings: await tx.select({ tenantId: settings.tenantId, productName: settings.productName }).from(settings),
      modules: await tx.select({ tenantId: modulesEnabled.tenantId, module: modulesEnabled.module, enabled: modulesEnabled.enabled }).from(modulesEnabled),
    }));
    expect(seen.settings).toEqual([{ tenantId: tenantA, productName: "Alpha Desk 2" }]);
    expect(seen.modules).toEqual([{ tenantId: tenantA, module: "commissions", enabled: false }]);
  });

  it("keeps settings and module switches from other roles and from other companies", async () => {
    // A member who is not the owner cannot write either table.
    expect(
      await codeOf(() =>
        withTenant(salesA, tenantA, (tx) =>
          tx.update(settings).set({ productName: "Hijacked", updatedAt: new Date(), updatedBy: salesA }).where(eq(settings.tenantId, tenantA)),
        ),
      ),
    ).toBeUndefined(); // no error: the row is simply not updatable for them, so nothing changes
    expect(
      await codeOf(() =>
        withTenant(auditorA, tenantA, (tx) =>
          tx.insert(modulesEnabled).values({ tenantId: tenantA, module: "payroll", enabled: true, createdBy: auditorA, updatedBy: auditorA }),
        ),
      ),
    ).toBe(DENIED);
    // An owner cannot write as somebody else, into another company, or touch another company's rows.
    expect(
      await codeOf(() =>
        withTenant(ownerA, tenantA, (tx) =>
          tx.insert(modulesEnabled).values({ tenantId: tenantA, module: "payroll", enabled: true, createdBy: ownerB, updatedBy: ownerB }),
        ),
      ),
    ).toBe(DENIED);
    for (const context of [tenantA, tenantB]) {
      expect(
        await codeOf(() =>
          withTenant(ownerA, context, (tx) =>
            tx.insert(modulesEnabled).values({ tenantId: tenantB, module: "fbr", enabled: true, createdBy: ownerA, updatedBy: ownerA }),
          ),
        ),
      ).toBe(DENIED);
      await withTenant(ownerA, context, async (tx) => {
        await tx.update(settings).set({ productName: "Hijacked", updatedAt: new Date(), updatedBy: ownerA }).where(eq(settings.tenantId, tenantB));
        await tx.update(modulesEnabled).set({ enabled: false, updatedAt: new Date(), updatedBy: ownerA }).where(eq(modulesEnabled.tenantId, tenantB));
      });
    }
    // A non-owner cannot create the settings row, and an owner cannot sign a change as somebody else.
    expect(
      await codeOf(() =>
        withTenant(salesA, tenantA, (tx) =>
          tx.insert(settings).values({ tenantId: tenantA, productName: "By sales", createdBy: salesA, updatedBy: salesA }),
        ),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(ownerA, tenantA, (tx) =>
          tx.update(settings).set({ productName: "Signed by B", updatedBy: ownerB }).where(eq(settings.tenantId, tenantA)),
        ),
      ),
    ).toBe(DENIED);
    expect(
      await codeOf(() =>
        withTenant(ownerA, tenantA, (tx) =>
          tx.update(modulesEnabled).set({ enabled: true, updatedBy: ownerB }).where(eq(modulesEnabled.tenantId, tenantA)),
        ),
      ),
    ).toBe(DENIED);
    for (const forged of [{ tenantId: tenantB }, { createdBy: ownerB }]) {
      expect(
        await codeOf(() =>
          withTenant(ownerA, tenantA, (tx) => tx.update(modulesEnabled).set(forged).where(eq(modulesEnabled.tenantId, tenantA))),
        ),
      ).toBe(DENIED);
    }
    // Nothing is deletable, and the columns that say who created a row cannot be rewritten.
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.delete(settings)))).toBe(DENIED);
    expect(await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.delete(modulesEnabled)))).toBe(DENIED);
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.update(settings).set({ createdBy: ownerB }).where(eq(settings.tenantId, tenantA)))),
    ).toBe(DENIED);
    expect(
      await codeOf(() => withTenant(ownerA, tenantA, (tx) => tx.update(settings).set({ tenantId: tenantB }).where(eq(settings.tenantId, tenantA)))),
    ).toBe(DENIED);

    const stored = await admin`
      select s.tenant_id, s.product_name,
        (select enabled from public.modules_enabled m where m.tenant_id = s.tenant_id and m.module = 'payroll') as payroll,
        (select count(*)::int from public.modules_enabled m where m.tenant_id = s.tenant_id) as switches
      from public.settings s where s.tenant_id in (${tenantA}, ${tenantB}) order by s.product_name`;
    expect(stored.map((r) => [r.tenant_id, r.product_name, r.payroll, r.switches])).toEqual([
      [tenantA, "Alpha Desk 2", null, 1],
      [tenantB, "Beta Books", true, 1],
    ]);
    // And from inside company A, company B's settings and switches are not visible at all.
    const seen = await withTenant(ownerA, tenantB, async (tx) => ({
      settings: await tx.select({ tenantId: settings.tenantId }).from(settings),
      modules: await tx.select({ tenantId: modulesEnabled.tenantId }).from(modulesEnabled),
    }));
    expect(seen).toEqual({ settings: [], modules: [] });
  });

  it("builds the page frame from the user's own company, whatever company the cookie names", async () => {
    const own = { productName: "Alpha Desk 2", logoUrl: null };
    for (const cookie of [tenantA, tenantB, tenantB.toUpperCase(), "not-a-uuid", null]) {
      const { memberships: mine, active } = await loadWorkspace(ownerA, cookie);
      expect(mine.map((m) => m.tenantId), String(cookie)).toEqual([tenantA]);
      expect(active?.tenantId, String(cookie)).toBe(tenantA);
      expect(active?.branding, String(cookie)).toEqual(own);
      // Company A switched commissions off; company B switched payroll on. Only A's choice shows.
      expect(active?.modules, String(cookie)).toMatchObject({ commissions: false, payroll: false, sales: true });
    }
    // Someone with no company, and a deactivated member, get no company at all.
    expect((await loadWorkspace(randomUUID(), tenantA)).active).toBeNull();
    expect((await loadWorkspace(inactiveA, tenantA)).active).toBeNull();
    // By now `outsider` owns the company created above; asking for A still gives them their own.
    expect((await loadWorkspace(outsider, tenantA)).active?.tenantId).toBe(createdTenants[2]);
  });

  it("serves a logo only to a member of the company it belongs to", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await admin`update public.settings set logo = ${png}, logo_content_type = 'image/png' where tenant_id = ${tenantB}`;
    const forB = await getLogo(ownerB, tenantB);
    expect(forB && [Buffer.from(forB.bytes).equals(Buffer.from(png)), forB.contentType]).toEqual([true, "image/png"]);
    expect(await getLogo(ownerA, tenantB)).toBeNull();
    expect(await getLogo(outsider, tenantB)).toBeNull();
    expect(await getLogo(ownerA, tenantA)).toBeNull(); // company A has no logo
  });

  it("keeps the catalogue rules: tenant_id, forced row-level security and a policy on every table", async () => {
    const tables = await admin<{ name: string; has_tenant_id: boolean; rls: boolean; forced: boolean; policies: number }[]>`
      select c.relname as name,
        exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as has_tenant_id,
        c.relrowsecurity as rls,
        c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by 1`;
    // Every table in public, including ones later steps add: none may skip these rules.
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["audit_log", "branches", "invitations", "memberships", "tenants"]),
    );
    for (const table of tables) {
      expect(table, table.name).toMatchObject({ has_tenant_id: true, rls: true, forced: true });
      expect(table.policies, table.name).toBeGreaterThan(0);
    }
  });

  it("gives anon and authenticated nothing, and app_runtime no way to rewrite the audit log", async () => {
    const dataApi = await admin`
      select grantee, table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(dataApi).toHaveLength(0);
    const runtime = await admin<{ table_name: string; privileges: string }[]>`
      select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'app_runtime'
        and table_name in ('audit_log', 'branches', 'invitations', 'memberships', 'tenants')
      group by 1 order by 1`;
    expect(Object.fromEntries(runtime.map((r) => [r.table_name, r.privileges]))).toEqual({
      audit_log: "INSERT,SELECT",
      branches: "INSERT,SELECT",
      invitations: "INSERT,SELECT",
      memberships: "SELECT",
      tenants: "SELECT",
    });
  });
});
