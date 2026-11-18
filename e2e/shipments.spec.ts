import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 28 on screen: an owner opens a shipment, puts the goods it brought on it, bills the
// freight and the duty to Goods in transit, puts both charges on the shipment and closes it:
// the charges are added to what the goods cost. What closing posts, and what happens to goods
// already sold and to a charge that comes late, is tested against the database in
// src/modules/shipments.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("shipment-owner", { canCreateCompany: true });
  keeper = await createUser("shipment-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

// A page visited earlier stays in the document, hidden: only what is on screen is looked at.
const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
/** The lines of the journals that spread import charges. */
const landedJournal = async () =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.source_type = 'landed_cost' order by j.created_at, l.line_no`
  ).map((row) => row.line);

test("a shipment's freight and duty are added to what its goods cost when it is closed", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Shipment Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 2500, ${owner.id}, ${owner.id})`;
  await sql`insert into public.suppliers (tenant_id, code, name, supplier_type, created_by, updated_by) values
    (${tenantId}, 'S-001', 'Ningbo Exports', 'company', ${owner.id}, ${owner.id}), (${tenantId}, 'S-002', 'Karachi Clearing', 'aop', ${owner.id}, ${owner.id})`;

  // Ten helmets at 1,000 arrive from the supplier abroad.
  await page.goto("/purchases/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Ningbo Exports (S-001)" });
  await shown(page.getByLabel("Item code, line 1", { exact: true })).fill("HL-1");
  await shown(page.getByLabel("Quantity, line 1", { exact: true })).fill("10");
  await shown(page.getByLabel("Cost of one, line 1", { exact: true })).fill("1000");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(visible(page, "document-status")).toHaveText("Submitted");
  await page.getByRole("link", { name: "Receive goods", exact: true }).last().click();
  await page.getByRole("button", { name: "All of it arrived" }).click();
  await page.getByRole("button", { name: "Post goods received" }).click();
  await expect(visible(page, "document-status")).toHaveText("Posted");

  // The shipment is opened and the goods are put on it.
  await page.goto("/purchases/shipments");
  await expect(page.getByText("No shipments yet.")).toBeVisible();
  await page.getByRole("link", { name: "New shipment" }).click();
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Ningbo Exports (S-001)" });
  await page.getByLabel("Container number").fill("MSKU1234567");
  await page.getByLabel("Port", { exact: true }).fill("Karachi");
  await page.getByRole("button", { name: "Open shipment" }).click();
  await expect(page.getByRole("heading", { name: "SH-2627-00001" })).toBeVisible();
  const shipmentUrl = new URL(page.url()).pathname;
  await expect(visible(page, "document-status")).toHaveText("Open");
  await page.getByLabel("Goods received note").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Put these goods on the shipment" }).click();
  const goods = page.getByRole("table", { name: "Goods on the shipment" }).locator("tbody tr");
  await expect(goods).toHaveCount(1);
  await expect(visible(page, "landed-1")).toHaveText("0.00");

  // The clearing agent bills the freight and the duty, each charged to Goods in transit.
  await page.goto("/purchases/bills/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Karachi Clearing (S-002)" });
  await page.getByRole("button", { name: "Continue" }).click();
  await shown(page.getByLabel("Charged to, line 1", { exact: true })).selectOption({ label: "1310 Goods in transit" });
  await shown(page.getByLabel("What it is for, line 1", { exact: true })).fill("Freight");
  await shown(page.getByLabel("Amount, line 1", { exact: true })).fill("2000");
  await page.getByRole("button", { name: "Add an expense line" }).click();
  await shown(page.getByLabel("Charged to, line 2", { exact: true })).selectOption({ label: "1310 Goods in transit" });
  await shown(page.getByLabel("What it is for, line 2", { exact: true })).fill("Customs duty");
  await shown(page.getByLabel("Amount, line 2", { exact: true })).fill("3000");
  await page.getByLabel("Supplier's invoice number").fill("KC-9");
  await page.getByRole("button", { name: "Post bill" }).click();
  await expect(page.getByRole("heading", { name: "PB-2627-00001" })).toBeVisible();
  await page.goto("/purchases/shipments");
  await expect(visible(page, "transit-ledger")).toHaveText("5,000.00");
  await expect(visible(page, "transit-unassigned")).toHaveText("5,000.00");

  // Both charges go on the shipment: the freight by value, the duty by quantity.
  await page.goto(shipmentUrl);
  await page.getByLabel("Bill line").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Put the charge on the shipment" }).click();
  const charges = page.getByRole("table", { name: "Charges on the shipment" }).locator("tbody tr");
  await expect(charges).toHaveCount(1);
  await page.getByLabel("Bill line").selectOption({ index: 1 });
  await page.getByLabel("Spread over the goods").selectOption({ label: "By quantity" });
  await page.getByRole("button", { name: "Put the charge on the shipment" }).click();
  await expect(charges).toHaveCount(2);
  await expect(page.getByText("No bill line charged to Goods in transit is waiting")).toBeVisible();
  // Shown before it is done.
  await expect(visible(page, "spread-to-stock")).toHaveText("5,000.00");
  await expect(visible(page, "spread-to-cogs")).toHaveText("0.00");
  await expect(visible(page, "spread-total")).toHaveText("5,000.00");

  // Closing adds the 5,000 to the ten helmets: 1,500 each.
  await page.getByRole("button", { name: "Close shipment and spread charges" }).click();
  await expect(visible(page, "document-status")).toHaveText("Closed");
  await expect(visible(page, "landed-1")).toHaveText("5,000.00");
  await expect(visible(page, "landed-each-1")).toHaveText("1,500.00");
  await expect(page.getByRole("table", { name: "Charges spread" }).locator("tbody tr")).toHaveCount(1);
  expect(await landedJournal()).toEqual(["1300 5000 0", "1310 0 5000"]);
  const [held] = await sql<{ quantity: string; value: string }[]>`select trim_scale(quantity)::text as quantity, trim_scale(value)::text as value from public.stock_balances where tenant_id = ${tenantId}`;
  expect(held).toEqual({ quantity: "10", value: "15000" });
  await page.goto("/purchases/shipments");
  await expect(visible(page, "transit-ledger")).toHaveText("0.00");
  await expect(page.getByRole("table", { name: "Shipments" }).locator("tbody tr").first()).toContainText("Closed");
});

test("the warehouse has no way into shipments", async ({ page }) => {
  await signIn(page, keeper);
  await page.goto("/purchases/shipments");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see shipments.")).toBeVisible();
});
