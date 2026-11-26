import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// The sales analysis on screen: an owner sells five helmets to one customer and three to
// another, then reads each report with a known figure (8,000 sold, 4,800 of cost), sees each
// agree with the books, downloads one and prints one; the sales manager sees the sales and no
// cost; a salesperson has no way in. What each report adds up, shared lines, credit notes,
// branches and the comparison with the books are tested against the database in
// src/modules/sales-reports.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let manager: TestUser;
let seller: TestUser;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("sales-reports-owner", { canCreateCompany: true });
  manager = await createUser("sales-reports-manager", { canCreateCompany: false });
  seller = await createUser("sales-reports-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const table = (page: Page, name: string) => shown(page.getByRole("table", { name }));
const row = (page: Page, name: string, text: string) => table(page, name).locator("tbody tr").filter({ hasText: text });
const REPORTS = ["sales-by-customer", "sales-by-item", "sales-by-salesperson", "sales-by-city", "sales-by-month", "sales-register"];

/** An order for so many helmets to a customer, invoiced and delivered at once, as the signed-in member. Ends on the posted invoice. */
async function sell(page: Page, customer: string, quantity: string) {
  await page.goto("/sales/new?kind=order");
  const picked = page.getByRole("combobox", { name: "Customer", exact: true });
  await picked.fill(customer);
  await picked.press("Tab");
  await expect(picked).toHaveAttribute("data-picked", "true");
  const picker = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await picker.fill("HL-1");
  await picker.press("Tab");
  await expect(picker).toHaveAttribute("data-picked", "true");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill(quantity);
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: /^SO-2627-/ })).toBeVisible();
  await page.getByRole("button", { name: "Invoice and deliver now" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales invoice" })).toBeVisible();
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByRole("heading", { name: /^SI-2627-/ })).toBeVisible();
}

