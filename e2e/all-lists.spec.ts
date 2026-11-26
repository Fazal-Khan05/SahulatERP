import { expect, type Locator } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// The combined "All" lists on screen (batch A): Sales shows every kind of document together with
// a Type column and the search; Purchases the same for buying documents; the warehouse sees only
// the kinds it already reads. The lists' rules are tested in src/modules/document-lists.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("all-owner", { canCreateCompany: true });
  keeper = await createUser("all-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });

test("the owner sees every sales document together, with its type, and finds one", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E All Lists Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [warehouse] = await sql<{ id: string; branch_id: string }[]>`select id, branch_id from public.warehouses where tenant_id = ${tenantId}`;
  const [khan] = await sql`insert into public.customers (tenant_id, name, code, created_by, updated_by) values (${tenantId}, 'Khan Autos', 'C-001', ${owner.id}, ${owner.id}) returning id`;
  const [city] = await sql`insert into public.customers (tenant_id, name, code, created_by, updated_by) values (${tenantId}, 'City Bikes', 'C-002', ${owner.id}, ${owner.id}) returning id`;
  // Two drafts written as the app writes a draft: a quotation and an order.
  await sql`insert into public.sales_documents (tenant_id, kind, document_date, customer_id, warehouse_id, branch_id, currency, taxed, prices_include_tax, created_by, updated_by) values
    (${tenantId}, 'quotation', '2026-11-20', ${khan.id}, ${warehouse.id}, ${warehouse.branch_id}, 'PKR', false, false, ${owner.id}, ${owner.id}),
    (${tenantId}, 'order', '2026-11-25', ${city.id}, ${warehouse.id}, ${warehouse.branch_id}, 'PKR', false, false, ${owner.id}, ${owner.id})`;

  await page.goto("/sales");
  await shown(page.getByRole("navigation", { name: "Kind of document" })).getByRole("link", { name: "All" }).click();
  await expect(page).toHaveURL(/\/sales\?kind=all$/);
  const table = page.getByRole("table", { name: "All sales documents" });
  await expect(table.getByRole("columnheader", { name: "Type" })).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(3);
  // Newest first.
  await expect(table.getByRole("row").nth(1)).toContainText("Sales order");
  await expect(table.getByRole("row").nth(1)).toContainText("City Bikes");
  await expect(table.getByRole("row").nth(2)).toContainText("Quotation");
  await page.getByLabel("Find by number or customer").fill("khan");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page).toHaveURL(/kind=all&q=khan/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText("Khan Autos");
});

test("the owner sees every buying document together", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/purchases");
  await page.getByRole("navigation", { name: "Purchases" }).getByRole("link", { name: "All" }).click();
  await expect(page.getByRole("heading", { name: "All purchases" })).toBeVisible();
  await expect(page.getByText("No buying documents yet.")).toBeVisible();
});

test("the warehouse sees only the kinds it already reads", async ({ page }) => {
  await signIn(page, keeper);
  await page.goto("/sales?kind=all");
  // The warehouse reads submitted orders and delivery notes: not quotations, and not drafts.
  await expect(shown(page.getByRole("navigation", { name: "Kind of document" })).getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");
  await expect(shown(page.getByRole("navigation", { name: "Kind of document" })).getByRole("link", { name: "Quotations" })).toHaveCount(0);
  await expect(page.getByText("No sales documents yet.")).toBeVisible();
  // The order it cannot see in its own tab is not in the All list either.
  await page.goto("/sales?kind=order");
  await expect(page.getByText("No sales orders yet.")).toBeVisible();
  await page.goto("/purchases/all");
  await expect(page.getByRole("heading", { name: "All purchases" })).toBeVisible();
  await expect(page.getByText("Your role does not include")).toHaveCount(0);
});
