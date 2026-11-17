import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 24 on screen: an owner orders goods from a supplier, the warehouse receives them in two
// lots without seeing what they cost, and the owner sees what arrived, checks it against the
// books and cancels an order nothing came against. What each of these writes is tested against
// the database in src/modules/purchasing.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;
let tenantId: string;
let orderUrl: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("purchase-owner", { canCreateCompany: true });
  keeper = await createUser("purchase-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

// A page visited earlier stays in the document, hidden: only what is on screen is looked at.
const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
const rail = (page: Page) => page.getByRole("navigation", { name: "Main" });
const stock = async (code: string) => {
  const [row] = await sql`
    select b.quantity::text, b.value::text from public.stock_balances b join public.items i on i.id = b.item_id
    where b.tenant_id = ${tenantId} and i.code = ${code}`;
  return row ? `${Number(row.quantity)} worth ${Number(row.value)}` : "none";
};
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);

async function fillLine(page: Page, row: number, code: string, quantity: string, cost: string) {
  await shown(page.getByLabel(`Item code, line ${row}`, { exact: true })).fill(code);
  await shown(page.getByLabel(`Quantity, line ${row}`, { exact: true })).fill(quantity);
  await shown(page.getByLabel(`Cost of one, line ${row}`, { exact: true })).fill(cost);
}
const arrived = (page: Page, row: number) => shown(page.getByLabel(`Arrived now, line ${row}`, { exact: true }));

