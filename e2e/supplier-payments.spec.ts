import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 26 on screen: an owner sends money ahead to a supplier, bills the goods when they come,
// sets the advance against the bill and pays the rest; records the challan for the tax that was
// withheld; and takes back a payment entered by mistake. What each of these posts is tested
// against the database in src/modules/supplier-payments.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;
let tenantId: string;
let advanceUrl: string;
let restUrl: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("payment-owner", { canCreateCompany: true });
  keeper = await createUser("payment-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

// A page visited earlier stays in the document, hidden: only what is on screen is looked at.
const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
/** The lines of the journal a posted document names, or of the journals a source wrote. */
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);

/** Opens a new payment to the supplier: the company has one branch, so only the supplier is asked. */
async function newPayment(page: Page) {
  await page.goto("/purchases/payments/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Karachi Motors (Pvt) Ltd (S-001)" });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "New payment to Karachi Motors (Pvt) Ltd (S-001)" })).toBeVisible();
}

test("money sent ahead is an advance; set against the bill, with the rest paid, it nets to nothing owed", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Payment Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1500, ${owner.id}, ${owner.id})`;
  await sql`insert into public.suppliers (tenant_id, code, name, supplier_type, created_by, updated_by) values (${tenantId}, 'S-001', 'Karachi Motors (Pvt) Ltd', 'company', ${owner.id}, ${owner.id})`;
  await sql`insert into public.currencies (tenant_id, code, name, is_base, created_by) values (${tenantId}, 'USD', 'US Dollar', false, ${owner.id})`;

  // 50,000 sent ahead, USD 178.57: nothing is billed yet, so all of it is an advance.
  await page.goto("/purchases/payments");
  await expect(page.getByText("No supplier payments yet.")).toBeVisible();
  await newPayment(page);
  await expect(page.getByText("The whole payment will be an advance.")).toBeVisible();
  await page.getByLabel("Amount paid (rupees)").fill("50000");
  await page.getByLabel("Paid abroad in").selectOption("USD");
  await page.getByLabel("Amount in that currency").fill("178.57");
  await expect(visible(page, "payment-advance")).toHaveText("50,000.00");
  await page.getByRole("button", { name: "Post payment" }).click();
  await expect(page.getByRole("heading", { name: "PV-2627-00001" })).toBeVisible();
  advanceUrl = new URL(page.url()).pathname;
  await expect(visible(page, "document-status")).toHaveText("Posted");
  await expect(visible(page, "payment-amount")).toContainText("USD 178.57");
  await expect(visible(page, "payment-advance-left")).toHaveText("50,000.00");
  expect(await journal("PV-2627-00001")).toEqual(["1210 50000 0", "1111 0 50000"]);

  // The goods come and are billed: 1,00,000, of which 10% is withheld and 90,000 is owed.
  await page.goto("/purchases/withholding");
  await page.getByRole("button", { name: "Start withholding tax" }).click();
  await expect(visible(page, "withholding-state")).toContainText("withholds tax from suppliers");
  await page.goto("/purchases/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Karachi Motors (Pvt) Ltd (S-001)" });
  await shown(page.getByLabel("Item code, line 1", { exact: true })).fill("HL-1");
  await shown(page.getByLabel("Quantity, line 1", { exact: true })).fill("100");
  await shown(page.getByLabel("Cost of one, line 1", { exact: true })).fill("1000");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(visible(page, "document-status")).toHaveText("Submitted");
  await page.getByRole("link", { name: "Receive goods", exact: true }).last().click();
  await page.getByRole("button", { name: "All of it arrived" }).click();
  await page.getByRole("button", { name: "Post goods received" }).click();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  await page.goto("/purchases/bills/new");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Karachi Motors (Pvt) Ltd (S-001)" });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Bill all of it" }).click();
  await page.getByLabel("Supplier's invoice number").fill("KM-701");
  await page.getByRole("button", { name: "Post bill" }).click();
  await expect(page.getByRole("heading", { name: "PB-2627-00001" })).toBeVisible();
  await expect(visible(page, "bill-payable")).toHaveText("90,000.00");

  // The advance is set against the bill.
  await page.goto(advanceUrl);
  await expect(page.getByRole("heading", { name: "Set the advance against bills" })).toBeVisible();
  await expect(visible(page, "owed-1")).toHaveText("90,000.00");
  await shown(page.getByLabel("Paid now, bill 1", { exact: true })).fill("50000");
  await page.getByRole("button", { name: "Set the advance against these bills" }).click();
  await expect(page.getByText("from the advance, on")).toBeVisible();
  await expect(visible(page, "payment-advance-left")).toHaveText("0.00");

  // The rest is paid in money: one press fills in what is still owed.
  await newPayment(page);
  await expect(visible(page, "owed-1")).toHaveText("40,000.00");
  await page.getByRole("button", { name: "Pay all that is owed" }).click();
  await expect(page.getByLabel("Amount paid (rupees)")).toHaveValue("40000.00");
  await expect(visible(page, "payment-settled")).toHaveText("40,000.00");
  await page.getByLabel("Cheque number or bank reference").fill("CHQ 778899");
  await page.getByRole("button", { name: "Post payment" }).click();
  await expect(page.getByRole("heading", { name: "PV-2627-00002" })).toBeVisible();
  restUrl = new URL(page.url()).pathname;
  expect(await journal("PV-2627-00002")).toEqual(["2110 40000 0", "1111 0 40000"]);
  // Nothing is owed to the supplier, and no advance is left with it.
  const [{ owed }] = await sql<{ owed: string }[]>`
    select coalesce(sum(l.credit - l.debit), 0)::numeric(20,2)::text as owed from public.journal_lines l join public.accounts a on a.id = l.account_id
    where l.tenant_id = ${tenantId} and a.control_type in ('ap', 'supplier_advances')`;
  expect(owed).toBe("0.00");
  await newPayment(page);
  await expect(page.getByText("The whole payment will be an advance.")).toBeVisible();
});

test("the tax withheld is paid over under a challan, and a payment entered by mistake is taken back", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/purchases/withholding");
  await expect(visible(page, "withheld-unpaid")).toHaveText("10,000.00");
  await page.getByLabel("Paid by this challan, row 1").check();
  await page.getByLabel("Which tax").selectOption({ label: "Income tax on payments (section 153)" });
  await page.getByLabel("Challan (CPR) number").fill("IT-20261115-0001");
  await page.getByRole("button", { name: "Record the challan" }).click();
  await expect(page.getByText("Nothing withheld is waiting to be paid over.")).toBeVisible();
  const challans = page.getByRole("table", { name: "Challans" });
  await expect(challans.locator("tbody tr")).toHaveCount(1);
  await expect(challans.locator("tbody tr").first()).toContainText("IT-20261115-0001");
  expect(await journal("WC-2627-00001")).toEqual(["2210 10000 0", "1111 0 10000"]);

  // The second payment was a mistake: cancelled with a reason, and the bill is owed again.
  await page.goto(restUrl);
  await page.getByRole("button", { name: "Cancel payment" }).click();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  await page.getByLabel("Reason").fill("Entered twice");
  await page.getByRole("button", { name: "Cancel payment" }).click();
  await expect(visible(page, "document-status")).toHaveText("Cancelled");
  await expect(page.getByText("Entered twice. Everything it posted was reversed.")).toBeVisible();
  await newPayment(page);
  await expect(visible(page, "owed-1")).toHaveText("40,000.00");
  await page.goto("/purchases/payments");
  const payments = page.getByRole("table", { name: "Supplier payments" });
  await expect(payments.locator("tbody tr")).toHaveCount(2);
  await expect(payments.locator("tbody tr").filter({ hasText: "PV-2627-00002" })).toContainText("Cancelled");
});

test("the warehouse has no way into supplier payments", async ({ page }) => {
  await signIn(page, keeper);
  await page.goto("/purchases/payments");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see supplier payments.")).toBeVisible();
});
