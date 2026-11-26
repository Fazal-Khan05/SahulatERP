import { expect, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 49 on screen: a company brought in from the system it used before, from that system's own
// Excel and CSV files: customers (matched column by column, a total row left out, the same file
// refused the second time), items, each warehouse's opening stock, unpaid invoices and the trial
// balance; then the check that every part agrees with the books. Every name and figure is made
// up. The rules are tested against the database in src/modules/data-import.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let accountant: TestUser;
let auditor: TestUser;
let seller: TestUser;
let tenantId: string;

/** A date `days` before today in Pakistan, as 2026-06-30. */
const daysAgo = (days: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date(Date.now() - days * 86_400_000));
const today = daysAgo(0);

async function workbook(rows: (string | number | null)[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Export").addRows(rows);
  return Buffer.from(await book.xlsx.writeBuffer());
}
const xlsx = (name: string, buffer: Buffer) => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
const csv = (name: string, lines: string[]) => ({ name, mimeType: "text/csv", buffer: Buffer.from(lines.join("\r\n")) });

/** Opens one kind's import from Settings, Import data. */
async function openImport(page: Page, button: string) {
  await page.goto("/settings/import");
  await page.getByRole("link", { name: button, exact: true }).click();
  await expect(page.getByLabel("File to import")).toBeVisible();
}

async function checkAndImport(page: Page, ready: RegExp, done: string) {
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByTestId("import-ready")).toHaveText(ready);
  await page.getByRole("button", { name: /^Import / }).click();
  await expect(page.getByTestId("import-done")).toContainText(done);
}

const customers = () =>
  workbook([
    ["Old Ledger Pro - Customer List"],
    ["Printed on", "20-11-2026"],
    [],
    ["Cust Code", "Customer Name", "Mobile No", "City"],
    ["C-101", "E2E Zeta Traders", "0300-0000001", "Lahore"],
    ["C-102", "E2E Eta Autos", "0300-0000002", "Multan"],
    ["C-103", "E2E Theta Store", null, "Karachi"],
    [null, "Total", null, null],
  ]);

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("import-owner", { canCreateCompany: true });
  accountant = await createUser("import-accountant", { canCreateCompany: false });
  auditor = await createUser("import-auditor", { canCreateCompany: false });
  seller = await createUser("import-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("an owner brings a company in from an old system's files, and the books agree", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Import Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id}),
    (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id})`;

  // Settings has the way in; each kind says what it is and has a template.
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Import data" }).click();
  await expect(page.getByTestId("import-customers")).toContainText("Now: 0 customers.");
  await expect(page.getByTestId("import-customer_balances")).toContainText("Start the opening entry first");
  const template = await page.request.get("/settings/import/customers/template?format=csv");
  expect((await template.text()).replace(/^﻿/, "").split("\r\n")[0]).toBe(
    "Code,Name,Registration,NTN,CNIC,STRN,ATL status,Province,Credit limit,Credit days,Class,Withholding agent,Contact person,Phone,Email,Address,City",
  );

  // 1. Customers: the old system's headings, its name and the date above them, a total below.
  // One file, sent twice: a workbook made again would carry another time inside it.
  const customersFile = xlsx("customers.xlsx", await customers());
  await openImport(page, "Import customers");
  await page.getByLabel("File to import").setInputFiles(customersFile);
  await expect(page.getByLabel("The headings are in row")).toHaveValue("4");
  await expect(page.getByLabel("Name (needed)")).toHaveValue("1");
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue("2");
  await expect(page.getByLabel("Code", { exact: true })).toHaveValue("");
  await page.getByLabel("Code", { exact: true }).selectOption({ label: "A: Cust Code" });
  // Left in, the total would be a customer called "Total": the rows read as ours show it.
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByTestId("import-ready")).toHaveText("Every row is right: 4 customers can be imported. Nothing has been kept yet.");
  await expect(page.getByRole("table", { name: "The file read as ours" })).toContainText("Total");
  await page.getByLabel("Rows to leave out").fill("8");
  await expect(page.getByTestId("import-ready")).toHaveCount(0);
  await checkAndImport(page, /3 customers can be imported/, "Imported 3 customers.");
  expect((await sql`select count(*)::int as n from public.customers where tenant_id = ${tenantId}`)[0].n).toBe(3);

  // The same file again: known, and nothing in it goes in twice.
  await openImport(page, "Import customers");
  await page.getByLabel("File to import").setInputFiles(customersFile);
  await expect(page.getByLabel("Code", { exact: true })).toHaveValue("0");
  await page.getByLabel("Rows to leave out").fill("8");
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByRole("note")).toContainText("This very file was imported as customers on");
  await expect(page.getByTestId("import-problems")).toContainText("A customer with this name already exists.");
  await expect(page.getByRole("button", { name: /^Import / })).toHaveCount(0);
  expect((await sql`select count(*)::int as n from public.customers where tenant_id = ${tenantId}`)[0].n).toBe(3);

  // 2. Items, by headings other systems use.
  await openImport(page, "Import items");
  await page.getByLabel("File to import").setInputFiles(csv("items.csv", ["Item Code,Item Name,UOM,Sale Rate", "P-1,Brake pad,Piece,950", "P-2,Oil filter,Piece,420"]));
  await expect(page.getByLabel("Unit (needed)")).toHaveValue("2");
  await checkAndImport(page, /2 items can be imported/, "Imported 2 items.");

  // The opening entry sets the day the books open here.
  await page.goto("/settings/opening-balances");
  await page.getByLabel("Opening date").fill(today);
  await page.getByRole("button", { name: "Start opening balances" }).click();
  await expect(page.getByTestId("opening-status")).toHaveText("Draft: not in the books yet.");

  // 3. Opening stock, by the warehouse each row names; it comes in as a draft to post.
  await openImport(page, "Import opening stock");
  await page.getByLabel("File to import").setInputFiles(
    xlsx("stock.xlsx", await workbook([["Godown", "Item Code", "Closing Qty", "Avg Cost"], ["Main warehouse", "P-1", 10, 600], ["Main warehouse", "P-2", 25, 275.25]])),
  );
  await expect(page.getByLabel("Warehouse", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Counted on")).toHaveValue(today);
  await checkAndImport(page, /2 lines of stock can be imported/, "Imported 2 lines of stock.");
  await page.getByRole("link", { name: "Open the draft" }).click();
  await page.getByRole("button", { name: "Post opening stock" }).click();
  await expect.poll(async () => (await sql`select status from public.stock_adjustments where tenant_id = ${tenantId} and kind = 'opening'`).map((row) => row.status)).toEqual(["posted"]);

  // 4. What customers owe, invoice by invoice.
  await openImport(page, "Import what customers owe");
  await page.getByLabel("File to import").setInputFiles(
    csv("receivables.csv", ["Customer Name,Invoice No,Inv Date,Balance", `E2E Zeta Traders,OLD-501,${daysAgo(40)},12000`, `E2E Eta Autos,OLD-502,${daysAgo(5)},3500.50`]),
  );
  await checkAndImport(page, /2 unpaid invoices can be imported/, "Imported 2 unpaid invoices.");

  // 5. The trial balance, by our account codes, without the stock and the customers.
  await openImport(page, "Import trial balance");
  await page.getByLabel("File to import").setInputFiles(
    xlsx("tb.xlsx", await workbook([["Trial Balance"], [], ["A/C Code", "Particulars", "Dr", "Cr"], ["1111", "Cash in hand", 50000, null], ["3100", "Owner's capital", null, 72882.75]])),
  );
  await checkAndImport(page, /2 account balances can be imported/, "Imported 2 account balances.");
  await page.goto("/settings/opening-balances");
  await page.getByRole("button", { name: "Post opening balances" }).click();
  await expect(page.getByTestId("opening-status")).toContainText("Posted");

  // The check: nothing left to do, and every part agrees with the books.
  await page.goto("/settings/import/check");
  await expect(page.getByTestId("import-waiting")).toHaveCount(0);
  await expect(page.getByTestId("import-agreement")).toHaveText("Each agrees with its account in the books.");
  const against = page.getByRole("table", { name: "Against the books" });
  await expect(against.locator("tr", { hasText: "Stock" })).toContainText("12,881.25");
  await expect(against.locator("tr", { hasText: "What customers owe" })).toContainText("15,500.50");
  await expect(page.getByRole("table", { name: "Trial balance" })).toContainText("Owner's capital");

  await page.goto("/settings/import");
  const history = page.getByRole("table", { name: "Imported so far" });
  await expect(history.getByRole("row")).toHaveCount(1 + 5);
  await expect(history).toContainText("customers.xlsx");
});

test("an accountant imports too; the auditor and a salesperson have no way in", async ({ page }) => {
  await signIn(page, accountant);
  await page.goto("/settings/import");
  await expect(page.getByTestId("import-suppliers")).toContainText("Now: 0 suppliers.");

  await page.context().clearCookies();
  await signIn(page, auditor);
  await page.goto("/settings/import");
  await expect(page.getByText("Only an owner or an accountant can import a company's data.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Import data" })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, seller);
  await page.goto("/settings/import/customers");
  await expect(page.getByText("Only an owner or an accountant can import a company's data.")).toBeVisible();
  expect((await page.request.get("/settings/import/customers/template?format=csv")).status()).toBe(404);
});