test("an owner orders goods from a supplier, and nothing reaches the stock or the books", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Purchase Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  for (const [code, name] of [["HL-1", "Helmet"], ["CH-2", "Chain"]]) {
    await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, ${code}, ${name}, ${unit.id}, 100, ${owner.id}, ${owner.id})`;
  }
  await sql`insert into public.suppliers (tenant_id, code, name, created_by, updated_by) values (${tenantId}, 'S-001', 'Sigma Imports', ${owner.id}, ${owner.id})`;

  await page.goto("/purchases");
  await expect(page.getByText("No purchase orders yet.")).toBeVisible();
  await page.getByRole("link", { name: "New purchase order" }).click();
  await expect(page.getByRole("heading", { name: "New purchase order" })).toBeVisible();

  // An order with no lines is kept as a draft and not submitted.
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Sigma Imports (S-001)" });
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: "Draft purchase order" })).toBeVisible();
  await expect(visible(page, "form-error")).toHaveText("Saved as a draft, but not submitted. Try again to see why.");

  // The item's name shows beside its code, each line comes to its quantity at the cost of one, and the order to their sum.
  await fillLine(page, 1, "HL-1", "10", "600");
  await expect(visible(page, "item-name-1")).toHaveText("Helmet");
  await expect(visible(page, "line-amount-1")).toHaveText("6,000.00");
  await fillLine(page, 2, "XX-9", "1", "1");
  await expect(visible(page, "item-name-2")).toHaveText("No item has this code");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(visible(page, "form-error")).toHaveText("Line 2: choose an item.");
  await fillLine(page, 2, "CH-2", "20", "270.5");
  await expect(visible(page, "order-total")).toHaveText("11,410.00");
  await page.getByRole("button", { name: "Submit order" }).click();

  await expect(page.getByRole("heading", { name: "PO-2627-00001" })).toBeVisible();
  orderUrl = new URL(page.url()).pathname;
  await expect(visible(page, "document-status")).toHaveText("Submitted");
  await expect(page.getByText("Goods are still to arrive.")).toBeVisible();
  await expect(visible(page, "order-total")).toHaveText("11,410.00");
  await expect(page.getByText("Nothing has been received against this order yet.")).toBeVisible();
  // An order is a promise, not an entry: no stock, no journal.
  expect(await stock("HL-1")).toBe("none");
  expect((await sql`select count(*)::int as n from public.stock_moves where tenant_id = ${tenantId}`)[0].n).toBe(0);
  expect(await journal("PO-2627-00001")).toEqual([]);
});

test("the warehouse receives the order in two lots, without seeing what it costs", async ({ page }) => {
  await signIn(page, keeper);
  // The warehouse has no way into the orders themselves, where the costs are.
  await page.goto("/purchases");
  await expect(page.getByText("The warehouse receives goods under Receive goods.")).toBeVisible();
  await page.goto(orderUrl);
  await expect(page.getByText("The warehouse receives goods under Receive goods.")).toBeVisible();

  await rail(page).getByRole("link", { name: "Receive goods", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases\/receive$/);
  const waiting = page.getByRole("table", { name: "Orders with goods still to arrive" });
  await expect(waiting.locator("tbody tr")).toHaveCount(1);
  await expect(waiting.locator("tbody tr").first()).toContainText("Sigma Imports");
  await page.getByRole("link", { name: "Receive goods against PO-2627-00001" }).click();
  await expect(page.getByRole("heading", { name: "Receive goods against PO-2627-00001" })).toBeVisible();
  await expect(page.getByText("600", { exact: false }).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText("11,410.00").filter({ visible: true })).toHaveCount(0);

  // More than was ordered is refused, and nothing is kept.
  await arrived(page, 1).fill("12");
  await page.getByRole("button", { name: "Post goods received" }).click();
  await expect(visible(page, "form-error")).toHaveText("HL-1: 10 was ordered, so 12 cannot be received.");
  // Four helmets come first.
  await arrived(page, 1).fill("4");
  await page.getByRole("button", { name: "Post goods received" }).click();
  await expect(page.getByRole("heading", { name: "GR-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  await expect(page.getByRole("link", { name: "See the journal" })).toHaveCount(0);
  expect(await stock("HL-1")).toBe("4 worth 2400");
  expect(await journal("GR-2627-00001")).toEqual(["1300 2400 0", "2120 0 2400"]);

  // The rest: one press fills in what is left, and a draft waits for the order until it is posted.
  await page.goto("/purchases/receive");
  await page.getByRole("link", { name: "Receive goods against PO-2627-00001" }).click();
  await expect(visible(page, "left-1")).toHaveText("6");
  await page.getByRole("button", { name: "All of it arrived" }).click();
  await expect(arrived(page, 1)).toHaveValue("6");
  await expect(arrived(page, 2)).toHaveValue("20");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByRole("heading", { name: "Draft goods received note" })).toBeVisible();
  expect(await stock("HL-1")).toBe("4 worth 2400");
  await page.goto("/purchases/receive");
  await page.getByRole("link", { name: "Receive goods against PO-2627-00001" }).click();
  await expect(page.getByText("A goods received note for this order is already waiting as a draft.")).toBeVisible();
  await page.getByRole("link", { name: "Open the draft" }).click();
  await expect(arrived(page, 2)).toHaveValue("20");
  await page.getByRole("button", { name: "Post goods received" }).click();
  await expect(page.getByRole("heading", { name: "GR-2627-00002" })).toBeVisible();
  expect(await stock("HL-1")).toBe("10 worth 6000");
  expect(await stock("CH-2")).toBe("20 worth 5410");
  expect(await journal("GR-2627-00002")).toEqual(["1300 9010 0", "2120 0 9010"]);

  await page.goto("/purchases/receive");
  await expect(page.getByText("No order is waiting for goods.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Goods received notes" }).locator("tbody tr")).toHaveCount(2);
});

test("the owner sees what arrived, the report agrees with the books, and an order nothing came against is cancelled", async ({ page }) => {
  await signIn(page, owner);
  await page.goto(orderUrl);
  await expect(page.getByText("Everything ordered has arrived.")).toBeVisible();
  await expect(page.getByRole("link", { name: "GR-2627-00001" })).toBeVisible();
  await expect(page.getByRole("link", { name: "GR-2627-00002" })).toBeVisible();
  // Goods have come against it: it stays.
  await expect(page.getByRole("heading", { name: "Cancel this order" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Receive goods", exact: true })).toHaveCount(0);

  // What has arrived and is not billed, at cost, is what the account in the books holds.
  await page.goto("/reports");
  await expect(page.getByRole("list", { name: "Purchases" }).getByRole("link", { name: "Goods received, not yet billed" })).toHaveAttribute("href", "/purchases/grni");
  await page.goto("/purchases/grni");
  await expect(page.getByRole("table", { name: "Goods received, not yet billed" }).locator("tbody tr")).toHaveCount(3);
  await expect(visible(page, "grni-total")).toHaveText("11,410.00");
  await expect(visible(page, "grni-agrees")).toHaveText("The account Goods received not invoiced holds 11,410.00 in the books: the same.");

  // A second order, cancelled before anything arrives: it keeps its number and says why.
  await page.goto("/purchases/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Sigma Imports (S-001)" });
  await fillLine(page, 1, "HL-1", "5", "610");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: "PO-2627-00002" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(visible(page, "document-status")).toHaveText("Submitted");
  await page.getByLabel("Reason").fill("Supplier out of stock");
  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(visible(page, "document-status")).toHaveText("Cancelled");
  await expect(page.getByText("Supplier out of stock")).toBeVisible();
  await page.goto("/purchases/receive");
  await expect(page.getByText("No order is waiting for goods.")).toBeVisible();
  await page.goto("/purchases");
  const orders = page.getByRole("table", { name: "Purchase orders" });
  await expect(orders.locator("tbody tr")).toHaveCount(2);
  await expect(orders.locator("tbody tr").filter({ hasText: "PO-2627-00002" })).toContainText("Cancelled");
  expect(await stock("HL-1")).toBe("10 worth 6000");
});
