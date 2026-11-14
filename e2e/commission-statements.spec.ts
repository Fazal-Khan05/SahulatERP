import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 39 on screen: a salesperson's commission statement shows the sale and what the customer's
// payment released; a salesperson is taken straight to their own and cannot open anyone else's;
// a manager sees their team's; the owner sees everyone's, prints one and downloads its PDF. The
// figures over a fuller history are tested against the database in src/modules/commission-statements.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let manager: TestUser;
let seller: TestUser;
let other: TestUser;
let accountant: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("statement-owner", { canCreateCompany: true });
  manager = await createUser("statement-manager", { canCreateCompany: false });
  seller = await createUser("statement-seller", { canCreateCompany: false });
  other = await createUser("statement-other", { canCreateCompany: false });
  accountant = await createUser("statement-accountant", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

// A page visited earlier stays in the document, hidden: only what is on screen is looked at.
const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
const lines = (page: Page) => shown(page.getByRole("table", { name: "Commission statement" })).locator("tbody tr");
const listed = (page: Page) => shown(page.getByRole("table", { name: "Commission statements" })).locator("tbody tr");

test("a salesperson's statement shows the sale and what the customer's payment released", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Commission Statement Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${manager.id}, ${manager.email}, 'sales_manager', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id}),
    (${tenantId}, ${other.id}, ${other.email}, 'salesperson', ${owner.id}),
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id})`;
  // A new company finishes setup with Commissions off; the owner switches it on.
  await sql`insert into public.modules_enabled (tenant_id, module, enabled, created_by, updated_by) values (${tenantId}, 'commissions', true, ${owner.id}, ${owner.id})
    on conflict (tenant_id, module) do update set enabled = true`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  const [customer] = await sql`insert into public.customers (tenant_id, name, code, credit_days, created_by, updated_by) values (${tenantId}, 'Registered Dealer', 'C-001', 30, ${owner.id}, ${owner.id}) returning id`;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  await seedStock(sql, { tenantId, itemId: item.id, warehouseId: warehouse.id, quantity: "100", value: "60000", userId: owner.id });
  // 2% for everyone; the manager earns 0.5% on what the seller sells.
  await sql`insert into public.commission_plans (tenant_id, name, kind, rate, effective_from, created_by, updated_by) values (${tenantId}, 'Standard plan', 'flat', 2, '2026-07-01', ${owner.id}, ${owner.id})`;
  await sql`insert into public.commission_plans (tenant_id, name, kind, rate, team_rate, user_id, effective_from, created_by, updated_by) values (${tenantId}, 'Area manager', 'flat', 2, 0.5, ${manager.id}, '2026-07-01', ${owner.id}, ${owner.id})`;
  await sql`insert into public.sales_hierarchy (tenant_id, user_id, manager_user_id, created_by, updated_by) values (${tenantId}, ${seller.id}, ${manager.id}, ${owner.id}, ${owner.id})`;
  await page.context().clearCookies();

  // The seller sells 10 helmets: 10,000, so 200 earned.
  await signIn(page, seller);
  await page.goto("/sales/new?kind=order");
  const picked = page.getByRole("combobox", { name: "Customer", exact: true });
  await picked.fill("C-001");
  await picked.press("Tab");
  await expect(picked).toHaveAttribute("data-picked", "true");
  const picker = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await picker.fill("HL-1");
  await picker.press("Tab");
  await expect(picker).toHaveAttribute("data-picked", "true");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: /^SO-2627-/ })).toBeVisible();
  await page.getByRole("button", { name: "Invoice and deliver now" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales invoice" })).toBeVisible();
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByRole("heading", { name: "SI-2627-00001" })).toBeVisible();
  await page.context().clearCookies();

  // The accountant takes 5,000 in cash: half the commission is released.
  await signIn(page, accountant);
  await page.goto("/receipts/new");
  await shown(page.getByLabel("Customer name or code")).fill("C-001");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByRole("list", { name: "Customers found" }).getByRole("link", { name: "Registered Dealer" }).click();
  await page.getByLabel("Amount received").fill("5000");
  await page.getByRole("button", { name: "Oldest invoices first" }).click();
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: "RC-2627-00001" })).toBeVisible();
  await page.context().clearCookies();

  // The seller has no team: the statements take them straight to their own.
  await signIn(page, seller);
  await page.goto("/commissions/earned");
  await shown(page.getByRole("link", { name: "My statement" })).click();
  await expect(page).toHaveURL(new RegExp(`/commissions/statements/${seller.id}\\?from=`));
  await expect(page.getByRole("heading", { name: "My commission statement" })).toBeVisible();
  await expect(lines(page)).toHaveCount(3);
  await expect(lines(page).nth(1)).toContainText("Earned on the sale");
  await expect(lines(page).nth(1)).toContainText("SI-2627-00001");
  await expect(lines(page).nth(1)).toContainText("Registered Dealer");
  await expect(lines(page).nth(2)).toContainText("Released: the customer paid (RC-2627-00001)");
  await expect(visible(page, "commission-statement-earned")).toHaveText("200.00");
  await expect(visible(page, "commission-statement-released")).toHaveText("100.00");
  await expect(visible(page, "commission-statement-closing")).toHaveText("100.00");
  await expect(visible(page, "commission-statement-summary")).toContainText("Waiting for customers to pay");
  // They cannot open anyone else's, nor approve.
  await expect(page.getByRole("link", { name: "Approve and pay" })).toHaveCount(0);
  expect((await page.request.get(`/commissions/statements/${other.id}`)).status()).toBe(404);
  expect((await page.request.get(`/print/commission-statement/${manager.id}/pdf`)).status()).toBe(404);
});

test("a manager sees their own statement and their team's", async ({ page }) => {
  await signIn(page, manager);
  await page.goto("/commissions/statements");
  await expect(listed(page)).toHaveCount(2);
  await expect(listed(page).filter({ hasText: seller.email })).toHaveCount(1);
  await expect(listed(page).filter({ hasText: other.email })).toHaveCount(0);
  await listed(page).filter({ hasText: manager.email }).getByRole("link").click();
  await expect(lines(page).nth(1)).toContainText("Earned at the 0.5% team rate");
  await expect(lines(page).nth(1)).toContainText(`sold by ${seller.email}`);
  await expect(visible(page, "commission-statement-earned")).toHaveText("50.00");
  await page.goto("/commissions/statements");
  await listed(page).filter({ hasText: seller.email }).getByRole("link").click();
  await expect(page.getByRole("heading", { name: `Commission statement: ${seller.email}` })).toBeVisible();
  await expect(visible(page, "commission-statement-earned")).toHaveText("200.00");
  expect((await page.request.get(`/commissions/statements/${other.id}`)).status()).toBe(404);
});

test("the owner sees everyone's, prints a statement and downloads its PDF", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/reports");
  await shown(page.getByRole("link", { name: "Commission statements" })).click();
  await expect(page).toHaveURL(/\/commissions\/statements$/);
  await expect(listed(page)).toHaveCount(2);
  await listed(page).filter({ hasText: seller.email }).getByRole("link").click();
  await expect(page.getByRole("link", { name: "Approve and pay" })).toBeVisible();
  const statement = page.url();
  const query = new URL(statement).search;

  await visible(page, "commission-statement-print").click();
  await expect(page.getByTestId("print-header")).toContainText("E2E Commission Statement Traders");
  await expect(page.getByRole("heading", { name: "Commission statement" })).toBeVisible();
  await expect(page.getByTestId("commission-statement-person")).toHaveText(seller.email);
  await expect(lines(page)).toHaveCount(3);

  const pdf = await page.request.get(`/print/commission-statement/${seller.id}/pdf${query}`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toMatch(/^attachment; filename="commission-[A-Za-z0-9-]+-to-[0-9-]+\.pdf"$/);
  expect(Buffer.from(await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
});
