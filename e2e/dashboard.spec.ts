import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 36 on screen: the owner's Home shows the business's figures for a period and a branch, each
// opening the report it comes from, and the cash-flow statement is among the reports; an accountant's
// Home has no such figures. What the figures and the statement add up to is tested against the
// database in src/modules/reports.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let books: TestUser;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("dashboard-owner", { canCreateCompany: true });
  books = await createUser("dashboard-books", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("the owner sees the business's figures for a period and opens the cash flow from them", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Dashboard Traders");
  const tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${books.id}, ${books.email}, 'accountant', ${owner.id})`;
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The business" })).toBeVisible();
  for (const testId of ["figure-cash", "figure-sales", "figure-profit", "figure-receivables", "figure-payables"]) await expect(page.getByTestId(testId)).toContainText("0.00");
  // Another period, by the dates in the form.
  const pakistan = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const yearStart = `${Number(pakistan.slice(5, 7)) >= 7 ? pakistan.slice(0, 4) : Number(pakistan.slice(0, 4)) - 1}-07-01`;
  await page.getByLabel("From", { exact: true }).fill(yearStart);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByTestId("figures-period")).toHaveText(new RegExp(`^${yearStart.split("-").reverse().join("-")} to `));
  await page.getByTestId("figure-cash").click();
  await expect(page).toHaveURL(/\/reports\/cash-flow\?from=/);
  await expect(page.getByRole("heading", { name: "Cash flow" })).toBeVisible();
  await expect(page.getByText("Net change in cash and bank")).toBeVisible();
  await expect(page.getByText(/^The net change, 0\.00, is what the cash and bank accounts moved in the period/)).toBeVisible();
});

test("an accountant's Home has no figures, and the cash flow is among their reports", async ({ page }) => {
  await signIn(page, books);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The business" })).toHaveCount(0);
  await page.goto("/reports");
  await expect(page.getByRole("link", { name: "Cash flow" })).toBeVisible();
});
