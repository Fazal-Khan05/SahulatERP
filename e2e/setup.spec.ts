import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { railLabels, signIn, test } from "./support/ui";

// Step 11 on screen: a new company goes from sign-in to an empty inbox through the setup wizard.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let accountant: TestUser;
let registeredOwner: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("setup-owner", { canCreateCompany: true });
  accountant = await createUser("setup-accountant", { canCreateCompany: false });
  registeredOwner = await createUser("setup-registered", { canCreateCompany: true });
});

test.afterAll(async () => {
  await sql.end();
});

test("a new company reaches an empty inbox in under five minutes", async ({ page }) => {
  const started = Date.now();
  await signIn(page, owner);
  await page.getByLabel("Company name").fill("E2E Setup Traders");
  await page.getByRole("button", { name: "Create company" }).click();
  // Creating the company leads straight into the wizard, with the usual answers filled in.
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up E2E Setup Traders" })).toBeVisible();
  // Whether the company is registered for sales tax is never assumed: nothing is ticked, and the form will not go without it.
  await expect(page.locator('input[name="salesTaxRegistered"]:checked')).toHaveCount(0);
  await page.locator('input[name="salesTaxRegistered"][value="no"]').check();
  await expect(page.getByLabel("Currency code")).toHaveValue("PKR");
  await expect(page.getByLabel("Fiscal year starts in", { exact: true })).toHaveValue("7");
  await expect(page.locator('input[name="bundle"][value="importer"]')).toBeChecked();
  await expect(page.getByLabel("Branch", { exact: true })).toHaveValue("Main");
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByText("Nothing needs your attention.").filter({ visible: true })).toHaveCount(1);
  const elapsed = Date.now() - started;
  expect(elapsed, `sign-in to empty inbox took ${Math.round(elapsed / 1000)} s`).toBeLessThan(5 * 60 * 1000);

  // Everything the wizard promised is there, each part recorded by the module that owns it.
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  const [state] = await sql`
    select (select sales_tax_registered from public.company_setup where tenant_id = ${tenantId}) as registered,
      (select code from public.currencies where tenant_id = ${tenantId} and is_base) as currency,
      (select count(*)::int from public.fiscal_periods where tenant_id = ${tenantId}) as periods,
      (select to_char(min(starts_on), 'MM-DD') from public.fiscal_periods where tenant_id = ${tenantId}) as year_starts,
      (select name from public.branches where tenant_id = ${tenantId}) as branch,
      (select name from public.warehouses where tenant_id = ${tenantId}) as warehouse,
      (select string_agg(module::text, ',' order by module::text) from public.modules_enabled where tenant_id = ${tenantId} and not enabled) as switched_off`;
  expect(state).toEqual({ registered: false, currency: "PKR", periods: 12, year_starts: "07-01", branch: "Main", warehouse: "Main warehouse", switched_off: "commissions" });
  const audited = await sql`select action from public.audit_log where tenant_id = ${tenantId} and action not like 'auth.%' order by at`;
  expect(audited.map((a) => a.action)).toEqual(["tenant.create", "currency.set_base", "fiscal_year.open", "module.update", "branch.create", "warehouse.create", "accounts.seed", "company.setup"]);
  // The menu follows the modules chosen: commissions are not part of Trading with imports.
  expect(await railLabels(page)).not.toContain("Commissions");
  expect(await railLabels(page)).toContain("Purchases and imports");

  // The wizard is asked once.
  await page.goto("/setup");
  await expect(page.getByTestId("setup-done")).toContainText("E2E Setup Traders is set up. It is not registered for sales tax");
  await expect(page.getByRole("button", { name: "Finish setup" })).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByText("Finish setting up")).toHaveCount(0);
});

