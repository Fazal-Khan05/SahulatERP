import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { recordSetup } from "./commands";
import { getCompanySetup } from "./queries";
import { readSetup, type SetupInput } from "./rules";

const facts = { baseCurrency: "PKR", fiscalYearStart: "2026-07-01", branch: "Main", warehouse: "Main warehouse", modules: ["sales", "inventory"] };
import { companySetup } from "./schema";

// The setup record against a real database, through the app's own path. Skipped when the
// database URLs are absent. The wizard as a whole is tested in e2e/setup.spec.ts.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-setup-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const ids = { owner: randomUUID(), accountant: randomUUID(), salesperson: randomUUID(), ownerB: randomUUID() };
const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({ userId, email: `${role}@setup.test`, tenantId, tenantName: "x", role, branchIds: null });
const owner = ctx(ids.owner, tenantA, "owner");
const accountant = ctx(ids.accountant, tenantA, "accountant");
const sales = ctx(ids.salesperson, tenantA, "salesperson");
const otherOwner = ctx(ids.ownerB, tenantB, "owner");

let admin: AdminSql;
const answers = (extra: Record<string, string> = {}): SetupInput => {
  const read = readSetup({ salesTaxRegistered: "no", currencyCode: "PKR", currencyName: "Pakistani Rupee", fiscalMonth: "7", fiscalYear: "2026", bundle: "trading", branchName: "Main", warehouseName: "Main warehouse", accountsTemplate: "trading", ...extra });
  if (!read.ok) throw new Error(read.reason);
  return read.setup;
};
async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

describe.skipIf(!hasDb)("the setup record", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${ids.owner}), (${tenantB}, ${PREFIX + " B"}, ${ids.ownerB})`;
    await admin`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
      (${tenantA}, ${ids.owner}, ${owner.email}, 'owner', ${ids.owner}), (${tenantA}, ${ids.accountant}, ${accountant.email}, 'accountant', ${ids.owner}),
      (${tenantA}, ${ids.salesperson}, ${sales.email}, 'salesperson', ${ids.owner}), (${tenantB}, ${ids.ownerB}, ${otherOwner.email}, 'owner', ${ids.ownerB})`;
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("is written once, by the owner, and read by every member", async () => {
    expect(await getCompanySetup(sales)).toBeNull();
    await expect(recordSetup(accountant, answers(), facts)).rejects.toThrow("Only the owner can set up the company.");
    await recordSetup(owner, answers({ ntn: "1111111-1" }), { ...facts, baseCurrency: "USD", branch: "Karachi" });
    await expect(recordSetup(owner, answers(), facts)).rejects.toThrow("This company is already set up.");
    const seen = await getCompanySetup(sales);
    expect(seen).toMatchObject({ salesTaxRegistered: false, ntn: "1111111-1", strn: null, accountsTemplate: "trading" });
    expect(seen?.completedAt).toBeInstanceOf(Date);
    const [audited] = await admin`select actor_role, action, after from public.audit_log where tenant_id = ${tenantA} and action = 'company.setup'`;
    expect(audited).toEqual({
      actor_role: "owner",
      action: "company.setup",
      // The parts other modules own are recorded as they are, not as they were typed.
      after: { salesTaxRegistered: false, ntn: "1111111-1", strn: null, taxRatesConfirmed: false, pricesIncludeTax: false, baseCurrency: "USD", fiscalYearStart: "2026-07-01", bundle: "trading", modules: "sales, inventory", branch: "Karachi", warehouse: "Main warehouse", accountsTemplate: "trading" },
    });
  }, 120_000);

  it("keeps a registered company's STRN and the moment it confirmed its rates", async () => {
    await recordSetup(otherOwner, answers({ salesTaxRegistered: "yes", strn: "1111111111111", taxRatesConfirmed: "on", pricesIncludeTax: "yes" }), facts);
    const [row] = await admin`select sales_tax_registered, strn, tax_rates_confirmed_at is not null as confirmed, prices_include_tax, completed_by from public.company_setup where tenant_id = ${tenantB}`;
    expect(row).toEqual({ sales_tax_registered: true, strn: "1111111111111", confirmed: true, prices_include_tax: true, completed_by: ids.ownerB });
    // What the tax engine reads: registered, with the tax inside the prices; the other company has neither.
    expect(await getCompanySetup(otherOwner)).toMatchObject({ salesTaxRegistered: true, pricesIncludeTax: true });
    expect(await getCompanySetup(owner)).toMatchObject({ salesTaxRegistered: false, pricesIncludeTax: false });
    // Each company sees only its own.
    expect((await getCompanySetup(owner))?.salesTaxRegistered).toBe(false);
    expect(await withTenant(ids.owner, tenantB, (tx) => tx.select().from(companySetup))).toEqual([]);
  }, 120_000);

  it("keeps the same rules in the database, whatever the app does", async () => {
    const row = { tenantId: tenantA, salesTaxRegistered: false, accountsTemplate: "trading", completedBy: ids.accountant };
    expect(await codeOf(() => withTenant(ids.accountant, tenantA, (tx) => tx.insert(companySetup).values(row)))).toBe("42501");
    // A second record, a rewrite and a removal are all refused, even for the owner.
    expect(await codeOf(() => withTenant(ids.owner, tenantA, (tx) => tx.insert(companySetup).values({ ...row, completedBy: ids.owner })))).toBe("23505");
    expect(await codeOf(() => withTenant(ids.owner, tenantA, (tx) => tx.update(companySetup).set({ salesTaxRegistered: true })))).toBe("42501");
    expect(await codeOf(() => withTenant(ids.owner, tenantA, (tx) => tx.delete(companySetup)))).toBe("42501");
    // Registered and STRN go together, as do registered and the confirmation of rates.
    await admin`delete from public.company_setup where tenant_id = ${tenantA}`;
    for (const bad of [{ salesTaxRegistered: true }, { strn: "1111111111111" }, { strn: "123" }, { ntn: "12" }, { accountsTemplate: "Not A Template" }, { pricesIncludeTax: true }]) {
      expect(await codeOf(() => withTenant(ids.owner, tenantA, (tx) => tx.insert(companySetup).values({ ...row, completedBy: ids.owner, ...bad }))), JSON.stringify(bad)).toBe("23514");
    }
    expect(await codeOf(() => withTenant(ids.owner, tenantA, (tx) => tx.insert(companySetup).values({ ...row, completedBy: ids.ownerB })))).toBe("42501");
  }, 120_000);
});
