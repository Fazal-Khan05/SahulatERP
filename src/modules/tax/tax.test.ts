import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { addTaxCategory, setTaxRate, setWithholdingRate } from "./commands";
import { getTaxRateOn, getWithholdingRuleOn, listTaxTables } from "./queries";
import { taxRateOn, withholdingRateFor, withholdingRuleOn } from "./rules";
import { taxCategories, taxRates, withholdingRules } from "./schema";

// Tax tables against a real database, through the app's own path (app_runtime, withTenant,
// row-level security). Skipped when the database URLs are absent (CI has none).

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-tax-test";
const tenantA = randomUUID();
const tenantB = randomUUID();
const ids = {
  ownerA: randomUUID(),
  accountantA: randomUUID(),
  salesA: randomUUID(),
  auditorA: randomUUID(),
  ownerB: randomUUID(),
  founder: randomUUID(),
};

const ctx = (userId: string, tenantId: string, role: TenantContext["role"]): TenantContext => ({
  userId,
  email: `${role}@tax.test`,
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

const TODAY = "2026-11-12";
const START = "2026-07-01";
const GOODS_COMPANY = "income_tax.goods.company";
const DENIED = "42501";
const CHECK = "23514";

let admin: AdminSql;
let standard: string;
let exempt: string;
let zeroRated: string;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

describe.skipIf(!hasDb)("tax categories, dated rates and withholding rules", () => {
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
    // What app.create_tenant does for a company made through the app.
    await admin`select app.seed_tax_defaults(${tenantA}, ${ids.ownerA}), app.seed_tax_defaults(${tenantB}, ${ids.ownerB})`;
    const categories = await admin<{ id: string; kind: string }[]>`select id, kind from public.tax_categories where tenant_id = ${tenantA}`;
    standard = categories.find((c) => c.kind === "standard")!.id;
    exempt = categories.find((c) => c.kind === "exempt")!.id;
    zeroRated = categories.find((c) => c.kind === "zero_rated")!.id;
  });

  afterAll(async () => {
    const made = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(
      admin,
      made.map((r) => r.id),
    );
    await admin.end();
    await closeDb();
  }, 120_000);

  it("gives a company made through the app its starting tax rows, all dated 1 July 2026", async () => {
    const created = await withTenant(ids.founder, null, (tx) =>
      tx.execute<{ id: string }>(sql`select app.create_tenant(${PREFIX + " C"}, ${"founder@tax.test"}) as id`),
    );
    const tenantC = created[0].id;
    const rates = await admin`
      select c.name, c.kind, r.effective_from::text as "from", r.rate::text, r.further_tax_rate::text as further, r.created_by
      from public.tax_rates r join public.tax_categories c on c.tenant_id = r.tenant_id and c.id = r.category_id
      where r.tenant_id = ${tenantC} order by c.kind`;
    expect(rates).toEqual([
      { name: "Standard rate", kind: "standard", from: START, rate: "18.0000", further: "4.0000", created_by: ids.founder },
      { name: "Third Schedule (retail price)", kind: "third_schedule", from: START, rate: "18.0000", further: "0.0000", created_by: ids.founder },
      { name: "Zero-rated", kind: "zero_rated", from: START, rate: "0.0000", further: "0.0000", created_by: ids.founder },
      { name: "Exempt", kind: "exempt", from: START, rate: "0.0000", further: "0.0000", created_by: ids.founder },
    ]);
    // Every line, so a slip in the seed cannot pass unnoticed: code, percent, percent when the
    // supplier is not on the Active Taxpayers List, and what the percent is taken of.
    const rules = await admin<{ line: string; dated: string; created_by: string }[]>`
      select concat_ws(' | ', code, rate::float, coalesce(rate_non_atl::float::text, '-'), base) as line,
        effective_from::text as dated, created_by
      from public.withholding_rules where tenant_id = ${tenantC} order by kind, code`;
    expect(rules.map((r) => r.line)).toEqual([
      "income_tax.contracts.company | 7.5 | 15 | gross_amount",
      "income_tax.contracts.non_company | 8 | 16 | gross_amount",
      "income_tax.contracts.sportsperson | 15 | 30 | gross_amount",
      "income_tax.goods.company | 5 | 10 | gross_amount",
      "income_tax.goods.non_company | 5.5 | 11 | gross_amount",
      "income_tax.goods.rice_oils | 1.5 | 3 | gross_amount",
      "income_tax.services.it | 4 | 8 | gross_amount",
      "income_tax.services.listed | 7 | 14 | gross_amount",
      "income_tax.services.media_advertising | 1.5 | 3 | gross_amount",
      "income_tax.services.other | 14 | 28 | gross_amount",
      "income_tax.services.port_terminal | 12 | 24 | gross_amount",
      "income_tax.services.professional | 15 | 30 | gross_amount",
      "income_tax.toll_manufacturing.company | 9 | 18 | gross_amount",
      "income_tax.toll_manufacturing.non_company | 11 | 22 | gross_amount",
      "sales_tax.active_distributor | 10 | - | sales_tax",
      "sales_tax.active_taxpayer | 20 | - | sales_tax",
      "sales_tax.advertisement | 100 | - | sales_tax",
      "sales_tax.not_active_taxpayer | 5 | - | gross_amount",
      "provincial_sales_tax.balochistan | 15 | - | taxable_value",
      "provincial_sales_tax.khyber_pakhtunkhwa | 15 | - | taxable_value",
      "provincial_sales_tax.punjab | 16 | - | taxable_value",
      "provincial_sales_tax.sindh | 15 | - | taxable_value",
    ]);
    expect(rules.every((r) => r.dated === START && r.created_by === ids.founder)).toBe(true);

    // Seeding twice changes nothing, and the app cannot call the seeding itself.
    const before = await admin`select count(*)::int as n from public.withholding_rules where tenant_id = ${tenantC}`;
    await admin`select app.seed_tax_defaults(${tenantC}, ${ids.founder})`;
    expect(await admin`select count(*)::int as n from public.withholding_rules where tenant_id = ${tenantC}`).toEqual(before);
    expect(await admin`select count(*)::int as n from public.tax_categories where tenant_id = ${tenantC}`).toEqual([{ n: 4 }]);
    expect(
      await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.execute(sql`select app.seed_tax_defaults(${tenantB}::uuid, ${ids.ownerA}::uuid)`))),
    ).toBe(DENIED);
  }, 120_000);

  it("shows the tables to an owner, an accountant and an auditor, with the row in force marked", async () => {
    const { categories, rates, rules } = await listTaxTables(auditor, TODAY);
    expect(categories.map((c) => [c.name, c.kind])).toEqual([
      ["Standard rate", "standard"],
      ["Third Schedule (retail price)", "third_schedule"],
      ["Zero-rated", "zero_rated"],
      ["Exempt", "exempt"],
    ]);
    expect(rates).toHaveLength(4);
    expect(rates.every((r) => r.inForce && r.effectiveFrom === START)).toBe(true);
    const goods = rules.find((r) => r.code === GOODS_COMPANY)!;
    expect([goods.kind, goods.base, goods.rate.toFixed(), goods.rateNonAtl?.toFixed(), goods.inForce]).toEqual([
      "income_tax",
      "gross_amount",
      "5",
      "10",
      true,
    ]);
    // Nothing applies yet on a day before the first rows.
    expect((await listTaxTables(owner, "2026-06-30")).rates.some((r) => r.inForce)).toBe(false);
    expect((await listTaxTables(accountant, TODAY)).rules.length).toBe(rules.length);
    await expect(listTaxTables(sales, TODAY)).rejects.toBeInstanceOf(UserError);
  }, 120_000);

  it("gives an invoice dated before a change the old rate", async () => {
    const on = async (date: string) => {
      // Asked as a salesperson: whoever writes the invoice needs the rate.
      const found = await getTaxRateOn(sales, standard, date);
      return found ? [found.rate.toFixed(), found.furtherTaxRate.toFixed(), found.effectiveFrom] : null;
    };
    expect(await on(TODAY)).toEqual(["18", "4", START]);

    // The standard rate changes on 1 January 2027.
    const { id } = await setTaxRate(accountant, {
      categoryId: standard,
      effectiveFrom: "2027-01-01",
      rate: "19",
      furtherTaxRate: "4",
      legalReference: "Finance (Supplementary) Act 2027",
    });

    expect(await on("2026-12-31")).toEqual(["18", "4", START]); // dated before the change: the old rate
    expect(await on(TODAY)).toEqual(["18", "4", START]);
    expect(await on(START)).toEqual(["18", "4", START]);
    expect(await on("2027-01-01")).toEqual(["19", "4", "2027-01-01"]); // on the day
    expect(await on("2031-05-05")).toEqual(["19", "4", "2027-01-01"]);
    expect(await on("2026-06-30")).toBeNull(); // before the first row: nothing to use
    expect((await getTaxRateOn(sales, standard, TODAY))?.kind).toBe("standard");
    expect(await getTaxRateOn(sales, randomUUID(), TODAY)).toBeNull();
    expect(await getTaxRateOn(sales, standard, "12-11-2026")).toBeNull();

    // The database lookup and the pure rule in rules.ts give the same answer on every date.
    const listed = (await listTaxTables(owner, TODAY)).rates;
    for (const date of ["2026-06-30", START, TODAY, "2026-12-31", "2027-01-01", "2031-05-05"]) {
      const pure = taxRateOn(listed, standard, date);
      expect(await on(date), date).toEqual(pure ? [pure.rate.toFixed(), pure.furtherTaxRate.toFixed(), pure.effectiveFrom] : null);
    }

    // The list marks which row applies on the day asked about.
    const marks = async (date: string) =>
      (await listTaxTables(owner, date)).rates.filter((r) => r.categoryId === standard).map((r) => [r.effectiveFrom, r.inForce]);
    expect(await marks(TODAY)).toEqual([
      ["2027-01-01", false],
      [START, true],
    ]);
    expect(await marks("2027-02-01")).toEqual([
      ["2027-01-01", true],
      [START, false],
    ]);

    const audited = await admin`select actor_user_id, actor_role, action, before, after from public.audit_log where entity_id = ${id}`;
    expect(audited).toEqual([
      {
        actor_user_id: ids.accountantA,
        actor_role: "accountant",
        action: "tax_rate.set",
        before: null,
        after: {
          category: "Standard rate",
          effectiveFrom: "2027-01-01",
          rate: "19.0000",
          furtherTaxRate: "4.0000",
          legalReference: "Finance (Supplementary) Act 2027",
        },
      },
    ]);
  }, 120_000);

  it("corrects a rate saved for the same date and keeps both values in the audit log", async () => {
    const again = await setTaxRate(owner, {
      categoryId: standard,
      effectiveFrom: "2027-01-01",
      rate: "19.5",
      furtherTaxRate: "4",
      legalReference: "Finance (Supplementary) Act 2027, as passed",
    });
    const [row] = await admin`
      select rate::text, further_tax_rate::text as further, created_by, updated_by from public.tax_rates where id = ${again.id}`;
    expect(row).toEqual({ rate: "19.5000", further: "4.0000", created_by: ids.accountantA, updated_by: ids.ownerA });
    expect(await admin`select count(*)::int as n from public.tax_rates where category_id = ${standard}`).toEqual([{ n: 2 }]);
    const audited = await admin`select before->>'rate' as was, after->>'rate' as now from public.audit_log where entity_id = ${again.id} order by at`;
    expect(audited).toEqual([
      { was: null, now: "19.0000" },
      { was: "19.0000", now: "19.5000" },
    ]);
  }, 120_000);

  it("refuses a rate that makes no sense", async () => {
    const good = { categoryId: standard, effectiveFrom: "2027-07-01", rate: "20", furtherTaxRate: "4", legalReference: "Finance Act 2027" };
    await expect(setTaxRate(owner, { ...good, rate: "18%" })).rejects.toThrow("Enter the rate as a plain number, such as 18 or 5.5.");
    await expect(setTaxRate(owner, { ...good, rate: "101" })).rejects.toThrow("A rate cannot be more than 100.");
    await expect(setTaxRate(owner, { ...good, rate: "0" })).rejects.toThrow("Enter a rate above 0, or make the category exempt or zero-rated.");
    await expect(setTaxRate(owner, { ...good, furtherTaxRate: "four" })).rejects.toThrow("Further tax: Enter the rate as a plain number, such as 18 or 5.5.");
    // Left empty, the further tax is asked for; it is never quietly dropped to zero.
    await expect(setTaxRate(owner, { ...good, furtherTaxRate: " " })).rejects.toThrow("Enter the further tax rate, or 0 if there is none.");
    await expect(setTaxRate(owner, { ...good, furtherTaxRate: null })).rejects.toThrow("Enter the further tax rate, or 0 if there is none.");
    await expect(setTaxRate(owner, { ...good, effectiveFrom: "2027-02-30" })).rejects.toThrow("Enter the date the rate applies from.");
    await expect(setTaxRate(owner, { ...good, legalReference: " " })).rejects.toThrow("Say which law or SRO sets this rate.");
    await expect(setTaxRate(owner, { ...good, categoryId: exempt })).rejects.toThrow("Exempt goods carry no tax. Leave both rates at 0.");
    await expect(setTaxRate(owner, { ...good, categoryId: randomUUID() })).rejects.toThrow("Choose a category from this company.");
    await expect(setTaxRate(sales, good)).rejects.toBeInstanceOf(UserError);
    await expect(setTaxRate(auditor, good)).rejects.toBeInstanceOf(UserError);
    expect(await admin`select 1 from public.tax_rates where tenant_id = ${tenantA} and effective_from = '2027-07-01'`).toHaveLength(0);
  }, 120_000);

  it("lets a zero-rated category carry further tax, as the law can, but never a rate", async () => {
    const further = { categoryId: zeroRated, effectiveFrom: "2027-01-01", rate: "0", furtherTaxRate: "4", legalReference: "Sales Tax Act 1990, s.3(1A)" };
    await expect(setTaxRate(owner, { ...further, rate: "5" })).rejects.toThrow("Zero-rated goods are taxed at 0. Leave the rate at 0.");
    await setTaxRate(accountant, further);
    const before = (await getTaxRateOn(sales, zeroRated, "2026-12-31"))!;
    const after = (await getTaxRateOn(sales, zeroRated, "2027-01-01"))!;
    expect([before.rate.toFixed(), before.furtherTaxRate.toFixed()]).toEqual(["0", "0"]);
    expect([after.kind, after.rate.toFixed(), after.furtherTaxRate.toFixed()]).toEqual(["zero_rated", "0", "4"]);
  }, 120_000);

  it("adds a reduced-rate category with the SRO that gives it and its first rate", async () => {
    const reduced = {
      name: "Reduced rate 10%",
      kind: "reduced",
      sroScheduleNo: "Eighth Schedule",
      sroItemSerial: "73",
      effectiveFrom: START,
      rate: "10",
      furtherTaxRate: "0",
      legalReference: "Sales Tax Act 1990, Eighth Schedule",
    };
    await expect(addTaxCategory(owner, { ...reduced, furtherTaxRate: "" })).rejects.toThrow("Enter the further tax rate, or 0 if there is none.");
    await expect(addTaxCategory(owner, { ...reduced, sroScheduleNo: " " })).rejects.toThrow("Enter the schedule or SRO that gives this reduced rate.");
    await expect(addTaxCategory(owner, { ...reduced, kind: "luxury" })).rejects.toThrow("Choose the kind of category.");
    await expect(addTaxCategory(owner, { ...reduced, kind: "exempt" })).rejects.toThrow("Exempt goods carry no tax. Leave both rates at 0.");
    await expect(addTaxCategory(sales, reduced)).rejects.toBeInstanceOf(UserError);
    expect(await admin`select 1 from public.tax_categories where tenant_id = ${tenantA} and name = ${reduced.name}`).toHaveLength(0);

    const { id } = await addTaxCategory(accountant, reduced);
    await expect(addTaxCategory(owner, reduced)).rejects.toThrow("A category with this name already exists.");
    await expect(addTaxCategory(owner, { ...reduced, name: "REDUCED RATE 10%" })).rejects.toThrow("A category with this name already exists.");
    await expect(addTaxCategory(owner, { ...reduced, name: "standard rate" })).rejects.toThrow("A category with this name already exists.");
    expect((await getTaxRateOn(sales, id, TODAY))?.rate.toFixed()).toBe("10");
    const [stored] = await admin`
      select c.kind, c.sro_schedule_no, c.sro_item_serial, c.created_by, r.rate::text, r.legal_reference
      from public.tax_categories c join public.tax_rates r on r.category_id = c.id where c.id = ${id}`;
    expect(stored).toEqual({
      kind: "reduced",
      sro_schedule_no: "Eighth Schedule",
      sro_item_serial: "73",
      created_by: ids.accountantA,
      rate: "10.0000",
      legal_reference: "Sales Tax Act 1990, Eighth Schedule",
    });
    const audited = await admin`select action, after->>'name' as name, after->>'rate' as rate from public.audit_log where entity_id = ${id}`;
    expect(audited).toEqual([{ action: "tax_category.add", name: "Reduced rate 10%", rate: "10.0000" }]);
  }, 120_000);

  it("looks a withholding rule up by date, with the higher rate for a supplier not on the ATL", async () => {
    const on = async (date: string) => {
      const rule = await getWithholdingRuleOn(sales, GOODS_COMPANY, date);
      return rule ? [withholdingRateFor(rule, true).toFixed(), withholdingRateFor(rule, false).toFixed(), rule.base, rule.effectiveFrom] : null;
    };
    expect(await on(TODAY)).toEqual(["5", "10", "gross_amount", START]);

    const good = { code: GOODS_COMPANY, effectiveFrom: "2027-07-01", rate: "6", rateNonAtl: "12", legalReference: "Finance Act 2027" };
    await expect(setWithholdingRate(owner, { ...good, code: "income_tax.goods.martian" })).rejects.toThrow("Choose a rule from the list.");
    await expect(setWithholdingRate(owner, { ...good, code: "x; drop" })).rejects.toThrow("Choose a rule.");
    await expect(setWithholdingRate(owner, { ...good, rateNonAtl: "5" })).rejects.toThrow(
      "The rate for a supplier who is not on the Active Taxpayers List cannot be lower than the normal rate.",
    );
    // Left empty on an income tax rule, the second rate is asked for; it never quietly becomes "the same".
    await expect(setWithholdingRate(owner, { ...good, rateNonAtl: "" })).rejects.toThrow(
      "Enter the rate for a supplier who is not on the Active Taxpayers List. It is normally double.",
    );
    await expect(setWithholdingRate(sales, good)).rejects.toBeInstanceOf(UserError);
    await expect(setWithholdingRate(auditor, good)).rejects.toBeInstanceOf(UserError);

    const { id } = await setWithholdingRate(accountant, good);
    expect(await on("2027-06-30")).toEqual(["5", "10", "gross_amount", START]); // dated before the change: the old rate
    expect(await on("2027-07-01")).toEqual(["6", "12", "gross_amount", "2027-07-01"]);
    expect(await on("2026-06-30")).toBeNull();
    expect(await getWithholdingRuleOn(sales, "income_tax.goods.martian", TODAY)).toBeNull();

    // The new row keeps the rule's kind, wording and base; only the rates and the reference are new.
    const rows = await admin`
      select kind, label, base, rate::text, rate_non_atl::text as non_atl, legal_reference from public.withholding_rules
      where tenant_id = ${tenantA} and code = ${GOODS_COMPANY} order by effective_from`;
    expect(rows).toHaveLength(2);
    expect([rows[1].kind, rows[1].label, rows[1].base]).toEqual([rows[0].kind, rows[0].label, rows[0].base]);
    expect([rows[1].rate, rows[1].non_atl, rows[1].legal_reference]).toEqual(["6.0000", "12.0000", "Finance Act 2027"]);

    // Saving the same date again corrects it.
    const again = await setWithholdingRate(owner, { ...good, rate: "6.5", rateNonAtl: "13" });
    expect(again.id).toBe(id);
    const corrected = (await getWithholdingRuleOn(sales, GOODS_COMPANY, "2027-07-01"))!;
    expect([withholdingRateFor(corrected, true).toFixed(), withholdingRateFor(corrected, false).toFixed()]).toEqual(["6.5", "13"]);

    // The database lookup and the pure rule in rules.ts agree.
    const listedRules = (await listTaxTables(owner, TODAY)).rules;
    for (const date of ["2026-06-30", START, "2027-06-30", "2027-07-01", "2031-05-05"]) {
      const pure = withholdingRuleOn(listedRules, GOODS_COMPANY, date);
      const found = await getWithholdingRuleOn(sales, GOODS_COMPANY, date);
      expect(found ? [found.rate.toFixed(), found.effectiveFrom] : null, date).toEqual(pure ? [pure.rate.toFixed(), pure.effectiveFrom] : null);
    }

    // A sales tax rule has one rate for every supplier: a second rate is refused, none is fine.
    const registered = { code: "sales_tax.active_taxpayer", effectiveFrom: "2027-07-01", rate: "25", rateNonAtl: "", legalReference: "Finance Act 2027" };
    await expect(setWithholdingRate(owner, { ...registered, rateNonAtl: "50" })).rejects.toThrow(
      "This rule has one rate for every supplier. Leave the second rate empty.",
    );
    await setWithholdingRate(owner, registered);
    const salesTax = (await getWithholdingRuleOn(sales, "sales_tax.active_taxpayer", "2027-07-01"))!;
    expect([salesTax.base, salesTax.rate.toFixed(), salesTax.rateNonAtl]).toEqual(["sales_tax", "25", null]);
    expect((await getWithholdingRuleOn(sales, "sales_tax.active_taxpayer", "2027-06-30"))?.rate.toFixed()).toBe("20");
    const audited = await admin`select actor_role, before->>'rate' as was, after->>'rate' as now from public.audit_log where entity_id = ${id} order by at`;
    expect(audited).toEqual([
      { actor_role: "accountant", was: null, now: "6.0000" },
      { actor_role: "owner", was: "6.0000", now: "6.5000" },
    ]);
  }, 120_000);

  it("keeps the same rules in the database, whatever the app does", async () => {
    const rate = { tenantId: tenantA, categoryId: standard, effectiveFrom: "2028-01-01", rate: "21", furtherTaxRate: "4", legalReference: "direct" };
    const rule = { tenantId: tenantA, kind: "income_tax" as const, code: "income_tax.direct.test", label: "Direct", effectiveFrom: "2028-01-01", base: "gross_amount" as const, rate: "1", legalReference: "direct" };
    // A salesperson and an auditor may read but not write.
    expect((await withTenant(ids.salesA, tenantA, (tx) => tx.select().from(taxRates))).length).toBeGreaterThan(0);
    expect((await withTenant(ids.salesA, tenantA, (tx) => tx.select().from(withholdingRules))).length).toBeGreaterThan(0);
    for (const who of [ids.salesA, ids.auditorA]) {
      const by = { createdBy: who, updatedBy: who };
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(taxRates).values({ ...rate, ...by })))).toBe(DENIED);
      expect(await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(withholdingRules).values({ ...rule, ...by })))).toBe(DENIED);
      expect(
        await codeOf(() => withTenant(who, tenantA, (tx) => tx.insert(taxCategories).values({ tenantId: tenantA, name: "Direct", kind: "standard", createdBy: who }))),
      ).toBe(DENIED);
      // An update they may not make touches no rows.
      await withTenant(who, tenantA, (tx) => tx.update(taxRates).set({ rate: "99", updatedBy: who }).where(eq(taxRates.tenantId, tenantA)));
      await withTenant(who, tenantA, (tx) => tx.update(withholdingRules).set({ rate: "99", updatedBy: who }).where(eq(withholdingRules.tenantId, tenantA)));
    }
    const asOwner = { createdBy: ids.ownerA, updatedBy: ids.ownerA };
    // An owner may not sign as someone else.
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(taxRates).values({ ...rate, createdBy: ids.ownerB, updatedBy: ids.ownerA })))).toBe(DENIED);
    // An exempt category never gets a rate, a taxed one never gets zero, and no rate leaves 0 to 100.
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(taxRates).values({ ...rate, categoryId: exempt, ...asOwner })))).toBe(CHECK);
    expect(
      await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(taxRates).values({ ...rate, categoryId: exempt, rate: "0", ...asOwner }))),
    ).toBe(CHECK);
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(taxRates).values({ ...rate, categoryId: zeroRated, ...asOwner })))).toBe(CHECK);
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(taxRates).values({ ...rate, rate: "0", ...asOwner })))).toBe(CHECK);
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(taxRates).values({ ...rate, rate: "100.5", ...asOwner })))).toBe(CHECK);
    expect(
      await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.update(taxRates).set({ rate: "0", updatedBy: ids.ownerA }).where(eq(taxRates.categoryId, standard)))),
    ).toBe(CHECK);
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(withholdingRules).values({ ...rule, rate: "120", ...asOwner })))).toBe(CHECK);
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(withholdingRules).values({ ...rule, code: "No Dots", ...asOwner })))).toBe(CHECK);
    // A reduced-rate category must name its SRO.
    expect(
      await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.insert(taxCategories).values({ tenantId: tenantA, name: "Reduced, no SRO", kind: "reduced", createdBy: ids.ownerA }))),
    ).toBe(CHECK);
    // A category is never rewritten; the date and the category or code of a rate cannot be changed; nothing is deletable.
    expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.update(taxCategories).set({ kind: "exempt" })))).toBe(DENIED);
    for (const change of [{ effectiveFrom: "2020-01-01" }, { categoryId: exempt }, { tenantId: tenantB }, { createdBy: ids.ownerB }]) {
      expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.update(taxRates).set(change)))).toBe(DENIED);
    }
    for (const change of [{ effectiveFrom: "2020-01-01" }, { code: "income_tax.other.line" }, { base: "sales_tax" as const }, { label: "Renamed" }]) {
      expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.update(withholdingRules).set(change)))).toBe(DENIED);
    }
    for (const table of [taxCategories, taxRates, withholdingRules]) {
      expect(await codeOf(() => withTenant(ids.ownerA, tenantA, (tx) => tx.delete(table)))).toBe(DENIED);
    }

    const untouched = await admin`select count(*)::int as n, max(rate)::text as highest from public.tax_rates where tenant_id = ${tenantA}`;
    expect(untouched).toEqual([{ n: 7, highest: "19.5000" }]);
    expect(await admin`select 1 from public.withholding_rules where tenant_id = ${tenantA} and (rate = 99 or code = ${rule.code})`).toHaveLength(0);
  }, 120_000);

  it("keeps each company's tax tables to itself", async () => {
    const { id: reducedB } = await addTaxCategory(otherOwner, {
      name: "Reduced rate 5%",
      kind: "reduced",
      sroScheduleNo: "Eighth Schedule",
      sroItemSerial: "",
      effectiveFrom: START,
      rate: "5",
      furtherTaxRate: "0",
      legalReference: "Other company's SRO",
    });
    // Company A's changes never reached B: B still has its own starting rows.
    const b = await listTaxTables(otherOwner, "2027-07-01");
    expect(b.rates.filter((r) => r.inForce).map((r) => r.rate.toFixed()).sort()).toEqual(["0", "0", "18", "18", "5"]);
    expect(b.rules.find((r) => r.code === GOODS_COMPANY && r.inForce)?.rate.toFixed()).toBe("5");

    // A never sees B's rows, by list, by lookup, or with B's id as the context.
    const a = await listTaxTables(owner, TODAY);
    expect(a.categories.some((c) => c.id === reducedB)).toBe(false);
    expect(await getTaxRateOn(owner, reducedB, TODAY)).toBeNull();
    expect(await withTenant(ids.ownerA, tenantB, (tx) => tx.select().from(taxCategories))).toEqual([]);
    expect(await withTenant(ids.ownerA, tenantB, (tx) => tx.select().from(taxRates))).toEqual([]);
    expect(await withTenant(ids.ownerA, tenantB, (tx) => tx.select().from(withholdingRules))).toEqual([]);
    // And cannot write against B's category, through the command or directly, as A or as B.
    await expect(
      setTaxRate(owner, { categoryId: reducedB, effectiveFrom: "2027-01-01", rate: "6", furtherTaxRate: "0", legalReference: "Not mine" }),
    ).rejects.toThrow("Choose a category from this company.");
    for (const context of [tenantA, tenantB]) {
      expect(
        await codeOf(() =>
          withTenant(ids.ownerA, context, (tx) =>
            tx.insert(taxRates).values({
              tenantId: context,
              categoryId: reducedB,
              effectiveFrom: "2027-01-01",
              rate: "6",
              legalReference: "Not mine",
              createdBy: ids.ownerA,
              updatedBy: ids.ownerA,
            }),
          ),
        ),
      ).toMatch(/^(42501|23503)$/);
    }
    expect(await admin`select count(*)::int as n from public.tax_rates where category_id = ${reducedB}`).toEqual([{ n: 1 }]);
  }, 120_000);
});
