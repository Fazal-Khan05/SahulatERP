import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { railLabels, signIn, test } from "./support/ui";

// Step 6 on screen. The lookup rule itself (a document dated before a change keeps the old rate)
// is proved in src/modules/tax/rules.test.ts and tax.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let accountant: TestUser;
let auditor: TestUser;
let seller: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("tax-owner", { canCreateCompany: true });
  accountant = await createUser("tax-accountant", { canCreateCompany: false });
  auditor = await createUser("tax-auditor", { canCreateCompany: false });
  seller = await createUser("tax-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("a new company starts with the tax tables, and its owner changes a rate from a date", async ({ page }) => {
  await signIn(page, owner);
  await page.getByLabel("Company name").fill("E2E Tax Traders");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText("E2E Tax Traders");
  const tenants = await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`;
  tenantId = tenants[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id}),
    (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;

  await page.goto("/settings/tax");
  const salesTax = page.getByRole("table", { name: "Sales tax rates" });
  // The starting rows: the four kinds of category, each with a rate from 1 July 2026.
  await expect(salesTax.getByRole("row")).toHaveText([
    /Category/,
    /Standard rate.*01-07-2026\s*18%\s*4%.*In force/,
    /Third Schedule.*01-07-2026\s*18%\s*None.*In force/,
    /Zero-rated.*01-07-2026\s*0%\s*None.*In force/,
    /Exempt.*01-07-2026\s*0%\s*None.*In force/,
  ]);
  const incomeTax = page.getByRole("table", { name: "Income tax on payments (section 153)" });
  await expect(incomeTax.getByRole("row").filter({ hasText: "Goods, from a company" })).toContainText("In force");
  await expect(page.getByRole("table", { name: "Provincial sales tax on services" }).getByRole("row").filter({ hasText: "Punjab" }).first()).toContainText("16%");

  // A rate from a date still to come: the row in force stays, the new one waits.
  const changeRate = page.locator("form").filter({ has: page.getByRole("button", { name: "Save sales tax rate" }) });
  await changeRate.getByLabel("Category").selectOption({ label: "Standard rate" });
  await changeRate.getByLabel("From date").fill("2099-07-01");
  await changeRate.getByLabel("Rate %").fill("19");
  await changeRate.getByLabel("Further tax %").fill("4");
  await changeRate.getByLabel("Law or SRO").fill("Finance Act 2099");
  await changeRate.getByRole("button", { name: "Save sales tax rate" }).click();
  const standard = salesTax.getByRole("row").filter({ hasText: "Standard rate" });
  await expect(standard).toHaveText([/01-07-2099\s*19%\s*4%\s*Finance Act 2099\s*Not yet/, /01-07-2026\s*18%\s*4%.*In force/]);

  // A rate from a date already past takes over; the one before it is kept, marked as replaced.
  await changeRate.getByLabel("Category").selectOption({ label: "Standard rate" });
  await changeRate.getByLabel("From date").fill("2026-10-01");
  await changeRate.getByLabel("Rate %").fill("17.5");
  await changeRate.getByLabel("Further tax %").fill("4");
  await changeRate.getByLabel("Law or SRO").fill("SRO 1(I)/2026");
  await changeRate.getByRole("button", { name: "Save sales tax rate" }).click();
  await expect(standard).toHaveText([
    /01-07-2099\s*19%.*Not yet/,
    /01-10-2026\s*17\.5%\s*4%\s*SRO 1\(I\)\/2026\s*In force/,
    /01-07-2026\s*18%\s*4%.*Replaced/,
  ]);

  // A rate that is not a plain number, and a rate on an exempt category, are refused; nothing is stored.
  await changeRate.getByLabel("Category").selectOption({ label: "Standard rate" });
  await changeRate.getByLabel("From date").fill("2026-11-01");
  await changeRate.getByLabel("Rate %").fill("18%");
  await changeRate.getByLabel("Further tax %").fill("4");
  await changeRate.getByLabel("Law or SRO").fill("Typing mistake");
  await changeRate.getByRole("button", { name: "Save sales tax rate" }).click();
  await expect(changeRate.getByTestId("form-error")).toHaveText("Enter the rate as a plain number, such as 18 or 5.5.");
  await changeRate.getByLabel("Category").selectOption({ label: "Exempt" });
  await changeRate.getByLabel("Rate %").fill("5");
  await changeRate.getByRole("button", { name: "Save sales tax rate" }).click();
  await expect(changeRate.getByTestId("form-error")).toHaveText("Exempt goods carry no tax. Leave both rates at 0.");
  expect(
    await sql`
      select r.effective_from::text as "from", r.rate::text from public.tax_rates r
      join public.tax_categories c on c.tenant_id = r.tenant_id and c.id = r.category_id
      where r.tenant_id = ${tenantId} and c.kind in ('standard', 'exempt') order by c.kind, r.effective_from`,
  ).toEqual([
    { from: "2026-07-01", rate: "18.0000" },
    { from: "2026-10-01", rate: "17.5000" },
    { from: "2099-07-01", rate: "19.0000" },
    { from: "2026-07-01", rate: "0.0000" },
  ]);
});

test("an owner adds a reduced-rate category with the SRO that gives it", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/settings/tax");
  const add = page.locator("form").filter({ has: page.getByRole("button", { name: "Add category" }) });
  await add.getByLabel("Name").fill("Reduced rate 10%");
  await add.getByLabel("From date").fill("2026-07-01");
  await add.getByLabel("Rate %").fill("10");
  await add.getByLabel("Further tax %").fill("0");
  await add.getByLabel("Law or SRO").fill("Sales Tax Act 1990, Eighth Schedule");
  await add.getByRole("button", { name: "Add category" }).click();
  await expect(add.getByTestId("form-error")).toHaveText("Enter the schedule or SRO that gives this reduced rate.");

  await add.getByLabel("Schedule or SRO").fill("Eighth Schedule");
  await add.getByLabel("Serial in the schedule").fill("73");
  await add.getByRole("button", { name: "Add category" }).click();
  const row = page.getByRole("table", { name: "Sales tax rates" }).getByRole("row").filter({ hasText: "Reduced rate 10%" });
  await expect(row).toHaveText(/Reduced rate 10%.*Eighth Schedule · 73\s*01-07-2026\s*10%\s*None.*In force/);
  // The new category can be chosen wherever a category is asked for.
  await expect(page.getByLabel("Category").getByRole("option", { name: "Reduced rate 10%" })).toBeAttached();
});

test("an accountant reaches the tax rates from their menu and changes a withholding rate", async ({ page }) => {
  await signIn(page, accountant);
  expect(await railLabels(page)).toContain("Tax rates");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tax rates" }).click();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link")).toHaveText(["Currencies", "Tax", "Fiscal periods", "Branches"]);

  const change = page.locator("form").filter({ has: page.getByRole("button", { name: "Save withholding rate" }) });
  await change.getByLabel("Rule").selectOption({ label: "Goods, from a company" });
  await change.getByLabel("From date").fill("2026-10-01");
  await change.getByLabel("Rate %", { exact: true }).fill("6");
  await change.getByLabel("Rate % when not on the ATL").fill("5");
  await change.getByLabel("Law or SRO").fill("Finance Act (test)");
  await change.getByRole("button", { name: "Save withholding rate" }).click();
  await expect(change.getByTestId("form-error")).toHaveText(
    "The rate for a supplier who is not on the Active Taxpayers List cannot be lower than the normal rate.",
  );
  await change.getByLabel("Rate % when not on the ATL").fill("12");
  await change.getByRole("button", { name: "Save withholding rate" }).click();

  const rows = page
    .getByRole("table", { name: "Income tax on payments (section 153)" })
    .getByRole("row")
    .filter({ hasText: "Goods, from a company" });
  await expect(rows).toHaveText([/01-10-2026\s*6%\s*12%.*Finance Act \(test\)\s*In force/, /01-07-2026.*Replaced/]);
  // Only income tax has a second rate for suppliers who are not on the list.
  await expect(page.getByRole("table", { name: "Income tax on payments (section 153)" }).getByRole("columnheader", { name: "Not on the ATL" })).toHaveCount(1);
  await expect(page.getByRole("table", { name: "Sales tax withheld (Eleventh Schedule)" }).getByRole("columnheader", { name: "Not on the ATL" })).toHaveCount(0);
  // The change is in the audit log under the accountant's name.
  const audited = await sql`
    select after->>'code' as code, after->>'rate' as rate, after->>'rateNonAtl' as "nonAtl" from public.audit_log
    where tenant_id = ${tenantId} and action = 'withholding_rule.set' and actor_user_id = ${accountant.id}`;
  expect(audited).toEqual([{ code: "income_tax.goods.company", rate: "6.0000", nonAtl: "12.0000" }]);
});

test("an auditor reads the tax rates and cannot change them; a salesperson has no way in", async ({ page }) => {
  await signIn(page, auditor);
  await page.goto("/settings/tax");
  await expect(page.getByRole("table", { name: "Sales tax rates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save sales tax rate" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add category" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save withholding rate" })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, seller);
  expect(await railLabels(page)).not.toContain("Tax rates");
  await page.goto("/settings/tax");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see the tax rates.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Sales tax rates" })).toHaveCount(0);
});
