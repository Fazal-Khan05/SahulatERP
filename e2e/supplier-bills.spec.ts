import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 25 on screen: an owner switches withholding on, bills goods already received from a
// company that is not on the Active Taxpayers List (10% is withheld), then bills goods at
// another price together with a delivery charge, and is stopped from billing the same invoice
// twice. What each of these posts is tested against the database in src/modules/supplier-bills.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("bill-owner", { canCreateCompany: true });
  keeper = await createUser("bill-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

// A page visited earlier stays in the document, hidden: only what is on screen is looked at.
const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);

/** An order for helmets from the supplier, submitted, and all of it received. */
async function orderAndReceive(page: Page, quantity: string, cost: string) {
  await page.goto("/purchases/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Karachi Motors (Pvt) Ltd (S-001)" });
  await shown(page.getByLabel("Item code, line 1", { exact: true })).fill("HL-1");
  await shown(page.getByLabel("Quantity, line 1", { exact: true })).fill(quantity);
  await shown(page.getByLabel("Cost of one, line 1", { exact: true })).fill(cost);
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(visible(page, "document-status")).toHaveText("Submitted");
  await page.getByRole("link", { name: "Receive goods", exact: true }).last().click();
  await page.getByRole("button", { name: "All of it arrived" }).click();
  await page.getByRole("button", { name: "Post goods received" }).click();
  await expect(visible(page, "document-status")).toHaveText("Posted");
}

/** Opens a new bill from the supplier: the company has one branch, so only the supplier is asked. */
async function newBill(page: Page) {
  await page.goto("/purchases/bills/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Karachi Motors (Pvt) Ltd (S-001)" });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "New bill from Karachi Motors (Pvt) Ltd (S-001)" })).toBeVisible();
}

