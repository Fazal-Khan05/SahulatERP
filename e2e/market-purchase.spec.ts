import { expect, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// A quick market purchase on screen: an order for nine helmets with five in stock; the warehouse's
// delivery note says four are short and who can buy them; the owner follows the offer, buys four
// in the market for cash, comes back to the note and posts it. Then a purchase from the Purchases
// screens, from a supplier on the list out of the bank. What each of these posts is tested
// against the database in src/modules/market-purchases.

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
  owner = await createUser("market-owner", { canCreateCompany: true });
  keeper = await createUser("market-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const stock = async () => {
  const [row] = await sql`select b.quantity::text, b.value::text from public.stock_balances b join public.items i on i.id = b.item_id where b.tenant_id = ${tenantId} and i.code = 'HL-1'`;
  return `${Number(row.quantity)} worth ${Number(row.value)}`;
};
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);

test("the owner takes an order for more than is in stock", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Market Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  await sql`insert into public.customers (tenant_id, name, code, created_by, updated_by) values (${tenantId}, 'Registered Dealer', 'C-001', ${owner.id}, ${owner.id})`;
  await sql`insert into public.suppliers (tenant_id, name, code, created_by, updated_by) values (${tenantId}, 'Lahore Wholesalers', 'S-001', ${owner.id}, ${owner.id})`;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  await seedStock(sql, { tenantId, itemId: item.id, warehouseId: warehouse.id, quantity: "5", value: "3000", userId: owner.id });
  await sql`insert into public.accounts (tenant_id, parent_id, code, name, type, is_group, control_type, created_by)
    select ${tenantId}, a.id, '1121', 'HBL current account', 'asset', false, 'bank', ${owner.id} from public.accounts a where a.tenant_id = ${tenantId} and a.code = '1120'`;

  await page.goto("/sales/new?kind=order");
  const customer = page.getByRole("combobox", { name: "Customer", exact: true });
  await customer.fill("C-001");
  await customer.press("Tab");
  await expect(customer).toHaveAttribute("data-picked", "true");
  const picker = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await picker.fill("HL-1");
  await picker.press("Tab");
  await expect(visible(page, "line-name-1")).toHaveText("Helmet");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill("9");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: "SO-2627-00001" })).toBeVisible();
  orderId = page.url().split("/").pop()!;
});

test("the warehouse's delivery note says what is short, and who can buy it", async ({ page }) => {
  // Nine to deliver, five in stock, four short. The warehouse cannot buy, and is told who can.
  await signIn(page, keeper);
  await page.goto(`/sales/${orderId}`);
  await page.getByRole("button", { name: "Make a delivery note" }).click();
  await expect(page.getByRole("heading", { name: "Draft delivery note" })).toBeVisible();
  noteId = page.url().split("/").pop()!;
  const short = visible(page, "short-of-stock");
  await expect(short).toContainText("HL-1 Helmet: 9 pc needed, 5 pc in stock, 4 pc short.");
  await expect(visible(page, "short-who-can-buy")).toContainText("the owner or an accountant records it under Purchases, Quick market purchase");
  await expect(page.getByRole("link", { name: "Buy the missing goods from the market" })).toHaveCount(0);
  await page.getByRole("button", { name: "Post delivery note" }).click();
  await expect(visible(page, "form-error")).toContainText("Not enough HL-1 in stock");
  // The warehouse has no way to the purchase itself.
  await page.goto("/purchases/market");
  await expect(page.getByText("Only the owner or an accountant makes a quick market purchase")).toBeVisible();
  await expect(page.getByRole("button", { name: "Record the purchase and the payment" })).toHaveCount(0);
});

