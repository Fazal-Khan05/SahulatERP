import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 40 on screen: the owner switches payroll on, adds an employee on Rs 150,000 a month and
// sees the income tax on it (Rs 6,000 a month, the step's acceptance); the payroll administrator
// adds a daily-wage employee and imports a month's attendance file, a bad one first; the
// statutory rates show where each figure comes from; a salesperson has no way in. What each of
// these does is tested against the database in src/modules/payroll.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let clerk: TestUser;
let seller: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("payroll-owner", { canCreateCompany: true });
  clerk = await createUser("payroll-clerk", { canCreateCompany: false });
  seller = await createUser("payroll-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
const rail = (page: Page) => page.getByRole("navigation", { name: "Main" });
const month = () => {
  const pakistan = new Date(Date.now() + 5 * 3600_000).toISOString();
  return pakistan.slice(0, 7);
};

test("the owner adds an employee on Rs 150,000 a month and sees Rs 6,000 of income tax on it", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Payroll Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${clerk.id}, ${clerk.email}, 'payroll_administrator', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  await sql`insert into public.modules_enabled (tenant_id, module, enabled, created_by, updated_by) values (${tenantId}, 'payroll', true, ${owner.id}, ${owner.id})
    on conflict (tenant_id, module) do update set enabled = true`;

  await page.goto("/");
  await rail(page).getByRole("link", { name: "Payroll", exact: true }).click();
  await expect(page).toHaveURL(/\/payroll\/employees$/);
  await expect(page.getByText("No employees yet.")).toBeVisible();
  await page.getByRole("link", { name: "New employee" }).click();
  await shown(page.getByLabel("Code", { exact: true })).fill("E-001");
  await shown(page.getByLabel("Name", { exact: true })).fill("Imran Qureshi");
  await shown(page.getByLabel("Designation", { exact: true })).fill("Sales manager");
  await shown(page.getByLabel("Works in (province)", { exact: true })).selectOption("punjab");
  await shown(page.getByLabel("Joined on", { exact: true })).fill("2026-07-01");
  await page.getByRole("button", { name: "Add employee" }).click();
  await expect(page.getByRole("heading", { name: "E-001 Imran Qureshi" })).toBeVisible();
  await expect(page.getByText("No pay is set yet.")).toBeVisible();

  await shown(page.getByLabel("Part of the pay", { exact: true })).selectOption("basic");
  await shown(page.getByLabel("Amount a month", { exact: true })).fill("150000");
  await shown(page.getByLabel("From", { exact: true })).fill("2026-07-01");
  await page.getByRole("button", { name: "Save pay" }).click();
  await expect(visible(page, "employee-gross")).toHaveText("1,50,000.00");
  await expect(visible(page, "employee-tax")).toContainText("Income tax on this pay: 6,000.00 a month (72,000.00 on 18,00,000.00 a year)");
  await expect(page.getByText("Minimum wage in Punjab: 40,000.00 a month")).toBeVisible();
});

test("the payroll administrator adds a daily-wage worker and imports the month's attendance", async ({ page }) => {
  await signIn(page, clerk);
  await rail(page).getByRole("link", { name: "Employees", exact: true }).click();
  await expect(page).toHaveURL(/\/payroll\/employees$/);
  await page.getByRole("link", { name: "New employee" }).click();
  await shown(page.getByLabel("Code", { exact: true })).fill("D-001");
  await shown(page.getByLabel("Name", { exact: true })).fill("Rashid Khan");
  await shown(page.getByLabel("Paid", { exact: true })).selectOption("daily");
  await shown(page.getByLabel("Works in (province)", { exact: true })).selectOption("sindh");
  await shown(page.getByLabel("Joined on", { exact: true })).fill("2026-07-01");
  await page.getByRole("button", { name: "Add employee" }).click();
  await expect(page.getByRole("heading", { name: "D-001 Rashid Khan" })).toBeVisible();
  await shown(page.getByLabel("Amount a day", { exact: true })).fill("1600");
  await page.getByRole("button", { name: "Save pay" }).click();
  await expect(page.getByRole("table", { name: "Pay today" })).toContainText("1,600.00");

  // Back to the list, and across to the month's attendance.
  await shown(page.getByRole("link", { name: "Employees", exact: true })).first().click();
  await expect(page).toHaveURL(/\/payroll\/employees$/);
  await shown(page.getByRole("navigation", { name: "Payroll" })).getByRole("link", { name: "Attendance" }).click();
  await expect(page).toHaveURL(/\/payroll\/attendance$/);
  // A bad file first: nothing is imported, and every wrong row is listed.
  const bad = "Code,Days worked,Unpaid days\nE-001,,2\nD-001,24.5,1\nX-404,3,\n";
  await shown(page.getByLabel("CSV file", { exact: true })).setInputFiles({ name: "attendance.csv", mimeType: "text/csv", buffer: Buffer.from(bad) });
  await page.getByRole("button", { name: "Import" }).click();
  await expect(visible(page, "import-problems")).toContainText("Nothing was imported. 2 rows need correcting");
  await expect(visible(page, "import-problems")).toContainText("No employee has this code.");
  const good = "Code,Days worked,Unpaid days\nE-001,,2\nD-001,24.5,\n";
  await shown(page.getByLabel("CSV file", { exact: true })).setInputFiles({ name: "attendance.csv", mimeType: "text/csv", buffer: Buffer.from(good) });
  await page.getByRole("button", { name: "Import" }).click();
  await expect(visible(page, "import-done")).toHaveText("Imported 2 rows.");
  const table = page.getByRole("table", { name: "Attendance", exact: true });
  await expect(table.getByRole("row", { name: /D-001/ })).toContainText("24.5");
  await expect(table.getByRole("row", { name: /E-001/ })).toContainText("2");
  const [rows] = await sql<{ n: number }[]>`select count(*)::int as n from public.employee_attendance where tenant_id = ${tenantId} and month = ${`${month()}-01`}`;
  expect(rows.n).toBe(2);

  await shown(page.getByRole("navigation", { name: "Payroll" })).getByRole("link", { name: "Statutory rates" }).click();
  await expect(page.getByRole("table", { name: "Salary tax slabs from 2026-07-01" })).toContainText("14,24,000.00 + 35% of the amount over 70,00,000.00");
  await expect(page.getByRole("table", { name: "Statutory rates" })).toContainText("SO(L-II)/13-3/2016-II");
});

test("a salesperson has no way in to payroll", async ({ page }) => {
  await signIn(page, seller);
  await expect(rail(page).getByRole("link", { name: "Payroll", exact: true })).toHaveCount(0);
  await page.goto("/payroll/employees");
  await expect(page.getByText("Your role does not include payroll.")).toBeVisible();
  await expect(page.getByText("Imran Qureshi")).toHaveCount(0);
});
