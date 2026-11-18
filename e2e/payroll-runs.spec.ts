import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 41 on screen: the payroll administrator works this month out (refused first, with who and
// why), and reviews it; the accountant approves it into the books and pays it from cash; the
// owner opens a payslip and downloads its PDF. What each of these does, the acceptance (approving
// after a commission changed is refused) among them, is tested against the database in
// src/modules/payroll-runs.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let clerk: TestUser;
let books: TestUser;
let tenantId: string;
let runId: string;

const shown = (locator: Locator) => locator.filter({ visible: true });
const rail = (page: Page) => page.getByRole("navigation", { name: "Main" });
const payrollTabs = (page: Page) => shown(page.getByRole("navigation", { name: "Payroll" }));
/** This month in Pakistan, as YYYY-MM, and the July its tax year began. */
const pakistan = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => pakistan().slice(0, 7);
const taxYearStart = () => {
  const [year, month] = thisMonth().split("-").map(Number);
  return `${month >= 7 ? year : year - 1}-07-01`;
};
const monthName = () => new Date(`${thisMonth()}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("runs-owner", { canCreateCompany: true });
  clerk = await createUser("runs-clerk", { canCreateCompany: false });
  books = await createUser("runs-books", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

let rashidId: string;

test("the owner sets the company up, with two people on the payroll", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Payroll Runs Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${clerk.id}, ${clerk.email}, 'payroll_administrator', ${owner.id}),
    (${tenantId}, ${books.id}, ${books.email}, 'accountant', ${owner.id})`;
  await sql`insert into public.modules_enabled (tenant_id, module, enabled, created_by, updated_by) values (${tenantId}, 'payroll', true, ${owner.id}, ${owner.id})
    on conflict (tenant_id, module) do update set enabled = true`;
  // Imran on Rs 150,000 a month since the tax year began, registered with EOBI; Rashid by the day,
  // with no wage set yet. (Adding employees on screen is Step 40's browser test.)
  const [imran] = await sql<{ id: string }[]>`insert into public.employees (tenant_id, code, name, province, pay_basis, joined_on, eobi, created_by, updated_by)
    values (${tenantId}, 'E-001', 'Imran Qureshi', 'punjab', 'monthly', ${taxYearStart()}, true, ${owner.id}, ${owner.id}) returning id`;
  await sql`insert into public.employee_pay (tenant_id, employee_id, component, amount, effective_from, created_by, updated_by) values (${tenantId}, ${imran.id}, 'basic', 150000, ${taxYearStart()}, ${owner.id}, ${owner.id})`;
  const [rashid] = await sql<{ id: string }[]>`insert into public.employees (tenant_id, code, name, province, pay_basis, joined_on, created_by, updated_by)
    values (${tenantId}, 'D-001', 'Rashid Khan', 'sindh', 'daily', ${`${thisMonth()}-01`}, ${owner.id}, ${owner.id}) returning id`;
  rashidId = rashid.id;
});

