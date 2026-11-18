import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 42 on screen: the accountant lends two people money out of cash; the payroll administrator
// records one's bank account (a wrong IBAN refused) and works the month out, the loans' instalments
// taken from pay, all that is owed from the pay of the one who left; the accountant approves it,
// downloads the salary bank file and takes the rest of the leaver's loan back in cash (final
// settlement); the owner reads the year's salary statement and downloads it. The figures are
// tested against the database in src/modules/staff-loans.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let clerk: TestUser;
let books: TestUser;
let tenantId: string;
let imranId: string;
let saraId: string;
let runId: string;

const shown = (locator: Locator) => locator.filter({ visible: true });
const payrollTabs = (page: Page) => shown(page.getByRole("navigation", { name: "Payroll" }));
/** Today in Pakistan, this month as YYYY-MM, and the July its tax year began. */
const pakistan = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const thisMonth = () => pakistan().slice(0, 7);
const julyOf = () => {
  const [year, month] = thisMonth().split("-").map(Number);
  return month >= 7 ? year : year - 1;
};
const monthName = () => new Date(`${thisMonth()}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("extras-owner", { canCreateCompany: true });
  clerk = await createUser("extras-clerk", { canCreateCompany: false });
  books = await createUser("extras-books", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("the owner sets the company up, with two people on the payroll", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Payroll Extras Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${clerk.id}, ${clerk.email}, 'payroll_administrator', ${owner.id}),
    (${tenantId}, ${books.id}, ${books.email}, 'accountant', ${owner.id})`;
  await sql`insert into public.modules_enabled (tenant_id, module, enabled, created_by, updated_by) values (${tenantId}, 'payroll', true, ${owner.id}, ${owner.id})
    on conflict (tenant_id, module) do update set enabled = true`;
  // Imran on Rs 150,000 a month and Sara on Rs 60,000, both since the tax year began. (Adding
  // employees on screen is Step 40's browser test.)
  const start = `${julyOf()}-07-01`;
  const [imran] = await sql<{ id: string }[]>`insert into public.employees (tenant_id, code, name, province, pay_basis, joined_on, created_by, updated_by)
    values (${tenantId}, 'E-001', 'Imran Qureshi', 'punjab', 'monthly', ${start}, ${owner.id}, ${owner.id}) returning id`;
  const [sara] = await sql<{ id: string }[]>`insert into public.employees (tenant_id, code, name, province, pay_basis, joined_on, created_by, updated_by)
    values (${tenantId}, 'E-002', 'Sara Khan', 'punjab', 'monthly', ${start}, ${owner.id}, ${owner.id}) returning id`;
  imranId = imran.id;
  saraId = sara.id;
  await sql`insert into public.employee_pay (tenant_id, employee_id, component, amount, effective_from, created_by, updated_by) values
    (${tenantId}, ${imranId}, 'basic', 150000, ${start}, ${owner.id}, ${owner.id}),
    (${tenantId}, ${saraId}, 'basic', 60000, ${start}, ${owner.id}, ${owner.id})`;
});

test("the accountant lends Imran and Sara money out of cash", async ({ page }) => {
  await signIn(page, books);
  await page.goto("/payroll/employees");
  await payrollTabs(page).getByRole("link", { name: "Loans" }).click();
  await expect(page.getByRole("heading", { name: "Loans and advances" })).toBeVisible();
  await expect(page.getByText("No loans yet.")).toBeVisible();

  const lend = async (person: string, amount: string, instalment: string) => {
    await page.getByLabel("To", { exact: true }).selectOption({ label: person });
    await page.getByLabel("From", { exact: true }).selectOption({ label: "1111 Cash in hand" });
    await page.getByLabel("Amount", { exact: true }).fill(amount);
    await page.getByLabel("Taken from each month's pay").fill(instalment);
    await page.getByRole("button", { name: "Pay the loan" }).click();
  };
  await lend("E-001 Imran Qureshi", "30000", "40000");
  await expect(shown(page.getByTestId("form-error"))).toHaveText("The instalment cannot be more than the loan.");
  await lend("E-001 Imran Qureshi", "30000", "10000");
  await expect(shown(page.getByRole("status"))).toHaveText(/^Paid as SL-\d{4}-\d{5}\.$/);
  await lend("E-002 Sara Khan", "80000", "5000");
  await expect(shown(page.getByRole("status"))).toHaveText(/^Paid as SL-\d{4}-\d{5}\.$/);
  const loans = page.getByRole("table", { name: "Loans" });
  await expect(loans.getByRole("row", { name: /Imran Qureshi/ })).toContainText("30,000.00");
  await expect(loans.getByRole("row", { name: /Sara Khan/ })).toContainText("80,000.00");
});

