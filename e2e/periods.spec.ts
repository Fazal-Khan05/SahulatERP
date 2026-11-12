import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { signIn, test } from "./support/ui";

// Step 10 on screen: fiscal periods with lock and unlock, the document counters, and warehouses.
// That numbers are consecutive under load is proved in src/modules/numbering/numbering.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let accountant: TestUser;
let seller: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("period-owner", { canCreateCompany: true });
  accountant = await createUser("period-accountant", { canCreateCompany: false });
  seller = await createUser("period-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("an owner opens the fiscal year, locks a month and unlocks it", async ({ page }) => {
  await signIn(page, owner);
  await page.getByLabel("Company name").fill("E2E Period Traders");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText("E2E Period Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;

  await page.goto("/settings/periods");
  await expect(page.getByText("No fiscal year is open yet.")).toBeVisible();
  await expect(page.getByText("No document has been numbered yet.")).toBeVisible();
  // July is offered; the company starts its first year in July 2026.
  await expect(page.getByLabel("Starts in")).toHaveValue("7");
  await page.getByLabel("Year").fill("2026");
  await page.getByRole("button", { name: "Open fiscal year" }).click();
  const year = page.getByRole("table", { name: "Fiscal year 2026-27" });
  await expect(year.getByRole("row")).toHaveCount(13);
  await expect(year.getByRole("row").nth(1)).toHaveText(/July 2026\s*01-07-2026\s*31-07-2026\s*Open/);
  await expect(year.getByRole("row").nth(12)).toHaveText(/June 2027\s*01-06-2027\s*30-06-2027\s*Open/);

  // Locked, the month says so and the database refuses a document dated in it.
  await page.getByRole("button", { name: "Lock July 2026" }).click();
  await expect(year.getByRole("row").nth(1)).toContainText("Locked");
  const take = (date: string) => sql.begin(async (tx) => {
    // The function decides whose company it is from these two settings, as the app sets them.
    await tx`select set_config('app.user_id', ${owner.id}, true), set_config('app.tenant_id', ${tenantId}, true)`;
    return (await tx<{ number: string }[]>`select app.next_document_number('SI', ${date}::date) as number`)[0].number;
  });
  await expect(take("2026-07-15")).rejects.toThrow(/locked/);
  expect(await take("2026-08-15")).toBe("SI-2627-00001");
  await page.getByRole("button", { name: "Unlock July 2026" }).click();
  await expect(year.getByRole("row").nth(1)).toContainText("Open");
  expect(await take("2026-07-15")).toBe("SI-2627-00002");

  // The next year follows the last one, and the counters show the next number each kind will get.
  await page.getByRole("button", { name: "Open next fiscal year" }).click();
  await expect(page.getByRole("table", { name: "Fiscal year 2027-28" }).getByRole("row")).toHaveCount(13);
  await page.reload();
  await expect(page.getByRole("table", { name: "Document numbers" }).getByRole("row").nth(1)).toHaveText(/Sales invoice\s*2026-27\s*SI-2627-00003/);
  const audited = await sql`select action from public.audit_log where tenant_id = ${tenantId} and action like 'fiscal%' order by at`;
  expect(audited.map((a) => a.action)).toEqual(["fiscal_year.open", "fiscal_period.lock", "fiscal_period.unlock", "fiscal_year.open"]);
});

test("an owner adds a warehouse to a branch", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/settings/branches");
  await expect(page.getByText("No warehouses yet.")).toBeVisible();
  await page.getByLabel("Branch name").fill("Main");
  await page.getByRole("button", { name: "Add branch" }).click();
  await expect(page.getByRole("list", { name: "Branches" }).getByRole("listitem")).toHaveText(["Main"]);
  await page.getByLabel("Warehouse name").fill("Main godown");
  await page.getByLabel("Branch", { exact: true }).selectOption({ label: "Main" });
  await page.getByRole("button", { name: "Add warehouse" }).click();
  await expect(page.getByRole("list", { name: "Warehouses" }).getByRole("listitem")).toHaveText([/Main godown\s*· Main/]);
  await page.getByLabel("Warehouse name").fill("main godown");
  await page.getByLabel("Branch", { exact: true }).selectOption({ label: "Main" });
  await page.getByRole("button", { name: "Add warehouse" }).click();
  await expect(page.locator("form").filter({ has: page.getByRole("button", { name: "Add warehouse" }) }).getByTestId("form-error")).toHaveText("A warehouse with this name already exists.");
});

test("an accountant reads the periods but cannot lock them; a salesperson has no way in", async ({ page }) => {
  await signIn(page, accountant);
  await page.goto("/settings/periods");
  await expect(page.getByRole("table", { name: "Fiscal year 2026-27" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lock July 2026" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open next fiscal year" })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Document numbers" })).toBeVisible();
  await page.goto("/settings/branches");
  await expect(page.getByRole("list", { name: "Warehouses" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add warehouse" })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, seller);
  await page.goto("/settings/periods");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see the fiscal periods.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Fiscal year 2026-27" })).toHaveCount(0);
});
