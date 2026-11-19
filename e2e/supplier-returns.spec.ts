import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 27 on screen: an owner sends back goods that have not been billed yet, which come off
// what is waiting for a bill; bills the rest; and sends back some of the billed goods, which
// is a debit note that brings down what is owed on the bill. What each of these posts is
// tested against the database in src/modules/supplier-returns.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("return-owner", { canCreateCompany: true });
  keeper = await createUser("return-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

// A page visited earlier stays in the document, hidden: only what is on screen is looked at.
const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
/** The lines of the journal a posted document names. */
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);
/** The balance of a locked account as a liability (credit less debit). */
const balance = async (control: string) =>
  (
    await sql<{ v: string }[]>`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
      where l.tenant_id = ${tenantId} and a.control_type = ${control}`
  )[0].v;

test("goods not yet billed go back off what is waiting for a bill; billed goods go back as a debit note against their bill", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Return Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1500, ${owner.id}, ${owner.id})`;
  await sql`insert into public.suppliers (tenant_id, code, name, supplier_type, created_by, updated_by) values (${tenantId}, 'S-001', 'Lahore Parts', 'aop', ${owner.id}, ${owner.id})`;

  // Ten helmets at 600 are ordered and arrive: 6,000 is waiting for a bill.
  await page.goto("/purchases/returns");
  await expect(page.getByText("No goods have been sent back yet.")).toBeVisible();
  await page.goto("/purchases/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Lahore Parts (S-001)" });
  await shown(page.getByLabel("Item code, line 1", { exact: true })).fill("HL-1");
  await shown(page.getByLabel("Quantity, line 1", { exact: true })).fill("10");
  await shown(page.getByLabel("Cost of one, line 1", { exact: true })).fill("600");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(visible(page, "document-status")).toHaveText("Submitted");
  await page.getByRole("link", { name: "Receive goods", exact: true }).last().click();
  await page.getByRole("button", { name: "All of it arrived" }).click();
  await page.getByRole("button", { name: "Post goods received" }).click();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  expect(await balance("grni")).toBe("6000.00");

  // Four are cracked and go back before any bill has come, straight from the goods received note.
  await page.getByRole("link", { name: "Send goods from this note back to the supplier" }).click();
  await expect(page.getByRole("heading", { name: "Goods going back to Lahore Parts" })).toBeVisible();
  const rows = page.getByRole("table", { name: "Goods that can go back" }).locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Not yet billed");
  await expect(visible(page, "can-go-back-1")).toHaveText("10");
  await shown(page.getByLabel("Going back, row 1", { exact: true })).fill("11");
  await page.getByLabel("Reason").fill("Cracked shells");
  await page.getByRole("button", { name: "Post return" }).click();
  await expect(visible(page, "form-error")).toHaveText("HL-1 not yet billed: only 10 can go back, not 11.");
  await shown(page.getByLabel("Going back, row 1", { exact: true })).fill("4");
  await expect(visible(page, "return-not-billed")).toHaveText("2,400.00");
  await page.getByRole("button", { name: "Post return" }).click();
  await expect(page.getByRole("heading", { name: "DB-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  await expect(visible(page, "return-not-billed")).toHaveText("2,400.00");
  await expect(visible(page, "return-credit")).toHaveText("0.00");
  expect(await journal("DB-2627-00001")).toEqual(["2120 2400 0", "1300 0 2400"]);
  expect(await balance("grni")).toBe("3600.00");

  // The six that stayed are billed: only six are offered, and 3,600 is owed.
  await page.goto("/purchases/bills/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Lahore Parts (S-001)" });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Bill all of it" }).click();
  await page.getByLabel("Supplier's invoice number").fill("LP-301");
  await page.getByRole("button", { name: "Post bill" }).click();
  await expect(page.getByRole("heading", { name: "PB-2627-00001" })).toBeVisible();
  await expect(visible(page, "bill-payable")).toHaveText("3,600.00");
  expect(await balance("grni")).toBe("0.00");

  // Two of the billed helmets go back: a debit note of 1,200, which comes off the bill.
  await page.goto("/purchases/returns/new");
  await page.getByRole("link", { name: "GR-2627-00001" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("On PB-2627-00001");
  await expect(visible(page, "can-go-back-1")).toHaveText("6");
  await shown(page.getByLabel("Going back, row 1", { exact: true })).fill("2");
  await page.getByLabel("Reason").fill("Wrong size");
  await page.getByLabel("Supplier's credit note number").fill("CN-44");
  await expect(visible(page, "return-credit")).toHaveText("1,200.00");
  await page.getByRole("button", { name: "Post return" }).click();
  await expect(page.getByRole("heading", { name: "DB-2627-00002" })).toBeVisible();
  await expect(visible(page, "return-credit")).toHaveText("1,200.00");
  await expect(visible(page, "return-credit-left")).toHaveText("0.00");
  await expect(page.getByRole("table", { name: "Bills the credit was set against" }).locator("tbody tr").first()).toContainText("PB-2627-00001");
  expect(await journal("DB-2627-00002")).toEqual(["2110 1200 0", "1300 0 1200"]);
  expect(await balance("ap")).toBe("2400.00");

  // What is left to pay on the bill is 2,400, and the list shows both returns.
  await page.goto("/purchases/payments/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Lahore Parts (S-001)" });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(visible(page, "owed-1")).toHaveText("2,400.00");
  await page.goto("/purchases/returns");
  const list = page.getByRole("table", { name: "Supplier returns" });
  await expect(list.locator("tbody tr")).toHaveCount(2);
  await expect(list.locator("tbody tr").filter({ hasText: "DB-2627-00002" })).toContainText("1,200.00");
});

test("the warehouse has no way into supplier returns", async ({ page }) => {
  await signIn(page, keeper);
  await page.goto("/purchases/returns");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see supplier returns.")).toBeVisible();
  await page.goto("/purchases/returns/new");
  await expect(page.getByText("Only an owner or an accountant can send goods back to a supplier.")).toBeVisible();
});
