import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 34 on screen: the owner adds a bank account and petty cash, tops petty cash up from the
// bank, and records the repairs bill paid from the bank with the province's tax and income tax
// withheld (the step's acceptance, the figures of docs/examples/step-34.md); the auditor reads it
// all; a salesperson has no way in. What each of these posts is tested against the database in
// src/modules/cash-bank.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let auditor: TestUser;
let seller: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("cash-owner", { canCreateCompany: true });
  auditor = await createUser("cash-auditor", { canCreateCompany: false });
  seller = await createUser("cash-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const label = (page: Page, text: string) => shown(page.getByLabel(text, { exact: true }));
const rail = (page: Page) => page.getByRole("navigation", { name: "Main" });
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);

test("the owner adds a bank account and petty cash, and tops petty cash up from the bank", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Cash Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  await sql`insert into public.purchase_settings (tenant_id, withholding_on, updated_by) values (${tenantId}, true, ${owner.id})
    on conflict (tenant_id) do update set withholding_on = true`;
  await sql`insert into public.suppliers (tenant_id, name, code, supplier_type, created_by, updated_by) values (${tenantId}, 'Lahore Parts', 'S-001', 'aop', ${owner.id}, ${owner.id})`;

  await rail(page).getByRole("link", { name: "Cash and bank", exact: true }).click();
  await expect(page).toHaveURL(/\/cash-bank$/);
  await label(page, "Kind").selectOption("bank");
  await label(page, "Name").fill("HBL current account");
  await label(page, "Bank (a bank account only)").fill("Habib Bank Limited");
  await label(page, "Account number or IBAN").fill("PK36HABB0000001123456702");
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByRole("table", { name: "Cash and bank accounts" })).toContainText("HBL current account");
  await label(page, "Kind").selectOption("cash");
  await label(page, "Name").fill("Petty cash");
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByRole("table", { name: "Cash and bank accounts" })).toContainText("Petty cash");

  await shown(page.getByRole("navigation", { name: "Cash and bank" })).getByRole("link", { name: "Transfers" }).click();
  await label(page, "From").selectOption({ label: "1121 HBL current account" });
  await label(page, "To").selectOption({ label: "1112 Petty cash" });
  await label(page, "Amount").fill("15000");
  await label(page, "Reference (cheque or slip no.)").fill("Cheque 1001");
  await page.getByRole("button", { name: "Record transfer" }).click();
  await expect(page.getByText("Recorded as TR-2627-00001.")).toBeVisible();
  expect(await journal("TR-2627-00001")).toEqual(["1112 15000 0", "1121 0 15000"]);
});

test("the owner records the repairs bill paid from the bank, with the tax withheld", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/cash-bank/expenses");
  await page.getByRole("link", { name: "New expense" }).click();
  await label(page, "Paid from").selectOption({ label: "1121 HBL current account" });
  await label(page, "Supplier").selectOption({ label: "S-001 Lahore Parts" });
  await label(page, "Province's tax on services").selectOption("provincial_sales_tax.punjab");
  await label(page, "Income tax withheld").selectOption("income_tax.services.other");
  await label(page, "Account, line 1").selectOption({ label: "5270 Repairs and maintenance" });
  await label(page, "What it was for, line 1").fill("Shop front repairs");
  await label(page, "Amount, line 1").fill("30000");
  await label(page, "Account, line 2").selectOption({ label: "5270 Repairs and maintenance" });
  await label(page, "What it was for, line 2").fill("Painting");
  await label(page, "Amount, line 2").fill("20000");
  await page.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByRole("heading", { name: "EX-2627-00001" })).toBeVisible();
  await expect(shown(page.getByTestId("expense-figures"))).toContainText("58,000.00");
  await expect(shown(page.getByTestId("expense-figures"))).toContainText("33,760.00");
  expect(await journal("EX-2627-00001")).toEqual(["5270 34800 0", "5270 23200 0", "2230 0 8000", "2210 0 16240", "1121 0 33760"]);
});

test("the auditor reads cash and bank and changes nothing", async ({ page }) => {
  await signIn(page, auditor);
  await page.goto("/cash-bank");
  await expect(page.getByRole("table", { name: "Cash and bank accounts" })).toContainText("-48,760.00");
  await expect(page.getByRole("button", { name: "Add account" })).toHaveCount(0);
  await page.goto("/cash-bank/expenses");
  await expect(page.getByRole("table", { name: "Expenses" })).toContainText("EX-2627-00001");
  await expect(page.getByRole("link", { name: "New expense" })).toHaveCount(0);
});

test("a salesperson has no way in to cash and bank", async ({ page }) => {
  await signIn(page, seller);
  await expect(rail(page).getByRole("link", { name: "Cash and bank", exact: true })).toHaveCount(0);
  await page.goto("/cash-bank/expenses");
  await expect(page.getByText("Your role does not include cash and bank.")).toBeVisible();
});
