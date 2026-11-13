import { expect, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 20 on screen: an invoice made straight from an order delivers and bills at once; the
// rest of the order is delivered by a note and that note is invoiced; each invoice shows what it
// put into the books. The journals themselves, with sales tax and further tax, are tested in
// src/modules/sales/invoice.test.ts against the worked example of docs/examples/step-20.md.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;
let tenantId: string;
let orderId: string;
let firstInvoice: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("invoice-owner", { canCreateCompany: true });
  keeper = await createUser("invoice-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const books = (page: Page) => page.getByRole("table", { name: "In the books" }).filter({ visible: true }).locator("tbody tr");
const stock = async () => {
  const [row] = await sql`select b.quantity::text, b.value::text from public.stock_balances b join public.items i on i.id = b.item_id where b.tenant_id = ${tenantId} and i.code = 'HL-1'`;
  return `${Number(row.quantity)} worth ${Number(row.value)}`;
};

test("an owner invoices part of an order straight away: the goods leave stock and the invoice is in the books", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Invoice Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  await sql`insert into public.customers (tenant_id, name, code, credit_days, created_by, updated_by) values (${tenantId}, 'Registered Dealer', 'C-001', 30, ${owner.id}, ${owner.id})`;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  // Ten helmets that cost 600 each: the app cannot receive stock until purchases are built.
  await seedStock(sql, { tenantId, itemId: item.id, warehouseId: warehouse.id, quantity: "10", value: "6000", userId: owner.id });

  await page.goto("/sales/new?kind=order");
  const customer = page.getByRole("combobox", { name: "Customer", exact: true });
  await customer.fill("C-001");
  await customer.press("Tab");
  await expect(customer).toHaveAttribute("data-picked", "true");
  const picker = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await picker.fill("HL-1");
  await picker.press("Tab");
  await expect(picker).toHaveAttribute("data-picked", "true");
  await expect(visible(page, "line-name-1")).toHaveText("Helmet");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: "SO-2627-00001" })).toBeVisible();
  orderId = page.url().split("/").pop()!;

  // Straight from the order: the invoice starts with everything still to deliver.
  await page.getByRole("button", { name: "Invoice and deliver now" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales invoice" })).toBeVisible();
  firstInvoice = page.url().split("/").pop()!;
  const now = page.getByLabel("Invoice now, line 1", { exact: true }).filter({ visible: true });
  await expect(now).toHaveValue("5");
  await expect(visible(page, "in-stock-1")).toHaveText("10");
  await expect(visible(page, "document-total")).toHaveText("5,000.00");

  // Two now; the other three wait for the warehouse. An invoice cannot be taken back, so a
  // change is saved and shown first: the first press saves, the second posts what is on screen.
  await now.fill("2");
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByRole("status").filter({ visible: true })).toHaveText("Saved, not posted yet: the figures below have changed. Check them, then post the invoice.");
  await expect(visible(page, "document-total")).toHaveText("2,000.00");
  expect((await sql`select status from public.sales_documents where id = ${firstInvoice}`)[0].status).toBe("draft");
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByRole("heading", { name: "SI-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  await expect(visible(page, "document-total")).toHaveText("2,000.00");
  await expect(visible(page, "due-date")).toBeVisible();
  // What it put into the books: the customer owes 2,000, and two helmets left stock at 600 each.
  await expect(books(page)).toHaveCount(4);
  await expect(books(page).nth(0)).toContainText("1200 Trade receivables");
  await expect(books(page).nth(0)).toContainText("2,000.00");
  await expect(books(page).nth(1)).toContainText("4100 Sales");
  await expect(books(page).nth(2)).toContainText("5100 Cost of goods sold");
  await expect(books(page).nth(2)).toContainText("1,200.00");
  await expect(books(page).nth(3)).toContainText("1300 Stock in trade");
  await expect(page.getByRole("button", { name: /Post invoice|Discard|Cancel/ })).toHaveCount(0);
  expect(await stock()).toBe("8 worth 4800");
  const [invoice] = await sql`select status, number, total::text, (due_date - document_date) as days, buyer_name from public.sales_documents where id = ${firstInvoice}`;
  expect(invoice).toEqual({ status: "submitted", number: "SI-2627-00001", total: "2000.0000", days: 30, buyer_name: "Registered Dealer" });
});

test("the rest is delivered by a note, the note is invoiced, and it cannot then be cancelled", async ({ page }) => {
  await signIn(page, owner);
  await page.goto(`/sales/${orderId}`);
  await expect(visible(page, "to-deliver-1")).toHaveText("3");
  await expect(visible(page, "invoiced-1")).toHaveText("2");
  await page.getByRole("button", { name: "Make a delivery note" }).click();
  await expect(page.getByRole("heading", { name: "Draft delivery note" })).toBeVisible();
  await expect(page.getByLabel("Deliver now, line 1", { exact: true }).filter({ visible: true })).toHaveValue("3");
  await page.getByRole("button", { name: "Post delivery note" }).click();
  await expect(page.getByRole("heading", { name: "DN-2627-00001" })).toBeVisible();
  // The note's own entry: cost of goods sold against stock.
  await expect(books(page)).toHaveCount(2);
  await expect(books(page).nth(0)).toContainText("1,800.00");

  // The invoice bills exactly what the note delivered: there is no quantity to type.
  await page.getByRole("button", { name: "Make a sales invoice" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales invoice" })).toBeVisible();
  await expect(page.getByRole("link", { name: "delivery note DN-2627-00001" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Lines to deliver" })).toHaveCount(0);
  await expect(visible(page, "document-total")).toHaveText("3,000.00");
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByRole("heading", { name: "SI-2627-00002" })).toBeVisible();
  // No stock and no cost on this one: the delivery note had both.
  await expect(books(page)).toHaveCount(2);
  await expect(books(page).nth(0)).toContainText("1200 Trade receivables");
  await expect(books(page).nth(1)).toContainText("4100 Sales");
  expect(await stock()).toBe("5 worth 3000");

  // The delivery note now points at its invoice and can no longer be cancelled.
  await page.getByRole("link", { name: "DN-2627-00001" }).click();
  await expect(page.getByRole("heading", { name: "DN-2627-00001" })).toBeVisible();
  await expect(page.getByRole("link", { name: "SI-2627-00002" })).toBeVisible();
  await expect(page.getByText("This delivery note has been invoiced. It can no longer be cancelled.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel delivery note" })).toHaveCount(0);

  // The order is delivered and invoiced in full, and both invoices are in the list.
  await page.goto(`/sales/${orderId}`);
  await expect(visible(page, "to-deliver-1")).toHaveText("0");
  await expect(visible(page, "invoiced-1")).toHaveText("5");
  await expect(page.getByText("This order has been invoiced. It can no longer be cancelled.")).toBeVisible();
  await page.goto("/sales?kind=invoice");
  const rows = page.getByRole("table", { name: "Sales invoices" }).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Posted");

  // The books: the customer owes both invoices; every journal has its document.
  const [owed] = await sql`select sum(l.debit - l.credit)::text as owed from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenantId} and a.control_type = 'ar'`;
  expect(Number(owed.owed)).toBe(5000);
  const [journals] = await sql`select count(*)::int as n, count(d.id)::int as documented from public.journals j left join public.sales_documents d on d.id = j.source_id and d.number = j.document_number where j.tenant_id = ${tenantId}`;
  expect(journals).toEqual({ n: 3, documented: 3 });
});

test("the warehouse does not see invoices", async ({ page }) => {
  await signIn(page, keeper);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Deliveries", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Kind of document" }).getByRole("link", { name: "Sales invoices" })).toHaveCount(0);
  // Asked for by address, the invoice list falls back to delivery notes and the invoice itself is not found.
  await page.goto("/sales?kind=invoice");
  await expect(page.getByRole("table", { name: "Delivery notes" })).toBeVisible();
  await page.goto(`/sales/${firstInvoice}`);
  await expect(page.getByRole("heading", { name: "SI-2627-00001" })).toHaveCount(0);
  // A delivery note shows the warehouse no entry in the books and no invoice.
  await page.goto("/sales?kind=delivery");
  await page.getByRole("table", { name: "Delivery notes" }).getByRole("link", { name: "DN-2627-00001" }).click();
  await expect(page.getByRole("heading", { name: "DN-2627-00001" })).toBeVisible();
  await expect(page.getByRole("table", { name: "In the books" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Make a sales invoice" })).toHaveCount(0);
});
