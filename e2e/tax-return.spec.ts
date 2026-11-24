import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { signIn, test } from "./support/ui";

// Step 46 on screen: the month's sales tax return of a company registered for sales tax. One
// invoice is posted; the return lists it on Annex-C, sets it beside the ledger, says what is
// missing for a clean file, and gives the annex as a sheet for upload. The annexes' figures are
// tested against a real month of trade in src/modules/tax-return/tax-return.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

/** This month in Pakistan, where the app's days are kept: the invoice is dated today. */
const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);

let sql: AdminSql;
let owner: TestUser;
let seller: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("taxreturn-owner", { canCreateCompany: true });
  seller = await createUser("taxreturn-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("the owner of a registered company reads the month's return, sets the province and downloads Annex-C", async ({ page }) => {
  await signIn(page, owner);
  await page.getByLabel("Company name").fill("E2E Tax Return Traders");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await page.locator('input[name="salesTaxRegistered"][value="yes"]').check();
  await page.locator('input[name="taxRatesConfirmed"]').check();
  await page.getByLabel("STRN").fill("11-11-1111-111-11");
  await page.getByLabel("Prices and sales tax").selectOption({ label: "Sales tax is added on top of my prices" });
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/inbox$/);

  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [standard] = await sql`select id from public.tax_categories where tenant_id = ${tenantId} and kind = 'standard' order by created_at limit 1`;
  const [item] = await sql`
    insert into public.items (tenant_id, code, name, base_unit_id, default_price, tax_category_id, hs_code, created_by, updated_by)
    values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${standard.id}, '6506.1000', ${owner.id}, ${owner.id}) returning id`;
  // An unregistered buyer with no CNIC on record: sold to with further tax, and a gap in the file.
  await sql`insert into public.customers (tenant_id, name, code, credit_days, created_by, updated_by) values (${tenantId}, 'Walk-in Rider', 'C-002', 0, ${owner.id}, ${owner.id})`;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  await seedStock(sql, { tenantId, itemId: item.id, warehouseId: warehouse.id, quantity: "10", value: "6000", userId: owner.id });

  // Two helmets at 1,000: 360 of sales tax and, the buyer being unregistered, 80 of further tax.
  await page.goto("/sales/new?kind=order");
  const customer = page.getByRole("combobox", { name: "Customer", exact: true });
  await customer.fill("C-002");
  await customer.press("Tab");
  await expect(customer).toHaveAttribute("data-picked", "true");
  const picker = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await picker.fill("HL-1");
  await picker.press("Tab");
  await expect(picker).toHaveAttribute("data-picked", "true");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: /^SO-/ })).toBeVisible();
  await page.getByRole("button", { name: "Invoice and deliver now" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales invoice" })).toBeVisible();
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByRole("heading", { name: /^SI-/ })).toBeVisible();
  const [invoice] = await sql`select number, tax_total::numeric(20,2)::text as tax, further_tax_total::numeric(20,2)::text as further from public.sales_documents where tenant_id = ${tenantId} and kind = 'invoice'`;
  expect([invoice.tax, invoice.further]).toEqual(["360.00", "80.00"]);

  // The return is listed with the reports.
  await page.goto("/reports");
  await expect(page.getByRole("link", { name: "Sales tax return" })).toBeVisible();
  await page.goto(`/tax-return?month=${month}`);
  const annexes = page.getByRole("table", { name: "Annexes" });
  await expect(annexes.getByRole("row").filter({ hasText: "Annex-C: domestic sales" })).toContainText("1");
  // Annex-C is what the ledger says.
  const beside = page.getByRole("table", { name: "Beside the ledger" });
  const output = beside.getByRole("row").filter({ hasText: "Output tax" });
  await expect(output).toHaveAttribute("data-agrees", "yes");
  await expect(output.getByRole("cell").nth(1)).toHaveText("360.00");
  await expect(output.getByRole("cell").nth(2)).toHaveText("360.00");
  await expect(beside.getByRole("row").filter({ hasText: "Further tax" }).getByRole("cell").nth(2)).toHaveText("80.00");
  // What stands in the way of a clean file.
  const problems = page.getByTestId("return-problem");
  await expect(problems.filter({ hasText: "The province the company supplies from is not set." })).toBeVisible();
  await expect(problems.filter({ hasText: "1 document is to an unregistered buyer with no CNIC or NTN." })).toBeVisible();

  await page.getByLabel("The province the company supplies from").selectOption({ label: "Sindh" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(problems.filter({ hasText: "The province the company supplies from is not set." })).toHaveCount(0);
  expect((await sql`select province from public.tax_return_settings where tenant_id = ${tenantId}`)[0].province).toBe("sindh");
  expect(await sql`select 1 from public.audit_log where tenant_id = ${tenantId} and action = 'tax_return.province'`).toHaveLength(1);

  // The annex itself, as it will be uploaded.
  await annexes.getByRole("link", { name: "Annex-C: domestic sales" }).click();
  await expect(page).toHaveURL(new RegExp(`/tax-return/annex-c\\?month=${month}$`));
  const row = page.getByRole("table", { name: "Annex-C: domestic sales" }).locator('tbody tr[data-row="line"]');
  await expect(row).toHaveCount(1);
  for (const text of ["Walk-in Rider", "Unregistered", "Sindh", "Sale Invoice", invoice.number, "6506.1000", "18%", "2,000.00", "360.00", "80.00", "2,440.00"]) await expect(row).toContainText(text);

  const [excel] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download Excel" }).click()]);
  expect(excel.suggestedFilename()).toBe(`annex-c-${month}.xlsx`);
  expect((await readFile(await excel.path())).subarray(0, 2).toString()).toBe("PK");
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download CSV" }).click()]);
  expect(csv.suggestedFilename()).toBe(`annex-c-${month}.csv`);
  const lines = (await readFile(await csv.path(), "utf8")).slice(1).trim().split("\r\n");
  expect(lines).toHaveLength(2);
  expect(lines[0].startsWith("Sr.,Buyer NTN,Buyer CNIC,Buyer STRN,Buyer Name,Buyer Type")).toBe(true);
  expect(lines[1]).toContain(`Walk-in Rider,Unregistered,Sindh,,Sale Invoice,${invoice.number}`);
  expect(lines[1]).toContain("2000.00");
});

test("a salesperson has no way to the return", async ({ page }) => {
  await signIn(page, seller);
  await page.goto(`/tax-return?month=${month}`);
  await expect(page.getByText("Only an owner, an accountant or an auditor can see the sales tax return.")).toBeVisible();
  await page.goto(`/tax-return/annex-c?month=${month}`);
  await expect(page.getByText("Only an owner, an accountant or an auditor can see the sales tax return.")).toBeVisible();
  expect((await page.request.get(`/tax-return/export?annex=annex-c&month=${month}&format=csv`)).status()).toBe(404);
});
