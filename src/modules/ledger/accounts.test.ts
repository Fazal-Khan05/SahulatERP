import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { addAccount, deleteAccount, seedAccounts, setAccountArchived, updateAccount } from "./commands";
import { getAccount, hasAccounts, listAccounts } from "./queries";
import { CONTROL_TYPES } from "./rules";
import { accounts } from "./schema";

// The chart of accounts against a real database, through the app's own path (app_runtime,
// withTenant, row-level security). Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-accounts-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const roles = ["owner", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const ownerB = randomUUID();
const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}@accounts.test`, tenantId, tenantName: "x", role, branchIds: null });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], tenantA, role)])) as Record<(typeof roles)[number], TenantContext>;
const otherOwner = ctx(ownerB, tenantB, "owner");
const DENIED = "42501";
const CHECK = "23514";

let admin: AdminSql;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const byCode = async (code: string) => {
  const found = (await listAccounts(as.owner)).find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found;
};

describe.skipIf(!hasDb)("the chart of accounts", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner}), (${tenantB}, ${PREFIX + " B"}, ${ownerB})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, created_by: userIds.owner })),
      { tenant_id: tenantB, user_id: ownerB, email: otherOwner.email, role: "owner", created_by: ownerB },
    ])}`;
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  });

  it("gives a company its starting chart once, by the owner", async () => {
    expect(await hasAccounts(as.owner)).toBe(false);
    await expect(seedAccounts(as.accountant, "trading")).rejects.toThrow("Only the owner can create the chart of accounts.");
    await expect(seedAccounts(as.owner, "manufacturing")).rejects.toThrow("Choose a chart of accounts to start from.");
    // Two clicks at the same moment make one chart, not two.
    const twice = await Promise.all([seedAccounts(as.owner, "trading"), seedAccounts(as.owner, "trading")]);
    expect(twice.map((r) => r.created).sort((a, b) => a - b)).toEqual([0, 66]);
    expect((await seedAccounts(as.owner, "trading")).created).toBe(0);

    const chart = await listAccounts(as.auditor);
    expect(chart).toHaveLength(66);
    expect(chart.filter((a) => a.depth === 0).map((a) => `${a.code} ${a.name} ${a.type}`)).toEqual(["1000 Assets asset", "2000 Liabilities liability", "3000 Equity equity", "4000 Income income", "5000 Expenses expense"]);
    // Every account a posting must find is there once, locked; headings are locked too.
    const locked = chart.filter((a) => a.isControl && a.controlType !== null);
    expect(locked.map((a) => a.controlType).sort()).toEqual(Object.keys(CONTROL_TYPES).sort());
    expect(chart.filter((a) => a.isGroup).every((a) => a.isControl)).toBe(true);
    // A child is always the type of its parent, and a parent is always a heading.
    const byId = new Map(chart.map((a) => [a.id, a]));
    for (const account of chart.filter((a) => a.parentId)) {
      const parent = byId.get(account.parentId!)!;
      expect([parent.type, parent.isGroup], account.code).toEqual([account.type, true]);
    }
    expect(chart.find((a) => a.code === "1111")).toMatchObject({ name: "Cash in hand", controlType: "cash", isControl: false });
    const [audited] = await admin`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'accounts.seed'`;
    expect(audited).toEqual({ actor_role: "owner", after: { template: "trading", accounts: 66 } });
    // The other company has none, and sees none of these.
    expect(await hasAccounts(otherOwner)).toBe(false);
    expect(await withTenant(ownerB, tenantA, (tx) => tx.select().from(accounts))).toEqual([]);
  });

  it("adds a sub-account under Expenses, and a bank account under Bank accounts", async () => {
    const expenses = await byCode("5000");
    const added = await addAccount(as.accountant, { parentId: expenses.id, name: " Packing   material ", code: "", kind: "account" });
    expect(added.code).toBe("5900");
    expect(await getAccount(as.auditor, added.id)).toMatchObject({ name: "Packing material", type: "expense", parentId: expenses.id, isGroup: false, isControl: false, controlType: null });
    const bank = await addAccount(as.owner, { parentId: (await byCode("1120")).id, name: "HBL current account", code: "", kind: "account" });
    expect(bank.code).toBe("1121");
    expect(await getAccount(as.owner, bank.id)).toMatchObject({ type: "asset", controlType: "bank" });
    // A heading of the company's own, and an account beneath it with a typed code.
    const heading = await addAccount(as.owner, { parentId: expenses.id, name: "Branch costs", code: "5950", kind: "heading" });
    const under = await addAccount(as.owner, { parentId: heading.id, name: "Lahore branch rent", code: "br-1", kind: "account" });
    expect(under.code).toBe("BR-1");

    await expect(addAccount(as.owner, { parentId: added.id, name: "Under an account", kind: "account" })).rejects.toThrow("Packing material is an account, not a heading. Choose a heading.");
    await expect(addAccount(as.owner, { parentId: expenses.id, name: "packing MATERIAL", kind: "account" })).rejects.toThrow("Another account already has this name.");
    await expect(addAccount(as.owner, { parentId: expenses.id, name: "Something else", code: "5900", kind: "account" })).rejects.toThrow("Another account already has this code.");
    await expect(addAccount(as.owner, { parentId: randomUUID(), name: "Nowhere", kind: "account" })).rejects.toThrow("Choose the heading the account sits under.");
    for (const role of ["auditor", "salesperson"] as const) {
      await expect(addAccount(as[role], { parentId: expenses.id, name: "Not allowed", kind: "account" }), role).rejects.toThrow("Only an owner or an accountant can change the chart of accounts.");
    }
    await expect(listAccounts(as.salesperson)).rejects.toThrow("Only an owner, an accountant or an auditor can see the chart of accounts.");
    const [audited] = await admin`select actor_role, after from public.audit_log where tenant_id = ${tenantA} and action = 'account.create' and entity_id = ${added.id}`;
    expect(audited).toEqual({ actor_role: "accountant", after: { code: "5900", name: "Packing material", under: "5000", type: "expense", heading: false } });
  });

  it("renames the company's own accounts and leaves the locked ones alone", async () => {
    const packing = await byCode("5900");
    await updateAccount(as.accountant, packing.id, { name: "Packing and wrapping", code: "5910" }, packing.updatedAt.toISOString());
    expect(await getAccount(as.owner, packing.id)).toMatchObject({ name: "Packing and wrapping", code: "5910" });
    // A form opened before that change cannot overwrite it.
    await expect(updateAccount(as.owner, packing.id, { name: "Stale", code: "5910" }, packing.updatedAt.toISOString())).rejects.toThrow("Someone changed this account after you opened it.");
    await expect(updateAccount(as.owner, packing.id, { name: "Rent", code: "5910" })).rejects.toThrow("Another account already has this name.");
    await expect(updateAccount(as.owner, packing.id, { name: "Packing and wrapping", code: "5230" })).rejects.toThrow("Another account already has this code.");
    const receivables = await byCode("1200");
    await expect(updateAccount(as.owner, receivables.id, { name: "Debtors", code: "1200" })).rejects.toThrow("locked");
    await expect(setAccountArchived(as.owner, receivables.id, true)).rejects.toThrow("locked");
    await expect(deleteAccount(as.owner, receivables.id)).rejects.toThrow("locked");
    await expect(updateAccount(as.auditor, packing.id, { name: "No", code: "5910" })).rejects.toThrow("Only an owner or an accountant");
    const [audited] = await admin`select before, after from public.audit_log where tenant_id = ${tenantA} and action = 'account.update'`;
    expect(audited).toEqual({ before: { code: "5900", name: "Packing material" }, after: { code: "5910", name: "Packing and wrapping" } });
  });

  it("archives, restores and deletes", async () => {
    const heading = await byCode("5950");
    const under = await byCode("BR-1");
    await expect(setAccountArchived(as.owner, heading.id, true)).rejects.toThrow("Archive the accounts under this heading first.");
    await expect(deleteAccount(as.owner, heading.id)).rejects.toThrow("This heading has accounts under it, so it cannot be deleted.");
    await setAccountArchived(as.accountant, under.id, true);
    await setAccountArchived(as.accountant, heading.id, true);
    await expect(updateAccount(as.owner, under.id, { name: "Changed", code: "BR-1" })).rejects.toThrow("Restore the account before changing it.");
    await expect(addAccount(as.owner, { parentId: (await byCode("5000")).id, name: "lahore branch rent", kind: "account" })).rejects.toThrow("An archived account, BR-1, already has this name. Restore it instead.");
    // A form opened before the archive cannot delete what it no longer shows.
    await expect(deleteAccount(as.owner, under.id, under.updatedAt.toISOString())).rejects.toThrow("Someone changed this account after you opened it.");
    await expect(addAccount(as.owner, { parentId: heading.id, name: "Under archived", kind: "account" })).rejects.toThrow("Branch costs is archived.");
    await expect(setAccountArchived(as.owner, under.id, false)).rejects.toThrow("Restore the heading Branch costs first.");
    await setAccountArchived(as.owner, heading.id, false);
    await setAccountArchived(as.owner, under.id, false);
    expect((await getAccount(as.owner, under.id))?.archivedAt).toBeNull();

    // An account nothing uses is deleted; then its heading can go too.
    await deleteAccount(as.accountant, under.id);
    await deleteAccount(as.owner, heading.id);
    expect(await getAccount(as.owner, under.id)).toBeNull();
    await expect(deleteAccount(as.owner, under.id)).rejects.toThrow("That account is not in this company.");
    await expect(deleteAccount(as.auditor, (await byCode("5910")).id)).rejects.toThrow("Only an owner or an accountant");
    const actions = await admin`select action from public.audit_log where tenant_id = ${tenantA} and action in ('account.archive', 'account.restore', 'account.delete') order by at`;
    expect(actions.map((a) => a.action)).toEqual(["account.archive", "account.archive", "account.restore", "account.restore", "account.delete", "account.delete"]);
  });

  it("keeps the same rules in the database, whatever the app does", async () => {
    const expenses = await byCode("5000");
    const rent = await byCode("5230");
    const receivables = await byCode("1200");
    const assets = await byCode("1000");
    const mine = (id: string) => and(eq(accounts.tenantId, tenantA), eq(accounts.id, id));
    const row = { tenantId: tenantA, parentId: expenses.id, code: "5900", name: "Raw insert", type: "expense", isGroup: false, createdBy: userIds.owner };
    const insert = (who: string, values: Record<string, unknown>) => codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(accounts).values({ ...row, ...values } as typeof accounts.$inferInsert)));

    // Who may write, and under whose name.
    expect(await insert(userIds.auditor, { createdBy: userIds.auditor })).toBe(DENIED);
    expect(await insert(userIds.salesperson, { createdBy: userIds.salesperson })).toBe(DENIED);
    expect(await insert(userIds.owner, { createdBy: userIds.accountant })).toBe(DENIED);
    // Nobody can add a locked account or a root, or move into another company.
    expect(await insert(userIds.owner, { isControl: true, controlType: "made_up" })).toBe(DENIED);
    expect(await insert(userIds.owner, { parentId: null })).toBe(CHECK);
    expect(await insert(userIds.owner, { tenantId: tenantB })).toBe(DENIED);
    // An account sits under a heading of its own type, and takes what it is for from it.
    expect(await insert(userIds.owner, { parentId: rent.id })).toBe("SE031");
    expect(await insert(userIds.owner, { parentId: assets.id })).toBe("23503");
    expect(await insert(userIds.owner, { controlType: "bank" })).toBe("SE033");
    expect(await insert(userIds.owner, { parentId: (await byCode("1120")).id, type: "asset" })).toBe("SE033");
    expect(await insert(userIds.owner, { code: "59 00" })).toBe(CHECK);
    expect(await insert(userIds.owner, { type: "other" })).toBe(CHECK);
    // At most five levels below a root, and a heading at most four.
    let parent = expenses.id;
    for (let level = 1; level <= 4; level += 1) parent = (await addAccount(as.owner, { parentId: parent, name: `Level ${level}`, code: `L${level}`, kind: "heading" })).id;
    await expect(addAccount(as.owner, { parentId: parent, name: "Level 5 heading", code: "L5H", kind: "heading" })).rejects.toThrow("A heading cannot sit at the deepest level");
    expect(await insert(userIds.owner, { parentId: parent, isGroup: true, code: "L5H" })).toBe("SE034");
    await addAccount(as.owner, { parentId: parent, name: "Level 5", code: "L5", kind: "account" });

    // A heading with live accounts under it is not archived, an account is not restored under an
    // archived heading, an archived account is not renamed, and the times are the database's own.
    const l3 = await byCode("L3");
    const l4 = await byCode("L4");
    const l5 = await byCode("L5");
    const set = (id: string, change: Record<string, unknown>) => codeOf(() => withTenant(userIds.accountant, tenantA, (tx) => tx.update(accounts).set(change).where(mine(id))));
    const archive = { archivedAt: new Date("1990-01-01T00:00:00Z"), archivedBy: userIds.accountant };
    expect(await set(l4.id, archive)).toBe("SE036");
    expect(await set(l5.id, { ...archive, updatedAt: new Date("1990-01-01T00:00:00Z") })).toBeUndefined();
    const [stamped] = await admin`select archived_at > now() - interval '1 hour' as archived_now, updated_at > now() - interval '1 hour' as updated_now from public.accounts where id = ${l5.id}`;
    expect(stamped).toEqual({ archived_now: true, updated_now: true });
    expect(await set(l5.id, { name: "Renamed while archived" })).toBe("SE035");
    expect(await set(l4.id, archive)).toBeUndefined();
    expect(await set(l5.id, { archivedAt: null, archivedBy: null })).toBe("SE032");
    expect(await set(l4.id, { archivedAt: null, archivedBy: null })).toBeUndefined();
    expect(l3.archivedAt).toBeNull();
    // The rules for where an account sits are read only inside the caller's own company.
    const theirs = (await admin`select id from public.accounts where tenant_id = ${tenantB} and code = '5230'`)[0]?.id ?? randomUUID();
    expect(await insert(userIds.owner, { tenantId: tenantB, parentId: theirs })).toBe(DENIED);

    // A locked account cannot be changed or removed by anyone; nothing can be moved or retyped.
    const touched = await withTenant(userIds.owner, tenantA, (tx) => tx.update(accounts).set({ name: "Debtors" }).where(mine(receivables.id)).returning({ id: accounts.id }));
    expect(touched).toEqual([]);
    expect(await withTenant(userIds.owner, tenantA, (tx) => tx.delete(accounts).where(mine(receivables.id)).returning({ id: accounts.id }))).toEqual([]);
    for (const change of [{ parentId: assets.id }, { type: "asset" }, { isGroup: true }, { isControl: true }, { controlType: "bank" }, { tenantId: tenantB }, { createdBy: userIds.accountant }]) {
      expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.update(accounts).set(change).where(mine(rent.id)))), JSON.stringify(change)).toBe(DENIED);
    }
    // An auditor or a salesperson changes and deletes nothing; archiving is under one's own name.
    expect(await withTenant(userIds.auditor, tenantA, (tx) => tx.update(accounts).set({ name: "No" }).where(mine(rent.id)).returning({ id: accounts.id }))).toEqual([]);
    expect(await withTenant(userIds.auditor, tenantA, (tx) => tx.delete(accounts).where(mine(rent.id)).returning({ id: accounts.id }))).toEqual([]);
    expect(await withTenant(userIds.salesperson, tenantA, (tx) => tx.select().from(accounts))).toEqual([]);
    expect(await codeOf(() => withTenant(userIds.owner, tenantA, (tx) => tx.update(accounts).set({ archivedAt: new Date(), archivedBy: userIds.accountant }).where(mine(rent.id))))).toBe(DENIED);
    // A statement cannot change which company it is in half-way, to slip a row past these rules.
    expect(
      await codeOf(() =>
        withTenant(userIds.owner, tenantA, (tx) =>
          tx.execute(sql`update public.accounts
            set name = case when code = '5240' and set_config('app.tenant_id', '', true) = '' then name else name end, archived_at = '1990-01-01', archived_by = ${userIds.owner}
            where tenant_id = ${tenantA} and code in ('5230', '5240')`),
        ),
      ),
    ).toBe(DENIED);
    // The starting chart cannot be written into another company, or by anyone but the owner.
    expect(await codeOf(() => withTenant(userIds.accountant, tenantA, (tx) => tx.execute(`select app.seed_accounts('trading')`)))).toBe(DENIED);
    expect(await codeOf(() => withTenant(userIds.owner, tenantB, (tx) => tx.execute(`select app.seed_accounts('trading')`)))).toBe(DENIED);
    expect(await codeOf(() => withTenant(ownerB, tenantB, (tx) => tx.execute(`select app.seed_accounts('unknown')`)))).toBe(CHECK);
  });
});