test("the payroll administrator records Imran's bank account and works the month out, Sara having left", async ({ page }) => {
  await signIn(page, clerk);
  // The payroll administrator reads the loans but does not lend.
  await page.goto("/payroll/loans");
  await expect(page.getByRole("table", { name: "Loans" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay the loan" })).toHaveCount(0);

  await page.goto(`/payroll/employees/${imranId}`);
  await page.getByLabel("Bank", { exact: true }).fill("Standard Chartered");
  await page.getByLabel("Account title").fill("Imran Qureshi");
  await page.getByLabel("IBAN").fill("PK36 SCBL 0000 0011 2345 6703");
  await page.getByRole("button", { name: "Save bank account" }).click();
  await expect(shown(page.getByTestId("form-error"))).toContainText("Enter the IBAN");
  await page.getByLabel("IBAN").fill("PK36 SCBL 0000 0011 2345 6702");
  await page.getByRole("button", { name: "Save bank account" }).click();
  await expect(shown(page.getByRole("status"))).toHaveText("Saved.");
  await expect(page.getByRole("table", { name: "Their loans" })).toContainText("10,000.00");

  // Sara leaves today. (Recording that on screen is Step 40's.)
  await sql`update public.employees set left_on = ${pakistan()} where id = ${saraId}`;
  await page.goto("/payroll/runs");
  await shown(page.getByLabel("Month", { exact: true })).fill(thisMonth());
  await page.getByRole("button", { name: "Work out", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Payroll for ${monthName()}` })).toBeVisible();
  runId = page.url().split("/").pop()!;
  // Imran: 150,000 less income tax of 6,000 and his instalment of 10,000.
  await expect(page.getByRole("table", { name: "Payslips" }).getByRole("row", { name: /E-001/ })).toContainText("1,34,000.00");
  await page.getByRole("button", { name: "Mark as reviewed" }).click();
  await expect(page.getByText("Reviewed", { exact: true })).toBeVisible();
});

test("the accountant approves it, downloads the bank file and takes the rest of Sara's loan in cash", async ({ page }) => {
  await signIn(page, books);
  await page.goto(`/payroll/runs/${runId}`);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/^Approved, PR-\d{4}-\d{5}$/)).toBeVisible();
  await expect(page.getByRole("table", { name: "Journal" }).getByRole("row", { name: /Loans and advances to staff/ })).toBeVisible();
  const [sara] = await sql<{ net: string; loan_recovery: string; earnings: string; tax: string }[]>`
    select net::text, loan_recovery::text, earnings::text, tax::text from public.payslips where run_id = ${runId} and employee_id = ${saraId}`;
  // All Sara owes is taken from her last pay, as far as it goes: she takes nothing home.
  expect(Number(sara.net)).toBe(0);
  expect(Number(sara.loan_recovery)).toBeCloseTo(Number(sara.earnings) - Number(sara.tax), 2);

  // The bank file pays Imran alone; Sara has nothing to take home.
  const link = page.getByRole("link", { name: "Download the bank file" });
  const response = await page.request.get((await link.getAttribute("href"))!);
  expect(response.headers()["content-disposition"]).toMatch(/^attachment; filename="salaries-PR-\d{4}-\d{5}\.csv"$/);
  const [year, month] = thisMonth().split("-");
  expect((await response.text()).split("\r\n")).toEqual([
    "Sr No,Beneficiary IBAN,Beneficiary Name,Amount,Payment Reference",
    `1,PK36SCBL0000001123456702,IMRAN QURESHI,134000.00,SALARY ${MONTHS[Number(month) - 1]} ${year} E-001`,
    "",
  ]);

  await page.goto(`/payroll/employees/${saraId}`);
  await expect(page.getByRole("heading", { name: "Final settlement" })).toBeVisible();
  await expect(page.getByTestId("final-settlement")).toContainText("is still owed, to be repaid in cash.");
  const [owed] = await sql<{ owed: string }[]>`select (amount - recovered)::text as owed from public.staff_loans where employee_id = ${saraId}`;
  await shown(page.getByLabel("Amount", { exact: true })).fill(owed.owed);
  await shown(page.getByLabel("Into")).selectOption({ label: "1111 Cash in hand" });
  await page.getByRole("button", { name: "Record the repayment" }).click();
  await expect(page.getByTestId("final-settlement")).toContainText("nothing is owed now.");
  const [balance] = await sql<{ net: string }[]>`
    select sum(l.debit - l.credit)::numeric(20,2)::text as net from public.journal_lines l join public.accounts a on a.id = l.account_id
    where a.tenant_id = ${tenantId} and a.code = '1240'`;
  // Only Imran's 20,000 is still owed to the company.
  expect(balance.net).toBe("20000.00");
});

test("the owner reads the year's salary statement and downloads it", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/payroll/employees");
  await payrollTabs(page).getByRole("link", { name: "Year's statement" }).click();
  await expect(page.getByRole("heading", { name: "The year's salary statement" })).toBeVisible();
  const statement = page.getByRole("table", { name: "Salary statement" });
  await expect(statement.getByRole("row", { name: /E-001/ })).toContainText("1,50,000.00");
  await expect(statement.getByRole("row", { name: /E-002/ })).toBeVisible();
  const response = await page.request.get((await page.getByRole("link", { name: "Download CSV" }).getAttribute("href"))!);
  const lines = (await response.text()).split("\r\n");
  expect(lines[1]).toBe("Code,Name,CNIC,Months paid,Pay and commission,Taxable salary,Income tax deducted");
  expect(lines[2]).toMatch(/^E-001,Imran Qureshi,,1,150000\.00,150000\.00,6000\.00$/);
});
