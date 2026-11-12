import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { addCurrency, setBaseCurrency, setRate } from "./commands";
import { getRateOn, listCurrencies, listRates } from "./queries";
import { currencies, exchangeRates } from "./schema";

// Currencies and rates against a real database, through the app's own path (app_runtime,
// withTenant, row-level security). Skipped when the database URLs are absent (CI has none).

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-currency-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const ids = { ownerA: randomUUID(), accountantA: randomUUID(), salesA: randomUUID(), auditorA: randomUUID(), ownerB: randomUUID() };

const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({
  userId,
  email: `${role}@currency.test`,
  tenantId,
  tenantName: "x",
  role,
  branchIds: null,
});
const owner = ctx(ids.ownerA, tenantA, "owner");
const accountant = ctx(ids.accountantA, tenantA, "accountant");
const sales = ctx(ids.salesA, tenantA, "salesperson");
const auditor = ctx(ids.auditorA, tenantA, "auditor");
const otherOwner = ctx(ids.ownerB, tenantB, "owner");

let admin: AdminSql;
let usd: string;
let pkr: string;
const DENIED = "42501";

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

describe.skipIf(!hasDb)("currencies and exchange rates", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(
      admin,
      stale.map((r) => r.id),
    );
    await admin`insert into public.tenants (id, name, created_by) values
      (${tenantA}, ${PREFIX + " A"}, ${ids.ownerA}), (${tenantB}, ${PREFIX + " B"}, ${ids.ownerB})`;
    await admin`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
      (${tenantA}, ${ids.ownerA}, ${owner.email}, 'owner', ${ids.ownerA}),
      (${tenantA}, ${ids.accountantA}, ${accountant.email}, 'accountant', ${ids.ownerA}),
      (${tenantA}, ${ids.salesA}, ${sales.email}, 'salesperson', ${ids.ownerA}),
      (${tenantA}, ${ids.auditorA}, ${auditor.email}, 'auditor', ${ids.ownerA}),
      (${tenantB}, ${ids.ownerB}, ${otherOwner.email}, 'owner', ${ids.ownerB})`;
  });

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, tenantB]);
    await admin.end();
    await closeDb();
  });

  it("needs a base currency before anything else, chosen by an owner", async () => {
    await expect(addCurrency(owner, { code: "USD", name: "US Dollar" })).rejects.toThrow("Choose the base currency first.");
    await expect(setBaseCurrency(accountant, { code: "PKR", name: "Pakistani Rupee" })).rejects.toBeInstanceOf(UserError);
    await expect(setBaseCurrency(owner, { code: "rupees", name: "Pakistani Rupee" })).rejects.toThrow("Use the three-letter code, such as USD.");

    pkr = (await setBaseCurrency(owner, { code: "pkr", name: "Pakistani Rupee" })).id;
    const [stored] = await admin`select code, name, is_base, created_by from public.currencies where id = ${pkr}`;
    expect(stored).toEqual({ code: "PKR", name: "Pakistani Rupee", is_base: true, created_by: ids.ownerA });
    const audited = await admin`select action, after from public.audit_log where entity_id = ${pkr}`;
    expect(audited).toEqual([{ action: "currency.set_base", after: { code: "PKR", name: "Pakistani Rupee" } }]);
  });

  it("fixes the base currency for good", async () => {
    await expect(setBaseCurrency(owner, { code: "USD", name: "US Dollar" })).rejects.toThrow(
      "The base currency is already set and cannot be changed.",
    );
    // Past the app: a second base row, a change of the flag, a rename and a delete are all refused.
    expect(
      await codeOf(() =>
        withTenant(ids.ownerA, tenantA, (tx) =>
          tx.insert(currencies).values({ tenantId: tenantA, code: "EUR", name: "Euro", isBase: true, createdBy: ids.ownerA }),
        ),
      ),
    ).toBe("23505");
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.update(currencies).set({ isBase: false })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.update(currencies).set({ code: "USD" })))).toBe(DENIED);
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.delete(currencies)))).toBe(DENIED);
    const base = await admin`select code from public.currencies where tenant_id = ${tenantA} and is_base`;
    expect(base).toEqual([{ code: "PKR" }]);
  });

  it("lets an owner or an accountant add currencies, once each", async () => {
    usd = (await addCurrency(accountant, { code: "usd", name: "US Dollar" })).id;
    await addCurrency(owner, { code: "CNY", name: "Chinese Yuan" });
    await expect(addCurrency(owner, { code: "USD", name: "Dollar again" })).rejects.toThrow("USD is already in the list.");
    await expect(addCurrency(owner, { code: "PKR", name: "Rupee again" })).rejects.toThrow("PKR is already in the list.");
    await expect(addCurrency(sales, { code: "AED", name: "UAE Dirham" })).rejects.toBeInstanceOf(UserError);
    await expect(addCurrency(auditor, { code: "AED", name: "UAE Dirham" })).rejects.toBeInstanceOf(UserError);

    expect((await listCurrencies(auditor)).map((c) => [c.code, c.isBase, c.latest])).toEqual([
      ["PKR", true, null],
      ["CNY", false, null],
      ["USD", false, null],
    ]);
  });

  it("looks a rate up by date: the latest one on or before the day", async () => {
    await setRate(accountant, { currencyId: usd, date: "2026-10-01", rate: "277", source: "Bank counter" });
    await setRate(owner, { currencyId: usd, date: "2026-11-10", rate: "279.1", source: "Bank counter" });
    await setRate(accountant, { currencyId: usd, date: "2026-11-01", rate: "278.50", source: "Bank counter" });

    const on = async (date: string) => {
      const found = await getRateOn(sales, usd, date);
      return found ? [found.rate.toFixed(), found.date] : null;
    };
    expect(await on("2026-09-30")).toBeNull(); // before the first rate: nothing to use
    expect(await on("2026-10-01")).toEqual(["277", "2026-10-01"]); // on the day
    expect(await on("2026-10-31")).toEqual(["277", "2026-10-01"]); // the day before the next rate
    expect(await on("2026-11-01")).toEqual(["278.5", "2026-11-01"]);
    expect(await on("2026-11-09")).toEqual(["278.5", "2026-11-01"]);
    expect(await on("2026-11-10")).toEqual(["279.1", "2026-11-10"]);
    expect(await on("2030-01-01")).toEqual(["279.1", "2026-11-10"]); // long after the newest

    // The base currency is always one; a currency with no rates, or a wrong id or date, gives nothing.
    expect((await getRateOn(sales, pkr, "2026-11-01"))?.rate.toFixed()).toBe("1");
    const [cny] = await admin`select id from public.currencies where tenant_id = ${tenantA} and code = 'CNY'`;
    expect(await getRateOn(sales, cny.id, "2026-11-01")).toBeNull();
    expect(await getRateOn(sales, randomUUID(), "2026-11-01")).toBeNull();
    expect(await getRateOn(sales, usd, "01-11-2026")).toBeNull();

    const listed = (await listCurrencies(owner)).find((c) => c.code === "USD");
    expect([listed?.latest?.rate.toFixed(), listed?.latest?.date]).toEqual(["279.1", "2026-11-10"]);
    expect((await listRates(auditor)).map((r) => [r.code, r.date, r.rate.toFixed()])).toEqual([
      ["USD", "2026-11-10", "279.1"],
      ["USD", "2026-11-01", "278.5"],
      ["USD", "2026-10-01", "277"],
    ]);
  });

  it("keeps a rate exactly as typed and corrects it with both values in the audit log", async () => {
    const { id } = await setRate(accountant, { currencyId: usd, date: "2026-11-12", rate: "279.12345678", source: "Bank counter" });
    const [first] = await admin`select rate::text, created_by, updated_by from public.exchange_rates where id = ${id}`;
    expect(first).toEqual({ rate: "279.12345678", created_by: ids.accountantA, updated_by: ids.accountantA });

    const again = await setRate(owner, { currencyId: usd, date: "2026-11-12", rate: "279.2", source: "State Bank" });
    expect(again.id).toBe(id);
    const [second] = await admin`select rate::text, source, created_by, updated_by from public.exchange_rates where id = ${id}`;
    expect(second).toEqual({ rate: "279.20000000", source: "State Bank", created_by: ids.accountantA, updated_by: ids.ownerA });
    expect(await admin`select count(*)::int as n from public.exchange_rates where currency_id = ${usd} and rate_date = '2026-11-12'`).toEqual([{ n: 1 }]);

    const audited = await admin`select actor_user_id, before, after from public.audit_log where entity_id = ${id} order by at`;
    expect(audited).toEqual([
      { actor_user_id: ids.accountantA, before: null, after: { currency: "USD", date: "2026-11-12", rate: "279.12345678", source: "Bank counter" } },
      {
        actor_user_id: ids.ownerA,
        before: { currency: "USD", date: "2026-11-12", rate: "279.12345678", source: "Bank counter" },
        after: { currency: "USD", date: "2026-11-12", rate: "279.20000000", source: "State Bank" },
      },
    ]);
  });

  it("refuses a rate that makes no sense", async () => {
    const good = { currencyId: usd, date: "2026-11-13", rate: "280", source: "Bank counter" };
    await expect(setRate(owner, { ...good, rate: "0" })).rejects.toThrow("The rate must be more than zero.");
    await expect(setRate(owner, { ...good, rate: "1,234" })).rejects.toThrow("Enter the rate as a plain number, such as 278.5.");
    await expect(setRate(owner, { ...good, date: "2026-02-30" })).rejects.toThrow("Enter the date the rate applies from.");
    await expect(setRate(owner, { ...good, source: " " })).rejects.toBeInstanceOf(UserError);
    await expect(setRate(owner, { ...good, currencyId: pkr })).rejects.toThrow("PKR is the base currency; it has no exchange rate.");
    await expect(setRate(owner, { ...good, currencyId: randomUUID() })).rejects.toThrow("Choose a currency from this company.");
    await expect(setRate(sales, good)).rejects.toBeInstanceOf(UserError);
    await expect(setRate(auditor, good)).rejects.toBeInstanceOf(UserError);
    expect(await admin`select 1 from public.exchange_rates where tenant_id = ${tenantA} and rate_date = '2026-11-13'`).toHaveLength(0);
  });

  it("keeps the same rules in the database, whatever the app does", async () => {
    const rate = { tenantId: tenantA, currencyId: usd, rateDate: "2026-12-01", rate: "281", source: "direct", createdBy: ids.salesA, updatedBy: ids.salesA };
    // A salesperson and an auditor may read but not write.
    expect((await withTenant(ids.salesA, tenantA, (tx) => tx.select().from(exchangeRates))).length).toBeGreaterThan(0);
    for (const who of [ids.salesA, ids.auditorA]) {
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(exchangeRates).values({ ...rate, createdBy: who, updatedBy: who })))).toBe(DENIED);
      expect(
        await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(currencies).values({ tenantId: tenantA, code: "AED", name: "UAE Dirham", createdBy: who }))),
      ).toBe(DENIED);
      await withTenant(who, tenantA, (tx) => tx.update(exchangeRates).set({ rate: "1", updatedBy: who }).where(eq(exchangeRates.tenantId, tenantA)));
    }
    // An accountant may not set the base currency of a company that has none; an owner may not sign as someone else.
    expect(
      await codeOf(() =>
        withTenant(ids.ownerA, tenantA, (tx) => tx.insert(exchangeRates).values({ ...rate, createdBy: ids.ownerB, updatedBy: ids.ownerA })),
      ),
    ).toBe(DENIED);
    // The base currency never gets a rate, and a rate cannot be zero or point at another company's currency.
    expect(
      await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(exchangeRates).values({ ...rate, currencyId: pkr, createdBy: ids.ownerA, updatedBy: ids.ownerA }))),
    ).toBe("23514");
    expect(
      await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(exchangeRates).values({ ...rate, rate: "0", createdBy: ids.ownerA, updatedBy: ids.ownerA }))),
    ).toBe("23514");
    // The day and the currency of a rate cannot be rewritten, and nothing is deletable.
    for (const change of [{ rateDate: "2020-01-01" }, { currencyId: pkr }, { tenantId: tenantB }, { createdBy: ids.ownerB }]) {
      expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.update(exchangeRates).set(change)))).toBe(DENIED);
    }
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.delete(exchangeRates)))).toBe(DENIED);

    const untouched = await admin`select count(*)::int as n, min(rate)::text as lowest from public.exchange_rates where tenant_id = ${tenantA}`;
    expect(untouched).toEqual([{ n: 4, lowest: "277.00000000" }]);
  });

  it("keeps each company's currencies and rates to itself", async () => {
    const usdB = (await (async () => {
      await setBaseCurrency(otherOwner, { code: "PKR", name: "Pakistani Rupee" });
      return addCurrency(otherOwner, { code: "USD", name: "US Dollar" });
    })()).id;
    await setRate(otherOwner, { currencyId: usdB, date: "2026-11-01", rate: "300", source: "Other bank" });

    // Company A never sees B's currency or rate, by list, by lookup, or with B's id as the context.
    expect((await listCurrencies(owner)).every((c) => c.id !== usdB)).toBe(true);
    expect((await listRates(owner)).every((r) => r.source !== "Other bank")).toBe(true);
    expect(await getRateOn(owner, usdB, "2026-11-30")).toBeNull();
    expect((await getRateOn(owner, usd, "2026-11-01"))?.rate.toFixed()).toBe("278.5");
    expect(await withTenant(ids.ownerA, tenantB, (tx) => tx.select().from(currencies))).toEqual([]);
    expect(await withTenant(ids.ownerA, tenantB, (tx) => tx.select().from(exchangeRates))).toEqual([]);
    // And cannot write a rate against B's currency, as A or as B.
    for (const context of [tenantA, tenantB]) {
      expect(
        await codeOf(() =>
          withTenant(ids.ownerA, context, (tx) =>
            tx.insert(exchangeRates).values({ tenantId: tenantB, currencyId: usdB, rateDate: "2026-12-01", rate: "1", source: "x", createdBy: ids.ownerA, updatedBy: ids.ownerA }),
          ),
        ),
      ).toBe(DENIED);
    }
    // A rate in company A cannot point at company B's currency.
    expect(
      await codeOf(() =>
        withTenant(ids.ownerA, tenantA, (tx) =>
          tx.insert(exchangeRates).values({ tenantId: tenantA, currencyId: usdB, rateDate: "2026-12-01", rate: "1", source: "x", createdBy: ids.ownerA, updatedBy: ids.ownerA }),
        ),
      ),
    ).toBe("23503");
    expect(await admin`select rate::text from public.exchange_rates where tenant_id = ${tenantB}`).toEqual([{ rate: "300.00000000" }]);
  });
});