test("the owner buys the missing goods from the market and the delivery goes through", async ({ page }) => {
  await signIn(page, owner);
  await page.goto(`/sales/${noteId}`);
  await expect(visible(page, "short-of-stock")).toContainText("4 pc short");
  await page.getByRole("link", { name: "Buy the missing goods from the market" }).click();
  await expect(page.getByRole("heading", { name: "Quick market purchase" })).toBeVisible();

  // Filled in with what is missing: the item, four of it, the warehouse.
  await expect(visible(page, "market-prefilled")).toBeVisible();
  await expect(page.getByLabel("Item code, line 1", { exact: true })).toHaveValue("HL-1");
  await expect(visible(page, "item-name-1")).toHaveText("Helmet");
  await expect(page.getByLabel("Quantity, line 1", { exact: true })).toHaveValue("4");
  await expect(page.getByLabel("Warehouse the goods came into")).toHaveValue(/.+/);
  await expect(visible(page, "tax-note")).toContainText("No sales tax is claimed and no tax is withheld on a quick market purchase.");

  // Nothing typed for the cost: refused, and nothing is recorded.
  await page.getByLabel("Seller's or shop's name").fill("Anarkali Helmet House");
  await page.getByLabel("Phone (if they give it)").fill("0300 1234567");
  await page.getByRole("button", { name: "Record the purchase and the payment" }).click();
  await expect(visible(page, "form-error")).toContainText("Line 1, cost");
  expect((await sql`select count(*)::int as n from public.purchase_orders where tenant_id = ${tenantId}`)[0].n).toBe(0);

  await page.getByLabel("Cost of one, line 1", { exact: true }).fill("650");
  await expect(visible(page, "purchase-total")).toHaveText("2,600.00");
  await page.getByLabel("Cash memo or bill no. (if any)").fill("CM-118");
  await expect(page.getByLabel("Cash account", { exact: true })).toHaveValue(/.+/);
  await page.getByRole("button", { name: "Record the purchase and the payment" }).click();

  // Back on the delivery note: bought, in stock, nothing short.
  await expect(page).toHaveURL(new RegExp(`/sales/${noteId}\\?bought=`));
  await expect(visible(page, "market-bought")).toContainText("Bought and in stock: goods received note GR-2627-00001");
  await expect(visible(page, "market-bought")).toContainText("There is now enough for this document");
  await expect(page.getByTestId("short-of-stock")).toHaveCount(0);
  await expect(visible(page, "in-stock-1")).toHaveText("9");
  expect(await stock()).toBe("9 worth 5600");
  // What a slow purchase would have left: goods in, the bill, the payment; nothing owed.
  expect(await journal("GR-2627-00001")).toEqual(["1300 2600 0", "2120 0 2600"]);
  const [made] = await sql<{ bill: string; payment: string; bill_id: string }[]>`
    select b.number as bill, p.number as payment, b.id as bill_id from public.market_purchases m
    join public.supplier_bills b on b.id = m.bill_id join public.supplier_payments p on p.id = m.payment_id where m.tenant_id = ${tenantId}`;
  expect(await journal(made.bill)).toEqual(["2120 2600 0", "2110 0 2600"]);
  expect(await journal(made.payment)).toEqual(["2110 2600 0", "1111 0 2600"]);

  await page.getByRole("button", { name: "Post delivery note" }).click();
  await expect(page.getByRole("heading", { name: "DN-2627-00001" })).toBeVisible();
  expect(await stock()).toBe("0 worth 0");

  // The bill's page says how it was made, and leads to the other documents.
  await page.goto(`/purchases/bills/${made.bill_id}`);
  const note = visible(page, "market-purchase");
  await expect(note).toContainText("Quick market purchase from Anarkali Helmet House (0300 1234567), cash memo CM-118. Paid in full in cash as it was bought.");
  await expect(note.getByRole("link", { name: "PO-2627-00001" })).toBeVisible();
  await expect(note.getByRole("link", { name: "GR-2627-00001" })).toBeVisible();
  await expect(note.getByRole("link", { name: made.payment })).toBeVisible();
});

test("from the Purchases screens: bought from a supplier on the list, paid out of the bank", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/purchases");
  await page.getByRole("link", { name: "Quick market purchase" }).click();
  await expect(page.getByRole("heading", { name: "Quick market purchase" })).toBeVisible();
  await expect(page.getByTestId("market-prefilled")).toHaveCount(0);

  await page.getByLabel("A supplier on your list").check();
  // The market seller itself is not offered as a supplier.
  await expect(page.getByLabel("Supplier", { exact: true }).getByRole("option")).toHaveText(["Choose a supplier", "Lahore Wholesalers (S-001)"]);
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Lahore Wholesalers (S-001)" });
  await page.getByLabel("Item code, line 1", { exact: true }).fill("HL-1");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill("10");
  await page.getByLabel("Cost of one, line 1", { exact: true }).fill("620");
  await page.getByLabel("From a bank account (transfer, cheque or card)").check();
  await expect(page.getByLabel("Bank account", { exact: true }).getByRole("option")).toHaveText(["1121 HBL current account"]);
  await page.getByLabel("Reference (cheque or slip no.)").fill("Chq 4411");
  await page.getByRole("button", { name: "Record the purchase and the payment" }).click();

  // With nowhere to go back to, it opens the bill it made.
  await expect(page).toHaveURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
  await expect(visible(page, "market-purchase")).toContainText("Quick market purchase. Paid in full from the bank as it was bought.");
  expect(await stock()).toBe("10 worth 6200");
  const [paid] = await sql<{ number: string; reference: string }[]>`
    select p.number, p.reference from public.supplier_payments p join public.suppliers s on s.id = p.supplier_id where p.tenant_id = ${tenantId} and s.code = 'S-001'`;
  expect(paid.reference).toBe("Chq 4411");
  expect(await journal(paid.number)).toEqual(["2110 6200 0", "1121 0 6200"]);
  // Nothing is left owed to anyone, and nothing is waiting to be billed.
  const [left] = await sql<{ ap: string; grni: string }[]>`
    select coalesce(sum(l.credit - l.debit) filter (where a.control_type = 'ap'), 0)::numeric(20,2)::text as ap,
           coalesce(sum(l.credit - l.debit) filter (where a.control_type = 'grni'), 0)::numeric(20,2)::text as grni
    from public.journal_lines l join public.accounts a on a.id = l.account_id where l.tenant_id = ${tenantId}`;
  expect(left).toEqual({ ap: "0.00", grni: "0.00" });
});