test("a company registered for sales tax gives its STRN and confirms its rates", async ({ page }) => {
  await signIn(page, registeredOwner);
  await page.getByLabel("Company name").fill("E2E Registered Traders");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await page.locator('input[name="salesTaxRegistered"][value="yes"]').check();
  await page.locator('input[name="taxRatesConfirmed"]').check();
  await page.getByLabel("STRN").fill("11-11-1111-111-11");
  // A year far from today is refused before anything is written: the currency, which could never be undone, is not set.
  await page.getByLabel("Currency code").fill("USD");
  await page.getByLabel("Currency name").fill("US Dollar");
  await page.getByLabel("First fiscal year starts in").fill("2001");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByTestId("form-error")).toContainText("The first fiscal year must start between");
  expect(await sql`select 1 from public.currencies c join public.tenants t on t.id = c.tenant_id where t.created_by = ${registeredOwner.id}`).toHaveLength(0);
  await page.getByLabel("Currency code").fill("PKR");
  await page.getByLabel("Currency name").fill("Pakistani Rupee");
  await page.getByLabel("First fiscal year starts in").fill(String(new Date().getFullYear()));
  await page.locator('input[name="taxRatesConfirmed"]').uncheck();
  await page.getByLabel("STRN").fill("");
  await page.locator('input[name="bundle"][value="full"]').check();
  await page.getByLabel("Fiscal year starts in", { exact: true }).selectOption({ label: "January" });
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("Enter the company's STRN. A company registered for sales tax has one.");
  await page.getByLabel("STRN").fill("11-11-1111-111-11");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("Tick the box to say you have checked the tax rates. They are listed under Settings, Tax.");
  await page.locator('input[name="taxRatesConfirmed"]').check();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/inbox$/);

  const [state] = await sql`
    select s.sales_tax_registered as registered, s.strn, s.tax_rates_confirmed_at is not null as confirmed,
      (select to_char(min(starts_on), 'MM-DD') from public.fiscal_periods p where p.tenant_id = s.tenant_id) as year_starts,
      (select string_agg(module::text, ',' order by module::text) from public.modules_enabled m where m.tenant_id = s.tenant_id and enabled) as switched_on
    from public.company_setup s join public.tenants t on t.id = s.tenant_id where t.created_by = ${registeredOwner.id}`;
  expect(state).toEqual({ registered: true, strn: "1111111111111", confirmed: true, year_starts: "01-01", switched_on: "payroll" });
  expect(await railLabels(page)).toContain("Payroll");
});

test("until the owner finishes, other members are told so and cannot do it for them", async ({ page }) => {
  // A third company, created but not set up, with an accountant in it.
  const fresh = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${owner.id}, true)`;
    return (await tx<{ id: string }[]>`select app.create_tenant('E2E Unfinished Traders', ${owner.email}) as id`)[0];
  });
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${fresh.id}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id})`;
  // The owner had already chosen a currency and a branch by hand; the wizard keeps both.
  await sql`insert into public.currencies (tenant_id, code, name, is_base, created_by) values (${fresh.id}, 'USD', 'US Dollar', true, ${owner.id})`;
  await sql`insert into public.branches (tenant_id, name, created_by) values (${fresh.id}, 'Karachi', ${owner.id})`;
  await signIn(page, accountant);
  await expect(page.getByText("The owner has not finished setting up E2E Unfinished Traders yet.")).toBeVisible();
  await page.goto("/setup");
  await expect(page.getByText("The owner has not finished setting up E2E Unfinished Traders yet.").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Finish setup" })).toHaveCount(0);
});

test("the wizard keeps what is already in place and records it as it is", async ({ page }) => {
  await signIn(page, owner);
  await page.getByLabel("Company").selectOption({ label: "E2E Unfinished Traders" });
  await page.getByRole("button", { name: "Switch" }).click();
  await expect(page.getByTestId("company-name")).toHaveText("E2E Unfinished Traders");
  await page.goto("/setup");
  await expect(page.getByTestId("existing-currency")).toHaveText("The books are already kept in US Dollar (USD).");
  await expect(page.getByTestId("existing-branch")).toHaveText("The company already has the branch Karachi.");
  await expect(page.getByLabel("Currency code")).toHaveCount(0);
  await expect(page.getByLabel("Branch", { exact: true })).toHaveCount(0);
  await page.locator('input[name="salesTaxRegistered"][value="no"]').check();
  await page.locator('input[name="bundle"][value="trading"]').check();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  const [recorded] = await sql`
    select a.after->>'baseCurrency' as currency, a.after->>'branch' as branch, a.after->>'warehouse' as warehouse, a.after->>'modules' as modules
    from public.audit_log a join public.tenants t on t.id = a.tenant_id where t.name = 'E2E Unfinished Traders' and a.action = 'company.setup'`;
  expect(recorded).toEqual({ currency: "USD", branch: "Karachi", warehouse: "Main warehouse", modules: "sales, collections, purchasing, inventory, cash_bank" });
  expect(await sql`select count(*)::int as n from public.currencies c join public.tenants t on t.id = c.tenant_id where t.name = 'E2E Unfinished Traders'`).toEqual([{ n: 1 }]);
});
