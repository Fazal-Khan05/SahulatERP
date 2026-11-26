import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Tax paid over, on screen: an expense paid to a supplier with income tax and the province's tax
// withheld shows under Withholding tax beside the bills' entries; the owner ticks its income tax
// and records the challan; the register names the challan and still equals the books; and the
// expense can no longer be cancelled. A payroll run's salary tax, and everything a challan
// refuses, are tested against the database in src/modules/tax-paid-over.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("taxpaid-owner", { canCreateCompany: true });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const label = (page: Page, text: string) => shown(page.getByLabel(text, { exact: true }));
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);

test("an expense's withheld tax is paid over under a challan, and the expense then stands", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Tax Paid Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.purchase_settings (tenant_id, withholding_on, updated_by) values (${tenantId}, true, ${owner.id})
    on conflict (tenant_id) do update set withholding_on = true`;
  await sql`insert into public.suppliers (tenant_id, name, code, supplier_type, created_by, updated_by) values (${tenantId}, 'Lahore Parts', 'S-001', 'aop', ${owner.id}, ${owner.id})`;

  // Repairs of 30,000 paid in cash: Punjab's 16% is added and withheld whole (4,800); income tax is 28% of the 34,800 (9,744).
  await page.goto("/cash-bank/expenses/new");
  await label(page, "Paid from").selectOption({ label: "1111 Cash in hand" });
  await label(page, "Supplier").selectOption({ label: "S-001 Lahore Parts" });
  await label(page, "Province's tax on services").selectOption("provincial_sales_tax.punjab");
  await label(page, "Income tax withheld").selectOption("income_tax.services.other");
  await label(page, "Account, line 1").selectOption({ label: "5270 Repairs and maintenance" });
  await label(page, "What it was for, line 1").fill("Shop front repairs");
  await label(page, "Amount, line 1").fill("30000");
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByRole("heading", { name: "EX-2627-00001" })).toBeVisible();
  const expenseUrl = new URL(page.url()).pathname;

  // Under Withholding tax: both of the expense's taxes wait to be paid over.
  await page.goto("/purchases/withholding");
  await expect(shown(page.getByTestId("withheld-unpaid"))).toHaveText("14,544.00");
  const waiting = page.getByRole("table", { name: "Tax withheld, not yet paid over" });
  await expect(waiting.locator("tbody tr")).toHaveCount(2);
  await expect(waiting.locator("tbody tr").first()).toContainText("EX-2627-00001");
  await expect(waiting.locator("tbody tr").first()).toContainText("9,744.00");
  await page.getByLabel("Paid by this challan, row 1").check();
  await page.getByLabel("Which tax").selectOption({ label: "Income tax on payments (section 153)" });
  await page.getByLabel("Challan (CPR) number").fill("IT-20261126-0009");
  await page.getByRole("button", { name: "Record the challan" }).click();
  const challans = page.getByRole("table", { name: "Challans" });
  await expect(challans.locator("tbody tr")).toHaveCount(1);
  await expect(challans.locator("tbody tr").first()).toContainText("IT-20261126-0009");
  await expect(shown(page.getByTestId("withheld-unpaid"))).toHaveText("4,800.00");
  expect(await journal("WC-2627-00001")).toEqual(["2210 9744 0", "1111 0 9744"]);
  expect((await sql`select 1 from public.challan_expense_entries where tenant_id = ${tenantId}`).length).toBe(1);

  // The register names the challan on the expense's line, and still equals the books.
  await page.goto("/purchase-reports/withholding-register");
  const register = page.locator("main");
  await expect(register).toContainText("IT-20261126-0009");
  await expect(register.getByRole("row").filter({ hasText: "Withheld and not yet paid over" })).toContainText("4,800.00");
  await expect(register.getByRole("row").filter({ hasText: "Withholding payable accounts in the books" })).toContainText("4,800.00");
  await expect(register.getByRole("row").filter({ hasText: "Difference" })).toContainText("0.00");

  // The expense stands: its tax is with the government, and its page offers no way to cancel it.
  await page.goto(expenseUrl);
  await expect(shown(page.getByTestId("expense-stands"))).toContainText("Tax withheld on it has been paid to the government under a challan, so it is no longer cancelled.");
  await expect(page.getByRole("button", { name: "Cancel expense" })).toHaveCount(0);
  expect((await sql<{ status: string }[]>`select status from public.expenses where tenant_id = ${tenantId}`)[0].status).toBe("posted");
});