test("the payroll administrator works the month out, is told who cannot be paid, and reviews it", async ({ page }) => {
  await signIn(page, clerk);
  await rail(page).getByRole("link", { name: "Payroll runs", exact: true }).click();
  await expect(page).toHaveURL(/\/payroll\/runs$/);
  await expect(page.getByText("No payroll has been worked out yet.")).toBeVisible();
  await shown(page.getByLabel("Month", { exact: true })).fill(thisMonth());
  await page.getByRole("button", { name: "Work out", exact: true }).click();
  await expect(shown(page.getByTestId("form-error"))).toHaveText("Nothing was worked out. One person needs putting right first: D-001 Rashid Khan has no daily wage on record for this month.");

  // Rashid's wage, and ten days worked this month.
  await sql`insert into public.employee_pay (tenant_id, employee_id, component, amount, effective_from, created_by, updated_by) values (${tenantId}, ${rashidId}, 'daily_wage', 1600, ${`${thisMonth()}-01`}, ${owner.id}, ${owner.id})`;
  await sql`insert into public.employee_attendance (tenant_id, employee_id, month, days_worked, unpaid_days, created_by, updated_by) values (${tenantId}, ${rashidId}, ${`${thisMonth()}-01`}, 10, 0, ${owner.id}, ${owner.id})`;
  await page.getByRole("button", { name: "Work out", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Payroll for ${monthName()}` })).toBeVisible();
  runId = page.url().split("/").pop()!;
  const slips = page.getByRole("table", { name: "Payslips" });
  // Imran: 150,000, income tax 6,000 (72,000 on 18,00,000 a year), EOBI 1% of 40,700; Rashid: 10 days at 1,600.
  await expect(slips.getByRole("row", { name: /E-001/ })).toContainText("1,50,000.00");
  await expect(slips.getByRole("row", { name: /E-001/ })).toContainText("6,000.00");
  await expect(slips.getByRole("row", { name: /E-001/ })).toContainText("1,43,593.00");
  await expect(slips.getByRole("row", { name: /D-001/ })).toContainText("16,000.00");
  await expect(page.getByRole("table", { name: "Journal" })).toContainText("Salaries and wages");
  await expect(page.getByRole("heading", { name: "Approve" })).toHaveCount(0);

  await page.getByRole("button", { name: "Mark as reviewed" }).click();
  await expect(page.getByText("Reviewed. The owner or an accountant approves it next.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approve" })).toHaveCount(0);
});

test("the accountant approves the month into the books and pays it from cash", async ({ page }) => {
  await signIn(page, books);
  await rail(page).getByRole("link", { name: "Payroll", exact: true }).click();
  await payrollTabs(page).getByRole("link", { name: "Payroll runs" }).click();
  await page.getByRole("link", { name: monthName() }).click();
  await expect(page.getByRole("heading", { name: `Payroll for ${monthName()}` })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work it out again" })).toHaveCount(0);

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/^Approved as PR-\d{4}-\d{5}, and in the books\.$/)).toBeVisible();
  const journal = page.getByRole("table", { name: "Journal" });
  await expect(journal.getByRole("row", { name: /Salaries and wages/ })).toContainText("1,66,000.00");
  await expect(journal.getByRole("row", { name: /Salaries payable/ })).toContainText("1,59,593.00");

  await shown(page.getByLabel("From", { exact: true })).selectOption({ label: "1111 Cash in hand" });
  await page.getByRole("button", { name: "Record the payment" }).click();
  await expect(page.getByText("Paid.", { exact: true })).toBeVisible();
  await expect(page.getByText(/paid on .* from 1111 Cash in hand as SP-\d{4}-\d{5}/)).toBeVisible();

  const [run] = await sql<{ status: string; number: string; balanced: boolean }[]>`
    select r.status, r.number,
      (select sum(l.debit) = sum(l.credit) from public.journal_lines l where l.journal_id in (r.journal_id, r.payment_journal_id)) as balanced
    from public.payroll_runs r where r.id = ${runId}`;
  expect(run).toMatchObject({ status: "paid", balanced: true });
});

test("the owner opens a payslip and downloads its PDF", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/payroll/payslips");
  await page.getByRole("link", { name: "E-001 Imran Qureshi" }).click();
  await expect(page.getByRole("heading", { name: "Payslip: Imran Qureshi" })).toBeVisible();
  await expect(shown(page.getByTestId("payslip-net"))).toHaveText("1,43,593.00");
  // Since July, nothing was run here: those months are taken as paid at his pay (none in July itself).
  if (!thisMonth().endsWith("-07")) await expect(page.getByText(/Taken as paid before payroll was run here/).first()).toBeVisible();
  const href = await page.getByRole("link", { name: "Download PDF" }).getAttribute("href");
  const response = await page.request.get(href!);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  expect((await response.body()).subarray(0, 5).toString()).toBe("%PDF-");
});
