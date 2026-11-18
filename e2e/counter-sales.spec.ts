import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 22 on screen: the owner sells two helmets at the counter to a walk-in buyer who pays in
// cash, and one more to a buyer who pays into the bank; the invoice names the buyer and shows
// it paid; the walk-in customer owes nothing and is offered nowhere else. A salesperson has no
// way in. What each of these posts is tested against the database in src/modules/counter-sales.

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
  owner = await createUser("counter-owner", { canCreateCompany: true });
  seller = await createUser("counter-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);
const onHand = async () => (await sql<{ q: string }[]>`select trim_scale(quantity)::text as q from public.stock_balances where tenant_id = ${tenantId} and item_id = ${itemId} and warehouse_id = ${warehouseId}`)[0].q;

/** Fills the counter sale's first line with so many helmets. */
async function helmets(page: Page, quantity: string) {
  const picker = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await picker.fill("HL-1");
  await picker.press("Tab");
  await expect(picker).toHaveAttribute("data-picked", "true");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill(quantity);
}

test("the owner sells at the counter to a walk-in buyer who pays in cash", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Counter Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  itemId = item.id;
  warehouseId = (await sql<{ id: string }[]>`select id from public.warehouses where tenant_id = ${tenantId}`)[0].id;
  await seedStock(sql, { tenantId, itemId, warehouseId, quantity: "10", value: "6000", userId: owner.id });
  await sql`insert into public.accounts (tenant_id, parent_id, code, name, type, is_group, control_type, created_by)
    select ${tenantId}, a.id, '1121', 'HBL current account', 'asset', false, 'bank', ${owner.id} from public.accounts a where a.tenant_id = ${tenantId} and a.code = '1120'`;

  await page.goto("/sales?kind=invoice");
  await page.getByRole("link", { name: "New counter sale" }).click();
  await expect(page.getByRole("heading", { name: "New counter sale" })).toBeVisible();
  await page.getByLabel("Buyer's name").fill("Bilal Ahmed");
  await page.getByLabel("Phone (if they give it)").fill("0300 1234567");
  await helmets(page, "2");
  await expect(page.getByTestId("form-total")).toHaveText("2,000.00");
  await expect(page.getByLabel("Cash account", { exact: true })).toHaveValue(/.+/);
  await page.getByRole("button", { name: "Record the sale and the payment" }).click();

  await expect(page.getByRole("heading", { name: "SI-2627-00001" })).toBeVisible();
  await expect(page.getByText("Counter sale to Bilal Ahmed, a walk-in buyer")).toBeVisible();
  await expect(visible(page, "counter-sale")).toHaveText("Paid in full at the counter in cash, receipt RC-2627-00001. Buyer's phone: 0300 1234567.");
  expect(await journal("SI-2627-00001")).toEqual(["1200 2000 0", "4100 0 2000", "5100 1200 0", "1300 0 1200"]);
  expect(await journal("RC-2627-00001")).toEqual(["1111 2000 0", "1200 0 2000"]);
  expect(await onHand()).toBe("8");
});

test("a buyer who pays into the bank, and a sale with too little in stock is refused whole", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/sales/counter");
  await page.getByLabel("Buyer's name").fill("Sara Khan");
  await helmets(page, "50");
  await page.getByRole("button", { name: "Record the sale and the payment" }).click();
  await expect(visible(page, "form-error")).toContainText("Not enough HL-1 in stock");
  expect((await sql<{ n: number }[]>`select count(*)::int as n from public.sales_documents where tenant_id = ${tenantId}`)[0].n).toBe(2);

  await page.getByLabel("Quantity, line 1", { exact: true }).fill("1");
  await page.getByLabel("Into a bank account (transfer or card)").check();
  await expect(page.getByLabel("Bank account", { exact: true })).toHaveValue(/.+/);
  await page.getByLabel("Reference (slip or card receipt no.)").fill("Card 4411");
  await page.getByRole("button", { name: "Record the sale and the payment" }).click();
  await expect(page.getByRole("heading", { name: "SI-2627-00002" })).toBeVisible();
  await expect(visible(page, "counter-sale")).toHaveText("Paid in full at the counter into the bank, receipt RC-2627-00002.");
  expect(await journal("RC-2627-00002")).toEqual(["1121 1000 0", "1200 0 1000"]);

  // The walk-in customer owes nothing, and is not offered where a customer is chosen.
  const [owed] = await sql<{ v: string }[]>`
    select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as v from public.journal_lines l
    join public.walk_in_customers w on w.tenant_id = l.tenant_id and w.customer_id = l.customer_id where l.tenant_id = ${tenantId}`;
  expect(owed.v).toBe("0.00");
  await page.goto("/sales/new?kind=order");
  const picked = page.getByRole("combobox", { name: "Customer", exact: true });
  await picked.fill("Walk-in");
  await expect(page.getByRole("option", { name: /Walk-in customer/ })).toHaveCount(0);
});

test("a salesperson has no way to the counter", async ({ page }) => {
  await signIn(page, seller);
  await page.goto("/sales?kind=invoice");
  await expect(page.getByRole("heading", { name: "Sales" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New counter sale" })).toHaveCount(0);
  await page.goto("/sales/counter");
  await expect(page.getByText("Only the owner or an accountant sells at the counter")).toBeVisible();
  await expect(page.getByLabel("Buyer's name")).toHaveCount(0);
});
