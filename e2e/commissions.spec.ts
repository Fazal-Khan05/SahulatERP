import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 37 on screen: the owner sets up a default plan and a plan of a salesperson's own, is
// refused overlapping dates, and says who reports to whom (a circle refused). The accountant reads
// the plans from Reports and cannot change them. What a sale earns on each plan is tested in
// src/modules/commissions/commissions.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let seller: TestUser;
let manager: TestUser;
let accountant: TestUser;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("commissions-owner", { canCreateCompany: true });
  seller = await createUser("commissions-seller", { canCreateCompany: false });
  manager = await createUser("commissions-manager", { canCreateCompany: false });
  accountant = await createUser("commissions-accountant", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const rail = (page: Page) => page.getByRole("navigation", { name: "Main" });
const plans = (page: Page) => shown(page.getByRole("list", { name: "Plans" })).locator("li");

test("the owner sets up a default plan and a salesperson's own, and the sales hierarchy", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Commission Traders");
  const [{ id: tenantId }] = await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id}),
    (${tenantId}, ${manager.id}, ${manager.email}, 'sales_manager', ${owner.id}),
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id})`;

  // A new company finishes setup with Commissions off; the owner switches it on.
  await sql`insert into public.modules_enabled (tenant_id, module, enabled, created_by, updated_by) values (${tenantId}, 'commissions', true, ${owner.id}, ${owner.id})
    on conflict (tenant_id, module) do update set enabled = true`;
  await page.goto("/inbox");
  await rail(page).getByRole("link", { name: "Commissions", exact: true }).click();
  await expect(page).toHaveURL(/\/commissions$/);
  await expect(page.getByText("No plan yet.")).toBeVisible();

  // The default plan: 2% of sales from 1 July 2026, with no end.
  await page.getByRole("link", { name: "New plan" }).click();
  await page.getByLabel("Name of the plan").fill("Standard plan");
  await page.getByLabel("From").fill("2026-07-01");
  await page.getByLabel("Rate, % of sales before tax").fill("2");
  await page.getByRole("button", { name: "Save plan" }).click();
  await expect(page).toHaveURL(/\/commissions$/);
  await expect(plans(page)).toHaveCount(1);
  await expect(plans(page).first()).toContainText("Everyone else (default)");
  await expect(plans(page).first()).toContainText("2% of sales before tax");

  // The salesperson's own plan: slabs on the month's sales.
  await page.getByRole("link", { name: "New plan" }).click();
  await page.getByLabel("Name of the plan").fill("Slabs for the seller");
  await page.getByLabel("Who it is for").selectOption({ label: seller.email });
  await page.getByLabel("From").fill("2026-07-01");
  await page.getByLabel("How it pays").selectOption({ label: "Slabs on the month's sales" });
  await page.getByLabel("Slab 1 starts at").fill("0");
  await page.getByLabel("Slab 1 rate, %").fill("2");
  await page.getByLabel("Slab 2 starts at").fill("500000");
  await page.getByLabel("Slab 2 rate, %").fill("3");
  await page.getByRole("button", { name: "Save plan" }).click();
  await expect(page).toHaveURL(/\/commissions$/);
  await expect(plans(page)).toHaveCount(2);
  await expect(plans(page).filter({ hasText: "Slabs for the seller" })).toContainText("from 5,00,000.00: 3%");

  // A second default plan over the same months is refused.
  await page.getByRole("link", { name: "New plan" }).click();
  await page.getByLabel("Name of the plan").fill("Overlap");
  await page.getByLabel("From").fill("2026-12-01");
  await page.getByLabel("Rate, % of sales before tax").fill("3");
  await page.getByRole("button", { name: "Save plan" }).click();
  await expect(shown(page.getByTestId("form-error"))).toHaveText("Commission plan dates overlap.");

  // The seller reports to the manager; the manager reporting to the seller would be a circle.
  await page.goto("/commissions");
  const team = shown(page.getByRole("table", { name: "Sales team" }));
  // Every row's list names everyone, so each row is found by its own list's label.
  const sellerChoice = team.getByLabel(`Who ${seller.email} reports to`);
  await sellerChoice.selectOption({ label: manager.email });
  const sellerRow = team.locator("tbody tr").filter({ has: page.getByLabel(`Who ${seller.email} reports to`) });
  await sellerRow.getByRole("button", { name: "Save" }).click();
  await expect(sellerRow.getByRole("status")).toHaveText("Saved.");
  const managerChoice = team.getByLabel(`Who ${manager.email} reports to`);
  await managerChoice.selectOption({ label: seller.email });
  const managerRow = team.locator("tbody tr").filter({ has: page.getByLabel(`Who ${manager.email} reports to`) });
  await managerRow.getByRole("button", { name: "Save" }).click();
  await expect(managerRow.getByRole("alert")).toHaveText("The sales hierarchy cannot contain a cycle.");
  const [link] = await sql<{ manager_user_id: string }[]>`select manager_user_id from public.sales_hierarchy where tenant_id = ${tenantId} and user_id = ${seller.id}`;
  expect(link.manager_user_id).toBe(manager.id);
});

test("the accountant reads the plans from Reports and cannot change them", async ({ page }) => {
  await signIn(page, accountant);
  await page.goto("/reports");
  await page.getByRole("list", { name: "Commissions" }).getByRole("link", { name: "Commission plans" }).click();
  await expect(plans(page)).toHaveCount(2);
  await expect(page.getByRole("link", { name: "New plan" })).toHaveCount(0);
  await expect(shown(page.getByRole("table", { name: "Sales team" }))).toContainText(manager.email);
  await expect(shown(page.getByRole("table", { name: "Sales team" })).getByRole("button")).toHaveCount(0);
  await page.goto("/commissions/plans/new");
  await expect(page.getByText("Only the owner can set up commission plans.")).toBeVisible();
});

test("a salesperson has no way in to the plans", async ({ page }) => {
  await signIn(page, seller);
  await page.goto("/commissions");
  await expect(page.getByText("Your role does not include commission plans.")).toBeVisible();
});