test("an owner switches withholding on and bills goods from a company that is not on the list: 10% is withheld", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Bill Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1500, ${owner.id}, ${owner.id})`;
  await sql`insert into public.suppliers (tenant_id, code, name, supplier_type, created_by, updated_by) values (${tenantId}, 'S-001', 'Karachi Motors (Pvt) Ltd', 'company', ${owner.id}, ${owner.id})`;
  await orderAndReceive(page, "100", "1000");

  // Nothing is withheld until the company says it withholds.
  await page.goto("/purchases/bills");
  await expect(page.getByText("No supplier bills yet.")).toBeVisible();
  await page.getByRole("navigation", { name: "Purchases" }).getByRole("link", { name: "Withholding tax" }).click();
  await expect(visible(page, "withholding-state")).toContainText("does not withhold tax from suppliers");
  await page.getByRole("button", { name: "Start withholding tax" }).click();
  await expect(visible(page, "withholding-state")).toContainText("withholds tax from suppliers");

  // The goods received are listed with what the order said one costs; the income tax line for a company's goods is offered chosen.
  await newBill(page);
  await expect(visible(page, "to-bill-1")).toHaveText("100");
  await expect(shown(page.getByLabel("Price of one, line 1", { exact: true }))).toHaveValue("1000");
  await expect(page.getByLabel("Income tax (section 153)")).toHaveValue("income_tax.goods.company");
  await page.getByRole("button", { name: "Bill all of it" }).click();
  await expect(visible(page, "goods-amount-1")).toHaveText("100,000.00");
  await page.getByLabel("Supplier's invoice number").fill("KM-501");
  await page.getByRole("button", { name: "Save as draft" }).click();

  // The draft says what posting it will do, from the tax tables: 10% of 100,000 from a company that is not on the list.
  await expect(page.getByRole("heading", { name: "Draft bill from Karachi Motors (Pvt) Ltd" })).toBeVisible();
  await expect(page.getByText("Income tax withheld: Goods, from a company, 10% of 100,000.00")).toBeVisible();
  await expect(visible(page, "bill-payable")).toHaveText("90,000.00");
  expect(await journal("PB-2627-00001")).toEqual([]);
  await page.getByRole("button", { name: "Post bill" }).click();

  await expect(page.getByRole("heading", { name: "PB-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  await expect(visible(page, "bill-payable")).toHaveText("90,000.00");
  await expect(page.getByText("The supplier was not on the Active Taxpayers List as recorded that day.")).toBeVisible();
  expect(await journal("PB-2627-00001")).toEqual(["2120 100000 0", "2210 0 10000", "2110 0 90000"]);
  // Billed goods are no longer received and not billed.
  await page.goto("/purchases/grni");
  await expect(page.getByText("No goods are waiting for a supplier's bill.")).toBeVisible();
  await expect(visible(page, "grni-agrees")).toContainText("holds 0.00 in the books: the same.");
  await page.goto("/purchases/bills");
  const bills = page.getByRole("table", { name: "Supplier bills" });
  await expect(bills.locator("tbody tr")).toHaveCount(1);
  await expect(bills.locator("tbody tr").first()).toContainText("10,000.00");
});

test("a bill at another price with a delivery charge posts the difference on its own, and an invoice is not billed twice", async ({ page }) => {
  await signIn(page, owner);
  await orderAndReceive(page, "5", "1000");
  await newBill(page);
  await shown(page.getByLabel("Billed now, line 1", { exact: true })).fill("5");
  await shown(page.getByLabel("Price of one, line 1", { exact: true })).fill("1100");
  await shown(page.getByLabel("Charged to, line 1", { exact: true })).selectOption({ label: "5260 Freight and cartage outward" });
  await shown(page.getByLabel("What it is for, line 1", { exact: true })).fill("Delivery to the warehouse");
  await shown(page.getByLabel("Amount, line 1", { exact: true })).fill("500");
  await expect(visible(page, "bill-subtotal")).toHaveText("6,000.00");
  await page.getByLabel("Income tax (section 153)").selectOption({ label: "Nothing withheld" });
  await page.getByLabel("Supplier's invoice number").fill("KM-502");
  await page.getByRole("button", { name: "Post bill" }).click();
  await expect(page.getByRole("heading", { name: "PB-2627-00002" })).toBeVisible();
  await expect(visible(page, "bill-payable")).toHaveText("6,000.00");
  // Five helmets came in at 1,000 and are billed at 1,100: 500 is the difference in price.
  expect(await journal("PB-2627-00002")).toEqual(["2120 5000 0", "5120 500 0", "5260 500 0", "2110 0 6000"]);

  // The same invoice number from the same supplier again: kept as a draft, not posted.
  await newBill(page);
  await shown(page.getByLabel("Charged to, line 1", { exact: true })).selectOption({ label: "5260 Freight and cartage outward" });
  await shown(page.getByLabel("What it is for, line 1", { exact: true })).fill("Delivery again");
  await shown(page.getByLabel("Amount, line 1", { exact: true })).fill("500");
  await page.getByLabel("Income tax (section 153)").selectOption({ label: "Nothing withheld" });
  await page.getByLabel("Supplier's invoice number").fill("km-502");
  await page.getByRole("button", { name: "Post bill" }).click();
  await expect(page.getByRole("heading", { name: "Draft bill from Karachi Motors (Pvt) Ltd" })).toBeVisible();
  await expect(visible(page, "form-error")).toHaveText("Saved as a draft, but not posted. Post it again to see why.");
  await page.getByRole("button", { name: "Post bill" }).click();
  await expect(visible(page, "form-error")).toContainText("A bill with this supplier's invoice number has already been posted.");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page.getByRole("table", { name: "Supplier bills" }).locator("tbody tr")).toHaveCount(2);
});

test("the warehouse has no way into supplier bills", async ({ page }) => {
  await signIn(page, keeper);
  await page.goto("/purchases/bills");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see supplier bills.")).toBeVisible();
  await page.goto("/purchases/withholding");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see supplier bills.")).toBeVisible();
});
