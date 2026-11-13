import { expect, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 18 on screen: a quotation and a sales order are typed with the keyboard, saved, submitted
// with their numbers, and an order over the customer's credit limit waits for the owner, who
// approves it with a reason. The rules themselves are tested in src/modules/sales.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let seller: TestUser;
let auditor: TestUser;
let tenantId: string;
let heldOrder: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("sales-owner", { canCreateCompany: true });
  seller = await createUser("sales-seller", { canCreateCompany: false });
  auditor = await createUser("sales-auditor", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

/** Types into a picker and leaves it with Tab: a code or name that names one thing is taken. */
async function pick(page: Page, label: string, typed: string) {
  const box = page.getByRole("combobox", { name: label, exact: true }).filter({ visible: true });
  await box.fill(typed);
  await box.press("Tab");
}

/** Fills one row of the lines grid, keyboard only; rows are numbered from 1. */
async function fillLine(page: Page, row: number, item: string, name: string, quantity: string, price?: string) {
  await pick(page, `Item, line ${row}`, item);
  await expect(visible(page, `line-name-${row}`)).toHaveText(name);
  await page.getByLabel(`Quantity, line ${row}`, { exact: true }).filter({ visible: true }).fill(quantity);
  if (price !== undefined) await page.getByLabel(`Price, line ${row}`, { exact: true }).filter({ visible: true }).fill(price);
}

test("an owner types a sales order with the keyboard and saves it as a draft", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Sales Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id}),
    (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values
    (${tenantId}, 'BP-100', 'Brake pad', ${unit.id}, 110, ${owner.id}, ${owner.id}),
    (${tenantId}, 'CH-200', 'Chain', ${unit.id}, null, ${owner.id}, ${owner.id})`;
  await sql`insert into public.customers (tenant_id, name, code, credit_limit, created_by, updated_by) values
    (${tenantId}, 'Khan Autos', 'C-001', 50000, ${owner.id}, ${owner.id}),
    (${tenantId}, 'City Bikes', 'C-002', null, ${owner.id}, ${owner.id})`;

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Sales", exact: true }).click();
  await expect(page.getByText("No sales orders yet.")).toBeVisible();
  await page.getByRole("link", { name: "New sales order" }).click();
  await expect(page).toHaveURL(/\/sales\/new\?kind=order$/);

  // The customer is found by part of its name; its credit limit shows at once.
  await pick(page, "Customer", "khan");
  await expect(page.getByRole("combobox", { name: "Customer", exact: true })).toHaveValue("Khan Autos");
  await expect(visible(page, "credit-note")).toHaveText("Credit limit 50,000.00. Owes 0.00. Room for 50,000.00 more.");

  // An item's code and a quantity are enough: the price comes from the price lists.
  await fillLine(page, 1, "bp-100", "Brake pad", "10");
  await expect(page.getByLabel("Price, line 1", { exact: true })).toHaveValue("110");
  await expect(visible(page, "line-amount-1")).toHaveText("1,100.00");
  // An item with no price anywhere asks for one; a typed price is kept as typed.
  await fillLine(page, 2, "chain", "Chain", "2");
  await expect(page.getByLabel("Price, line 2", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(visible(page, "form-error")).toHaveText("Line 2: CH-200 has no price for this customer. Enter the price.");
  await page.getByLabel("Price, line 2", { exact: true }).fill("450");
  await page.getByLabel("Discount percent, line 1", { exact: true }).fill("10");
  await expect(visible(page, "form-total")).toHaveText("1,890.00");

  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page).toHaveURL(/\/sales\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Draft sales order" })).toBeVisible();
  await expect(visible(page, "document-total")).toHaveText("1,890.00");
  const [stored] = await sql`select d.status, d.number, d.total::text, (select count(*)::int from public.sales_lines l where l.document_id = d.id) as lines from public.sales_documents d where d.tenant_id = ${tenantId}`;
  expect(stored).toEqual({ status: "draft", number: null, total: "1890.0000", lines: 2 });

  // The draft opens with what was saved, and submits under the limit with its number.
  await expect(page.getByLabel("Quantity, line 1", { exact: true }).filter({ visible: true })).toHaveValue("10");
  await expect(page.getByLabel("Price, line 2", { exact: true }).filter({ visible: true })).toHaveValue("450");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: "SO-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Submitted");
  await expect(page.getByRole("button", { name: "Save as draft" })).toHaveCount(0);
});

test("a salesperson's order over the credit limit waits for the owner", async ({ page }) => {
  await signIn(page, seller);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Orders", exact: true }).click();
  // A salesperson sees their own documents, not the owner's.
  await expect(page.getByText("No sales orders yet.")).toBeVisible();
  await page.getByRole("link", { name: "New sales order" }).click();
  await pick(page, "Customer", "C-001");
  await expect(visible(page, "credit-note")).toHaveText("Credit limit 50,000.00. Owes 0.00, 1,890.00 in other orders. Room for 48,110.00 more.");
  await fillLine(page, 1, "BP-100", "Brake pad", "500");
  await expect(visible(page, "form-total")).toHaveText("55,000.00");
  await page.getByRole("button", { name: "Submit order" }).click();

  await expect(page).toHaveURL(/\/sales\/[0-9a-f-]{36}$/);
  heldOrder = page.url().split("/").pop()!;
  await expect(visible(page, "document-status")).toHaveText("Waiting for approval");
  await expect(visible(page, "hold-reason")).toHaveText("This order of 55,000.00 takes the customer 6,890.00 over the credit limit of 50,000.00: the customer owes 0.00 and has 1,890.00 in other orders.");
  // The salesperson cannot approve it; they can only take it back.
  await expect(page.getByRole("button", { name: "Approve and submit order" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Take back to draft" })).toBeVisible();
  const [held] = await sql`select status, number, held_by from public.sales_documents where id = ${heldOrder}`;
  expect(held).toEqual({ status: "on_hold", number: null, held_by: seller.id });
});

test("the owner finds the order in the inbox and approves it with a reason", async ({ page }) => {
  await signIn(page, owner);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Needs attention" }).click();
  await page.getByRole("link", { name: "Approve or send back: sales order for Khan Autos" }).click();
  await expect(page).toHaveURL(new RegExp(`/sales/${heldOrder}$`));

  // Without a reason it stays where it is.
  await page.getByRole("button", { name: "Approve and submit order" }).click();
  await expect(visible(page, "form-error")).toContainText("As the owner you can approve it: say why this order is approved over the credit limit, in a few words.");
  expect((await sql`select status from public.sales_documents where id = ${heldOrder}`)[0].status).toBe("on_hold");

  await page.getByLabel("Reason for approving it over the credit limit").fill("Cheque for 20,000 arrives on Monday");
  await page.getByRole("button", { name: "Approve and submit order" }).click();
  await expect(page.getByRole("heading", { name: "SO-2627-00002" })).toBeVisible();
  await expect(visible(page, "override-reason")).toHaveText("Approved by the owner: Cheque for 20,000 arrives on Monday");

  // The override is in the audit log: who, when, the limit, what was owed, and why.
  const [logged] = await sql`select actor_user_id, actor_role, before, after from public.audit_log where entity_id = ${heldOrder} and action = 'sales_order.credit_override'`;
  expect(logged).toMatchObject({
    actor_user_id: owner.id,
    actor_role: "owner",
    before: { creditLimit: "50000.0000", owed: "0", otherOrders: "1890.0000" },
    after: { orderTotal: "55000.0000", over: "6890.0000", reason: "Cheque for 20,000 arrives on Monday" },
  });
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Needs attention" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByText("Nothing needs your attention.").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Approve or send back/ }).filter({ visible: true })).toHaveCount(0);
});

test("a quotation is submitted, turned into an order, and the order cancelled", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/sales?kind=quotation");
  await page.getByRole("link", { name: "New quotation" }).click();
  await pick(page, "Customer", "City Bikes");
  await fillLine(page, 1, "BP-100", "Brake pad", "20", "105");
  await page.getByRole("button", { name: "Submit quotation" }).click();
  await expect(page.getByRole("heading", { name: "QT-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-total")).toHaveText("2,100.00");
  await expect(page.getByText("List 110.00")).toBeVisible();

  await page.getByRole("button", { name: "Make a sales order" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales order" })).toBeVisible();
  await expect(page.getByRole("link", { name: "quotation QT-2627-00001" })).toBeVisible();
  // The quoted price is kept, not replaced by the list price.
  await expect(page.getByLabel("Price, line 1", { exact: true }).filter({ visible: true })).toHaveValue("105");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: "SO-2627-00003" })).toBeVisible();

  await page.getByLabel("Why it is cancelled").fill("Customer changed their mind");
  await page.getByRole("button", { name: "Cancel sales order" }).click();
  await expect(visible(page, "document-status")).toHaveText("Cancelled");
  await expect(page.getByRole("button", { name: "Cancel sales order" })).toHaveCount(0);

  // The list finds it by its number and shows where it stands.
  await page.goto("/sales?kind=order");
  await page.getByLabel("Find by number or customer").fill("00003");
  await page.getByRole("button", { name: "Find" }).click();
  const rows = page.getByRole("table", { name: "Sales orders" }).locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("SO-2627-00003");
  await expect(rows.first()).toContainText("Cancelled");
});

test("an auditor reads sales documents and cannot write them", async ({ page }) => {
  await signIn(page, auditor);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Sales", exact: true }).click();
  await expect(page.getByRole("table", { name: "Sales orders" }).locator("tbody tr")).toHaveCount(3);
  await expect(page.getByRole("link", { name: "New sales order" })).toHaveCount(0);
  await page.getByRole("link", { name: "SO-2627-00002" }).click();
  await expect(visible(page, "override-reason")).toBeVisible();
  await expect(page.getByRole("button", { name: /Cancel/ })).toHaveCount(0);
  await page.goto("/sales/new?kind=order");
  await expect(page.getByText("Your role cannot write sales documents.")).toBeVisible();
});
