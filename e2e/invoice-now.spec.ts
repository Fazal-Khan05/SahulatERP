import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// One-step "New invoice" on screen (batch A): the owner invoices a customer on the list in one
// go and ends on the posted invoice with Print and Download PDF; a salesperson's sale over the
// customer's credit limit is left as an order waiting for approval; a sale short of stock waits as
// a draft invoice with the market-purchase link. What each posts is tested against the database
// in src/modules/direct-invoices.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let seller: TestUser;
let tenantId: string;
let itemId: string;
let warehouseId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("invnow-owner", { canCreateCompany: true });
  seller = await createUser("invnow-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);
const onHand = async () => (await sql<{ q: string }[]>`select trim_scale(quantity)::text as q from public.stock_balances where tenant_id = ${tenantId} and item_id = ${itemId} and warehouse_id = ${warehouseId}`)[0].q;

async function pick(page: Page, label: string, typed: string) {
  const box = shown(page.getByRole("combobox", { name: label, exact: true }));
  await box.fill(typed);
  await box.press("Tab");
  await expect(box).toHaveAttribute("data-picked", "true");
}

/** A new invoice for the customer typed, of so many helmets. */
async function newInvoice(page: Page, customer: string, quantity: string) {
  await page.goto("/sales?kind=invoice");
  await page.getByRole("link", { name: "New invoice", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New invoice" })).toBeVisible();
  await pick(page, "Customer", customer);
  await pick(page, "Item, line 1", "HL-1");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill(quantity);
}

test("the owner invoices a customer in one go, and the invoice is posted with its print and PDF", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Invoice Now Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  itemId = item.id;
  warehouseId = (await sql<{ id: string }[]>`select id from public.warehouses where tenant_id = ${tenantId}`)[0].id;
  await seedStock(sql, { tenantId, itemId, warehouseId, quantity: "10", value: "6000", userId: owner.id });
  await sql`insert into public.customers (tenant_id, name, code, credit_limit, credit_days, created_by, updated_by) values
    (${tenantId}, 'Khan Autos', 'C-001', 5000, 30, ${owner.id}, ${owner.id}),
    (${tenantId}, 'City Bikes', 'C-002', null, null, ${owner.id}, ${owner.id})`;

  await newInvoice(page, "khan", "2");
  await expect(page.getByTestId("credit-note")).toHaveText("Credit limit 5,000.00. Owes 0.00. Room for 5,000.00 more.");
  await expect(page.getByTestId("form-total")).toHaveText("2,000.00");
  await page.getByRole("button", { name: "Make the invoice" }).click();

  await expect(page.getByRole("heading", { name: "SI-2627-00001" })).toBeVisible();
  await expect(page.getByText("Sales invoice for Khan Autos")).toBeVisible();
  await expect(page.getByRole("link", { name: "SO-2627-00001" })).toBeVisible();
  await expect(shown(page.getByRole("link", { name: "Print" }))).toBeVisible();
  await expect(shown(page.getByRole("link", { name: "Download PDF" }))).toBeVisible();
  expect(await journal("SI-2627-00001")).toEqual(["1200 2000 0", "4100 0 2000", "5100 1200 0", "1300 0 1200"]);
  expect(await onHand()).toBe("8");
});

test("a salesperson's sale over the credit limit is left as an order waiting for the owner", async ({ page }) => {
  await signIn(page, seller);
  await newInvoice(page, "khan", "4");
  await page.getByRole("button", { name: "Make the invoice" }).click();
  await expect(page.getByRole("heading", { name: "Sales order waiting for approval" })).toBeVisible();
  expect(await onHand()).toBe("8");
  expect((await sql<{ n: number }[]>`select count(*)::int as n from public.sales_documents where tenant_id = ${tenantId} and kind = 'invoice'`)[0].n).toBe(1);
});

test("a sale short of stock waits as a draft invoice, with the market-purchase link", async ({ page }) => {
  await signIn(page, owner);
  await newInvoice(page, "city", "12");
  await page.getByRole("button", { name: "Make the invoice" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales invoice" })).toBeVisible();
  await expect(shown(page.getByTestId("short-of-stock"))).toContainText("HL-1 Helmet: 12 pc needed, 8 pc in stock, 4 pc short");
  await expect(page.getByRole("link", { name: "Buy the missing goods from the market" })).toHaveAttribute("href", /\/purchases\/market\?item=.*quantity=4/);
  expect(await onHand()).toBe("8");
});
