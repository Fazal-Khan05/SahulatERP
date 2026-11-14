import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 31 on screen: opening stock posted through the app, then the stock reports read on screen,
// printed and downloaded; the valuation agrees with the stock account in the books. The warehouse
// sees low stock and no costs. Each report's figures over a fuller history (transfers, sales,
// invoices, ageing, profit) are tested in src/modules/stock-reports/reports.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("stock-reports-owner", { canCreateCompany: true });
  keeper = await createUser("stock-reports-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const table = (page: Page, name: string) => shown(page.getByRole("table", { name }));
const row = (page: Page, name: string, text: string) => table(page, name).locator("tbody tr").filter({ hasText: text });

test("an owner values the stock, and it agrees with the books", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Stock Reports");
  const [{ id: tenantId }] = await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, reorder_level, created_by, updated_by) values
    (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, 20, ${owner.id}, ${owner.id}), (${tenantId}, 'CH-2', 'Chain', ${unit.id}, 400, 5, ${owner.id}, ${owner.id})`;

  // Opening stock, through the app: 10 helmets at 600 and 20 chains at 270.
  await page.goto("/stock/adjustments/new?kind=opening");
  await expect(page.getByRole("heading", { name: "Opening stock", exact: true })).toBeVisible();
  await shown(page.getByLabel("Item code, line 1", { exact: true })).fill("HL-1");
  await shown(page.getByLabel("Quantity, line 1", { exact: true })).fill("10");
  await shown(page.getByLabel("Cost of one, line 1", { exact: true })).fill("600");
  await shown(page.getByLabel("Item code, line 2", { exact: true })).fill("CH-2");
  await shown(page.getByLabel("Quantity, line 2", { exact: true })).fill("20");
  await shown(page.getByLabel("Cost of one, line 2", { exact: true })).fill("270");
  await page.getByRole("button", { name: "Post opening stock" }).click();
  await expect(page.getByRole("heading", { name: "SA-2627-00001" })).toBeVisible();

  // The Reports page lists the stock reports; the valuation agrees with the stock account.
  await page.goto("/reports");
  const listed = page.getByRole("list", { name: "Stock" });
  await expect(listed.getByRole("link")).toHaveText(["Stock on hand", "Stock valuation", "Stock movement", "Stock ageing", "Low stock", "Item profit"]);
  await listed.getByRole("link", { name: "Stock valuation" }).click();
  await expect(page.getByRole("heading", { name: "Stock valuation" })).toBeVisible();
  await expect(row(page, "Stock valuation", "HL-1")).toContainText("6,000.00");
  await expect(row(page, "Stock valuation", "CH-2")).toContainText("5,400.00");
  await expect(row(page, "Stock valuation", "Total")).toContainText("11,400.00");
  await expect(row(page, "Stock valuation", "Stock account in the books")).toContainText("11,400.00");
  await expect(row(page, "Stock valuation", "Difference")).toContainText("0.00");
  await expect(shown(page.getByTestId("report-note"))).toHaveCount(0);

  // The same figures in a file, and on the letterhead.
  const file = await page.request.get(`/stock-reports/export?report=valuation&format=csv&to=${await page.getByLabel("As at the end of").inputValue()}`);
  expect(file.status()).toBe(200);
  const csv = await file.text();
  expect(csv).toContain("Stock valuation");
  expect(csv).toContain("11400.00");
  await page.getByRole("link", { name: "Print" }).click();
  await expect(page.getByTestId("print-header")).toContainText("E2E Stock Reports");
  await expect(page.getByRole("heading", { name: "Stock valuation" })).toBeVisible();

  // Every move of one item in a period.
  await page.goto("/stock-reports/movement");
  await page.getByLabel("Item").selectOption({ label: "HL-1 Helmet" });
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("heading", { name: "Stock movement" })).toBeVisible();
  await expect(table(page, "Stock movement: HL-1 Helmet").locator("tbody tr").filter({ hasText: "SA-2627-00001" })).toContainText("6,000.00");

  // Low stock: 10 helmets against a reorder level of 20; chains are well above theirs.
  await page.goto("/stock-reports/low-stock");
  await expect(table(page, "Low stock").locator("tbody tr")).toHaveCount(1);
  await expect(row(page, "Low stock", "HL-1")).toContainText("20 pc");
});

test("the warehouse sees low stock but no costs", async ({ page }) => {
  await signIn(page, keeper);
  await page.goto("/stock-reports/low-stock");
  await expect(row(page, "Low stock", "HL-1")).toContainText("10");
  for (const report of ["valuation", "movement", "ageing", "item-profit"]) {
    await page.goto(`/stock-reports/${report}`);
    await expect(page.getByText("Only an owner, an accountant or an auditor can see what stock cost.")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    expect((await page.request.get(`/stock-reports/export?report=${report}&format=csv`)).status()).toBe(404);
  }
});
