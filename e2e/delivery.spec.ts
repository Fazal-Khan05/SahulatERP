import { expect, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 19 on screen: the warehouse makes a delivery note from a submitted order, delivers part
// of it, and the goods leave stock at their cost; the owner sees the cost and cancels the note,
// which puts the goods back. The rules themselves are tested in src/modules/sales.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;
let tenantId: string;
let orderId: string;
let noteId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("delivery-owner", { canCreateCompany: true });
  keeper = await createUser("delivery-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const stock = async () => {
  const [row] = await sql`select b.quantity::text, b.value::text from public.stock_balances b join public.items i on i.id = b.item_id where b.tenant_id = ${tenantId} and i.code = 'HL-1'`;
  return `${Number(row.quantity)} worth ${Number(row.value)}`;
};

test("an owner submits an order, and the order shows what is still to deliver", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Delivery Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  await sql`insert into public.customers (tenant_id, name, code, created_by, updated_by) values (${tenantId}, 'Registered Dealer', 'C-001', ${owner.id}, ${owner.id})`;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  // Ten helmets that cost 600 each: the app cannot receive stock until purchases are built.
  await seedStock(sql, { tenantId, itemId: item.id, warehouseId: warehouse.id, quantity: "10", value: "6000", userId: owner.id });

  await page.goto("/sales/new?kind=order");
  const customer = page.getByRole("combobox", { name: "Customer", exact: true });
  await customer.fill("C-001");
  await customer.press("Tab");
  await expect(customer).toHaveAttribute("data-picked", "true");
  await expect(customer).toHaveValue("Registered Dealer");
  const picker = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await picker.fill("HL-1");
  await picker.press("Tab");
  await expect(visible(page, "line-name-1")).toHaveText("Helmet");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: "SO-2627-00001" })).toBeVisible();
  orderId = page.url().split("/").pop()!;
  await expect(visible(page, "to-deliver-1")).toHaveText("5");
  await expect(page.getByRole("button", { name: "Make a delivery note" })).toBeVisible();
});

test("the warehouse delivers part of the order and the goods leave stock", async ({ page }) => {
  await signIn(page, keeper);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Deliveries", exact: true }).click();
  await expect(page).toHaveURL(/\/sales\?kind=delivery$/);
  await expect(page.getByText("No delivery notes yet.")).toBeVisible();
  // The warehouse sees no quotations, and reads the order without its prices.
  await expect(page.getByRole("navigation", { name: "Kind of document" }).getByRole("link", { name: "Quotations" })).toHaveCount(0);
  await page.getByRole("list", { name: "Orders waiting to be delivered" }).getByRole("link", { name: "SO-2627-00001" }).click();
  await expect(page).toHaveURL(new RegExp(`/sales/${orderId}$`));
  await expect(page.getByRole("heading", { name: "SO-2627-00001" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Price" })).toHaveCount(0);
  await expect(page.getByText("1,000.00")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Cancel sales order/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Make a delivery note" }).click();
  await expect(page.getByRole("heading", { name: "Draft delivery note" })).toBeVisible();
  noteId = page.url().split("/").pop()!;
  await expect(visible(page, "in-stock-1")).toHaveText("10");
  const now = page.getByLabel("Deliver now, line 1", { exact: true }).filter({ visible: true });
  await expect(now).toHaveValue("5");

  // More than was ordered is refused; the draft keeps what was typed.
  await now.fill("12");
  await page.getByRole("button", { name: "Post delivery note" }).click();
  await expect(visible(page, "form-error")).toHaveText("HL-1: the order has 5 still to deliver, not 12.");
  expect(await stock()).toBe("10 worth 6000");

  await now.fill("2");
  await page.getByRole("button", { name: "Post delivery note" }).click();
  await expect(page.getByRole("heading", { name: "DN-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  // The warehouse is not shown what the goods cost.
  await expect(page.getByTestId("delivery-cost")).toHaveCount(0);

  // 2 of 10 helmets worth 6,000 left stock: 1,200 to cost of goods sold.
  expect(await stock()).toBe("8 worth 4800");
  const journal = await sql<{ line: string }[]>`
    select a.code || ' ' || l.debit::text || ' ' || l.credit::text as line from public.journals j
    join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
    where j.source_type = 'delivery_note' and j.source_id = ${noteId} order by l.line_no`;
  expect(journal.map((j) => j.line)).toEqual(["5100 1200.0000 0.0000", "1300 0.0000 1200.0000"]);
  const [note] = await sql`select status, number, submitted_by from public.sales_documents where id = ${noteId}`;
  expect(note).toEqual({ status: "submitted", number: "DN-2627-00001", submitted_by: keeper.id });
});

test("the owner sees what the goods cost, and cancelling the note puts them back", async ({ page }) => {
  await signIn(page, owner);
  await page.goto(`/sales/${orderId}`);
  const deliveries = page.getByRole("table", { name: "Deliveries" });
  await expect(deliveries.locator("tbody tr").first()).toContainText("HL-1");
  await expect(visible(page, "to-deliver-1")).toHaveText("3");
  // Goods are out: the order cannot be cancelled until the note is.
  await expect(page.getByText("Goods have been delivered against this order.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel sales order" })).toHaveCount(0);

  await page.goto("/sales?kind=delivery");
  await page.getByRole("table", { name: "Delivery notes" }).getByRole("link", { name: "DN-2627-00001" }).click();
  await expect(visible(page, "delivery-cost")).toHaveText("1,200.00");

  await page.getByLabel("Why it is cancelled").fill("Delivered to the wrong shop");
  await page.getByRole("button", { name: "Cancel delivery note" }).click();
  await expect(visible(page, "document-status")).toHaveText("Cancelled");
  expect(await stock()).toBe("10 worth 6000");
  const [reversal] = await sql`select count(*)::int as n from public.journals r join public.journals j on j.id = r.reverses_journal_id where j.source_type = 'delivery_note' and j.source_id = ${noteId}`;
  expect(reversal.n).toBe(1);

  await page.goto(`/sales/${orderId}`);
  await expect(visible(page, "to-deliver-1")).toHaveText("5");
  await expect(page.getByRole("button", { name: "Cancel sales order" })).toBeVisible();
});
