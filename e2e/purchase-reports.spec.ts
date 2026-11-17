import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 29 on screen: an owner bills goods from a company that is not on the Active Taxpayers
// List, and reads what is owed and what was withheld in the buying reports, each agreeing with
// the books; downloads one and prints one. What each report adds up, as at other days and for
// other suppliers, is tested against the database in src/modules/purchase-reports.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("buying-reports-owner", { canCreateCompany: true });
  keeper = await createUser("buying-reports-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const table = (page: Page, name: string) => shown(page.getByRole("table", { name }));
const row = (page: Page, name: string, text: string) => table(page, name).locator("tbody tr").filter({ hasText: text });

test("an owner reads what is owed to suppliers and what was withheld from them, and both agree with the books", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Buying Reports");
  const [{ id: tenantId }] = await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1500, ${owner.id}, ${owner.id})`;
  await sql`insert into public.suppliers (tenant_id, code, name, supplier_type, ntn, created_by, updated_by) values (${tenantId}, 'S-001', 'Karachi Motors (Pvt) Ltd', 'company', '7654321', ${owner.id}, ${owner.id})`;

  // The company withholds tax; a hundred helmets at 1,000 arrive and are billed: 10,000 is withheld, 90,000 is owed.
  await page.goto("/purchases/withholding");
  await page.getByRole("button", { name: "Start withholding tax" }).click();
  await expect(shown(page.getByTestId("withholding-state"))).toContainText("withholds tax from suppliers");
  await page.goto("/purchases/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Karachi Motors (Pvt) Ltd (S-001)" });
  await shown(page.getByLabel("Item code, line 1", { exact: true })).fill("HL-1");
  await shown(page.getByLabel("Quantity, line 1", { exact: true })).fill("100");
  await shown(page.getByLabel("Cost of one, line 1", { exact: true })).fill("1000");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(shown(page.getByTestId("document-status"))).toHaveText("Submitted");
  await page.getByRole("link", { name: "Receive goods", exact: true }).last().click();
  await page.getByRole("button", { name: "All of it arrived" }).click();
  await page.getByRole("button", { name: "Post goods received" }).click();
  await expect(shown(page.getByTestId("document-status"))).toHaveText("Posted");
  await page.goto("/purchases/bills/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Karachi Motors (Pvt) Ltd (S-001)" });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Bill all of it" }).click();
  await page.getByLabel("Supplier's invoice number").fill("KM-701");
  await page.getByRole("button", { name: "Post bill" }).click();
  await expect(page.getByRole("heading", { name: "PB-2627-00001" })).toBeVisible();

  // The Reports page lists the buying reports.
  await page.goto("/reports");
  const listed = page.getByRole("list", { name: "Purchases" });
  await expect(listed.getByRole("link")).toHaveText(["Aged payables", "Supplier statement", "Withholding register", "Statement of tax withheld (section 165)", "Goods received, not yet billed"]);

  // Aged payables: 90,000 owed, and the books say the same.
  await listed.getByRole("link", { name: "Aged payables" }).click();
  await expect(page.getByRole("heading", { name: "Aged payables" })).toBeVisible();
  await expect(row(page, "Aged payables", "Karachi Motors (Pvt) Ltd")).toContainText("90,000.00");
  await expect(row(page, "Aged payables", "Trade payables less advances to suppliers, in the books")).toContainText("90,000.00");
  await expect(row(page, "Aged payables", "Difference")).toContainText("0.00");

  // The supplier's statement.
  await page.goto("/purchase-reports/supplier-statement");
  await expect(page.getByText("Choose a supplier to see its statement.")).toBeVisible();
  await page.getByLabel("Supplier").selectOption({ label: "Karachi Motors (Pvt) Ltd (S-001)" });
  await page.getByRole("button", { name: "Show" }).click();
  await expect(row(page, "Supplier statement: Karachi Motors (Pvt) Ltd", "Bill PB-2627-00001")).toContainText("90,000.00");
  await expect(row(page, "Supplier statement: Karachi Motors (Pvt) Ltd", "Owed after")).toContainText("90,000.00");

  // The withholding register: what is still to be paid over is what the payable accounts hold.
  await page.goto("/purchase-reports/withholding-register");
  await expect(row(page, "Withholding register", "PB-2627-00001")).toContainText("10,000.00");
  await expect(row(page, "Withholding register", "Withheld and not yet paid over")).toContainText("10,000.00");
  await expect(row(page, "Withholding register", "Withholding payable accounts in the books")).toContainText("10,000.00");
  await expect(row(page, "Withholding register", "Difference")).toContainText("0.00");

  // The statement for section 165, in a file; and the register on the letterhead.
  const file = await page.request.get("/purchase-reports/export?report=section-165&format=csv");
  expect(file.status()).toBe(200);
  const csv = await file.text();
  expect(csv).toContain("Statement of tax withheld (section 165)");
  expect(csv).toContain("7654321");
  expect(csv).toContain("10000.00");
  await page.getByRole("link", { name: "Print" }).click();
  await expect(page.getByTestId("print-header")).toContainText("E2E Buying Reports");
  await expect(page.getByRole("heading", { name: "Withholding register" })).toBeVisible();
});

test("the warehouse has no way into the buying reports", async ({ page }) => {
  await signIn(page, keeper);
  for (const report of ["aged-payables", "supplier-statement", "withholding-register", "section-165"]) {
    await page.goto(`/purchase-reports/${report}`);
    await expect(page.getByText("Only an owner, an accountant or an auditor can see what is owed to suppliers.")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    expect((await page.request.get(`/purchase-reports/export?report=${report}&format=csv`)).status()).toBe(404);
  }
});
