import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { railLabels, signIn, test } from "./support/ui";

// Step 5 on screen. The lookup rule itself (the latest rate on or before a date) is proved in
// src/modules/currencies/rules.test.ts and currencies.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let accountant: TestUser;
let seller: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("fx-owner", { canCreateCompany: true });
  accountant = await createUser("fx-accountant", { canCreateCompany: false });
  seller = await createUser("fx-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("an owner chooses the base currency once, adds a currency and sets its rates", async ({ page }) => {
  await signIn(page, owner);
  await page.getByLabel("Company name").fill("E2E Currency Traders");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText("E2E Currency Traders");
  const tenants = await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`;
  tenantId = tenants[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;

  await page.goto("/settings/currencies");
  await expect(page.getByLabel("Code")).toHaveValue("PKR");
  await page.getByRole("button", { name: "Set base currency" }).click();

  const currencies = page.getByRole("table", { name: "Currencies" });
  await expect(currencies.getByRole("row").filter({ hasText: "PKR" })).toContainText("Base currency");
  // The base currency is fixed: there is no longer any way to choose one.
  await expect(page.getByRole("button", { name: "Set base currency" })).toHaveCount(0);
  await expect(page.getByText("Add a currency first.")).toBeVisible();

  const addCurrency = page.locator("form").filter({ has: page.getByRole("button", { name: "Add currency" }) });
  await addCurrency.getByLabel("Code").fill("usd");
  await addCurrency.getByLabel("Name").fill("US Dollar");
  await addCurrency.getByRole("button", { name: "Add currency" }).click();
  await expect(currencies.getByRole("row").filter({ hasText: "USD" })).toContainText("No rate yet");

  await addCurrency.getByLabel("Code").fill("USD");
  await addCurrency.getByLabel("Name").fill("Dollar again");
  await addCurrency.getByRole("button", { name: "Add currency" }).click();
  await expect(addCurrency.getByTestId("form-error")).toHaveText("USD is already in the list.");

  // An older rate first, then a newer one: the list shows the newest, whatever order they were typed in.
  for (const [date, rate] of [
    ["2026-11-10", "279.10"],
    ["2026-10-01", "277"],
  ]) {
    await page.getByLabel("From date").fill(date);
    await page.getByLabel("Rate in PKR").fill(rate);
    await page.getByLabel("Source").fill("Bank counter");
    await page.getByRole("button", { name: "Save rate" }).click();
    await expect(page.getByRole("table", { name: "Rates" }).getByRole("row").filter({ hasText: date.split("-").reverse().join("-") })).toBeVisible();
  }
  const usd = currencies.getByRole("row").filter({ hasText: "USD" });
  await expect(usd).toContainText("279.10");
  await expect(usd).toContainText("10-11-2026");
  await expect(page.getByRole("table", { name: "Rates" }).getByRole("row")).toHaveText([
    /From/,
    /10-11-2026\s*USD\s*279\.10\s*Bank counter/,
    /01-10-2026\s*USD\s*277\.00\s*Bank counter/,
  ]);

  // A rate that is not a plain number is refused and nothing is stored.
  await page.getByLabel("From date").fill("2026-11-11");
  await page.getByLabel("Rate in PKR").fill("1,234");
  await page.getByLabel("Source").fill("Bank counter");
  await page.getByRole("button", { name: "Save rate" }).click();
  await expect(page.locator("form").filter({ has: page.getByRole("button", { name: "Save rate" }) }).getByTestId("form-error")).toHaveText(
    "Enter the rate as a plain number, such as 278.5.",
  );
  expect(await sql`select rate::text from public.exchange_rates where tenant_id = ${tenantId} order by rate_date`).toEqual([
    { rate: "277.00000000" },
    { rate: "279.10000000" },
  ]);
});

test("an accountant reaches exchange rates from their menu and corrects a rate", async ({ page }) => {
  await signIn(page, accountant);
  expect(await railLabels(page)).toContain("Exchange rates");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Exchange rates" }).click();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link")).toHaveText(["Currencies", "Tax", "Branches"]);

  await page.getByLabel("From date").fill("2026-11-10");
  await page.getByLabel("Rate in PKR").fill("279.25");
  await page.getByLabel("Source").fill("State Bank");
  await page.getByRole("button", { name: "Save rate" }).click();
  const corrected = page.getByRole("table", { name: "Rates" }).getByRole("row").filter({ hasText: "10-11-2026" });
  await expect(corrected).toContainText("279.25");
  await expect(corrected).toContainText("State Bank");
  expect(await sql`select count(*)::int as n from public.exchange_rates where tenant_id = ${tenantId}`).toEqual([{ n: 2 }]);
  // The correction is in the audit log with the value it replaced.
  const audited = await sql`
    select before->>'rate' as was, after->>'rate' as now from public.audit_log
    where tenant_id = ${tenantId} and action = 'exchange_rate.set' and actor_user_id = ${accountant.id}`;
  expect(audited).toEqual([{ was: "279.10000000", now: "279.25000000" }]);
});

test("a salesperson has no way to the currencies screen", async ({ page }) => {
  await signIn(page, seller);
  expect(await railLabels(page)).not.toContain("Exchange rates");
  await page.goto("/settings/currencies");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see the currencies.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save rate" })).toHaveCount(0);
});