test("an owner reads the sales analysis, each report agreeing with the books", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Sales Reports");
  const [{ id: tenantId }] = await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${manager.id}, ${manager.email}, 'sales_manager', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  const customers = await sql`insert into public.customers (tenant_id, name, code, credit_days, created_by, updated_by) values
    (${tenantId}, 'Khan Autos', 'C-001', 30, ${owner.id}, ${owner.id}), (${tenantId}, 'Bilal Traders', 'C-002', 30, ${owner.id}, ${owner.id}) returning id, code`;
  for (const customer of customers) await sql`insert into public.party_addresses (tenant_id, customer_id, city, created_by, updated_by) values (${tenantId}, ${customer.id}, ${customer.code === "C-001" ? "Lahore" : "Karachi"}, ${owner.id}, ${owner.id})`;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  await seedStock(sql, { tenantId, itemId: item.id, warehouseId: warehouse.id, quantity: "20", value: "12000", userId: owner.id });
  await sell(page, "C-001", "5");
  await sell(page, "C-002", "3");

  // The Reports page lists them under their own heading.
  await page.goto("/reports");
  await expect(page.getByRole("list", { name: "Sales analysis" }).getByRole("link")).toHaveText(["Sales by customer", "Sales by item", "Sales by salesperson", "Sales by city", "Sales by month", "Sales register"]);
  await page.getByRole("list", { name: "Sales analysis" }).getByRole("link", { name: "Sales by customer" }).click();

  // By customer: 5,000 and 3,000, costing 3,000 and 1,800, and the books agree.
  await expect(page.getByRole("heading", { name: "Sales by customer" })).toBeVisible();
  await expect(row(page, "Sales by customer", "Khan Autos")).toContainText("5,000.00");
  await expect(row(page, "Sales by customer", "Bilal Traders")).toContainText("3,000.00");
  await expect(row(page, "Sales by customer", "Total")).toContainText("8,000.00");
  await expect(row(page, "Sales by customer", "Total")).toContainText("4,800.00");
  await expect(row(page, "Sales by customer", "Total")).toContainText("40.0%");
  await expect(row(page, "Sales by customer", "Sales in the books for the period")).toContainText("8,000.00");
  await expect(row(page, "Sales by customer", "Difference")).toContainText("0.00");

  // Each of the others has the same total, and the books say the same.
  await page.goto("/sales-reports/sales-by-item");
  await expect(row(page, "Sales by item", "HL-1")).toContainText("8 pc");
  await expect(row(page, "Sales by item", "HL-1")).toContainText("8,000.00");
  await expect(row(page, "Sales by item", "Difference")).toContainText("0.00");
  await page.goto("/sales-reports/sales-by-salesperson");
  await expect(row(page, "Sales by salesperson", owner.email)).toContainText("8,000.00");
  await expect(row(page, "Sales by salesperson", "Difference")).toContainText("0.00");
  await page.goto("/sales-reports/sales-by-city");
  await expect(row(page, "Sales by city", "Lahore")).toContainText("5,000.00");
  await expect(row(page, "Sales by city", "Karachi")).toContainText("3,000.00");
  await page.goto("/sales-reports/sales-by-month");
  await expect(table(page, "Sales by month").locator("tbody tr").first()).toContainText("8,000.00");
  await page.goto("/sales-reports/sales-register");
  await expect(table(page, "Sales register").locator("tbody tr").filter({ hasText: "Invoice SI-2627-" })).toHaveCount(2);
  await expect(row(page, "Sales register", "Total")).toContainText("8,000.00");
  await expect(row(page, "Sales register", "Difference")).toContainText("0.00");

  // The purchase reports are there too, empty for now.
  for (const report of ["purchases-by-supplier", "purchases-by-item", "purchase-register"]) {
    await page.goto(`/purchase-reports/${report}`);
    await expect(shown(page.getByRole("table")).locator("tbody tr")).toHaveCount(1);
  }

  // A file, and the letterhead.
  const file = await page.request.get("/sales-reports/export?report=sales-by-customer&format=csv");
  expect(file.status()).toBe(200);
  const csv = await file.text();
  expect(csv).toContain("Sales by customer");
  expect(csv).toContain("Khan Autos (C-001)");
  expect(csv).toContain("8000.00");
  const sheet = await page.request.get("/sales-reports/export?report=sales-register&format=xlsx");
  expect(sheet.status()).toBe(200);
  expect(sheet.headers()["content-type"]).toContain("spreadsheetml");
  await page.goto("/sales-reports/sales-by-customer");
  await page.getByRole("link", { name: "Print" }).click();
  await expect(page.getByTestId("print-header")).toContainText("E2E Sales Reports");
  await expect(page.getByRole("heading", { name: "Sales by customer" })).toBeVisible();
});

test("the sales manager sees the sales and no cost; a salesperson has no way in", async ({ page }) => {
  await signIn(page, manager);
  await page.goto("/sales-reports/sales-by-customer");
  await expect(row(page, "Sales by customer", "Khan Autos")).toContainText("5,000.00");
  await expect(row(page, "Sales by customer", "Total")).toContainText("8,000.00");
  await expect(shown(page.getByRole("columnheader", { name: "Cost of goods sold" }))).toHaveCount(0);
  await expect(page.getByText("Sales in the books for the period")).toHaveCount(0);
  await page.context().clearCookies();

  await signIn(page, seller);
  for (const report of REPORTS) {
    await page.goto(`/sales-reports/${report}`);
    await expect(page.getByText("Only an owner, an accountant, an auditor or the sales manager can see the sales reports.")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    expect((await page.request.get(`/sales-reports/export?report=${report}&format=csv`)).status()).toBe(404);
    // The printed page is streamed, so a refusal there is a page with nothing on it, not a status.
    expect(await (await page.request.get(`/print/sales-reports/${report}`)).text()).not.toContain("Khan Autos");
  }
  await page.goto("/reports");
  await expect(page.getByRole("list", { name: "Sales analysis" })).toHaveCount(0);
});
