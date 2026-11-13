import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, railLabels, signIn, test } from "./support/ui";

// Step 12 on screen: the chart of accounts a company starts with, and its own accounts added,
// renamed, archived and deleted. The rules themselves are tested in src/modules/ledger.

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
  owner = await createUser("accounts-owner", { canCreateCompany: true });
  accountant = await createUser("accounts-accountant", { canCreateCompany: false });
  auditor = await createUser("accounts-auditor", { canCreateCompany: false });
  seller = await createUser("accounts-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("a company starts with a chart of accounts and adds a sub-account under Expenses", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Ledger Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id}),
    (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;

  await page.goto("/settings/accounts");
  const chart = page.getByRole("table", { name: "Chart of accounts" });
  await expect(chart.getByRole("row").nth(1)).toHaveText(/1000\s*Assets/);
  await expect(chart.getByRole("row").filter({ hasText: "Trade receivables" })).toContainText("Locked");
  // This company is not registered for sales tax: its chart has no sales tax accounts.
  await expect(chart.getByRole("row")).toHaveCount(1 + 65 - 3);
  await expect(chart).not.toContainText("Sales tax");
  // A locked account is not a link; the company's own accounts are.
  await expect(chart.getByRole("link", { name: "Trade receivables" })).toHaveCount(0);
  await expect(chart.getByRole("link", { name: "Rent", exact: true })).toBeVisible();

  // A sub-account under Expenses takes the next free number.
  const add = page.locator("form").filter({ has: page.getByRole("button", { name: "Add account" }) });
  await add.getByLabel("Under", { exact: true }).selectOption({ label: "5000 Expenses" });
  await add.getByLabel("Name").fill("Packing material");
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(add.getByRole("status")).toHaveText("Added as 5900.");
  await expect(chart.getByRole("row").filter({ hasText: "Packing material" })).toHaveText(/5900\s*Packing material/);
  // The same name again is refused, and the form keeps what was typed.
  await add.getByLabel("Under", { exact: true }).selectOption({ label: "5000 Expenses" });
  await add.getByLabel("Name").fill("packing material");
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(add.getByTestId("form-error")).toHaveText("Another account already has this name.");

  // Its own page: rename it, archive it, restore it, delete it.
  await chart.getByRole("link", { name: "Packing material" }).click();
  await expect(page.getByRole("heading", { name: "5900 Packing material" })).toBeVisible();
  await page.getByLabel("Name").filter({ visible: true }).fill("Packing and wrapping");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { name: "5900 Packing and wrapping" })).toBeVisible();
  await page.getByRole("button", { name: "Archive account" }).click();
  await expect(page.getByTestId("account-status")).toHaveText("Archived");
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore account" }).click();
  await expect(page.getByTestId("account-status")).toHaveText("In use");
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(page).toHaveURL(/\/settings\/accounts$/);
  await expect(page.getByRole("table", { name: "Chart of accounts" })).not.toContainText("Packing and wrapping");

  const audited = await sql`select action from public.audit_log where tenant_id = ${tenantId} and action like 'account%' order by at`;
  expect(audited.map((a) => a.action)).toEqual(["accounts.seed", "account.create", "account.update", "account.archive", "account.restore", "account.delete"]);
});

test("an accountant keeps the chart; an auditor only reads it; a salesperson has no way in", async ({ page }) => {
  await signIn(page, accountant);
  expect(await railLabels(page)).toContain("Chart of accounts");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Chart of accounts" }).click();
  await expect(page).toHaveURL(/\/settings\/accounts$/);
  const add = page.locator("form").filter({ has: page.getByRole("button", { name: "Add account" }) });
  // Headings are indented in the list, so this one is picked by what it says.
  await add.getByLabel("Under", { exact: true }).selectOption((await add.locator("option", { hasText: "1120 Bank accounts" }).getAttribute("value"))!);
  await add.getByLabel("Name").fill("HBL current account");
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(add.getByRole("status")).toHaveText("Added as 1121.");

  await page.context().clearCookies();
  await signIn(page, auditor);
  await page.goto("/settings/accounts");
  await expect(page.getByRole("table", { name: "Chart of accounts" }).getByRole("row").filter({ hasText: "HBL current account" })).toHaveText(/1121\s*HBL current account/);
  await expect(page.getByRole("button", { name: "Add account" })).toHaveCount(0);
  await page.getByRole("link", { name: "HBL current account" }).click();
  await expect(page.getByRole("heading", { name: "1121 HBL current account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, seller);
  await page.goto("/settings/accounts");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see the chart of accounts.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Chart of accounts" })).toHaveCount(0);
});
