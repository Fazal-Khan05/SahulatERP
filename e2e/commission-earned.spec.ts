import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 38 on screen: a salesperson's invoice earns commission on the company's plan; nothing
// can be paid until the customer pays; the accountant then approves and pays it; goods coming
// back afterwards leave the salesperson owing some of it back, which comes out of the next
// payment; and the salesperson sees their own commission and nobody else's. What each of these
// posts is tested against the database in src/modules/commission-ledger.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let seller: TestUser;
let other: TestUser;
let accountant: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("earned-owner", { canCreateCompany: true });
  seller = await createUser("earned-seller", { canCreateCompany: false });
  other = await createUser("earned-other", { canCreateCompany: false });
  accountant = await createUser("earned-accountant", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

// A page visited earlier stays in the document, hidden: only what is on screen is looked at.
const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
const rail = (page: Page) => page.getByRole("navigation", { name: "Main" });
/** What the books say an account stands at, debit less credit. */
const balance = async (code: string) => {
  const [row] = await sql`
    select coalesce(sum(l.debit - l.credit), 0)::numeric(20,2)::text as v from public.journal_lines l join public.accounts a on a.id = l.account_id
    where l.tenant_id = ${tenantId} and a.code = ${code}`;
  return row.v as string;
};
const people = (page: Page) => shown(page.getByRole("table", { name: "Commission by person" })).locator("tbody tr");
const earned = (page: Page) => shown(page.getByRole("table", { name: "Commission earned" })).locator("tbody tr");

/** An order for so many helmets at 1,000, submitted, invoiced and delivered at once, as the signed-in member. Ends on the posted invoice. */
async function sell(page: Page, quantity: string, invoiceNumber: string) {
  await page.goto("/sales/new?kind=order");
  const picked = page.getByRole("combobox", { name: "Customer", exact: true });
  await picked.fill("C-001");
  await picked.press("Tab");
  await expect(picked).toHaveAttribute("data-picked", "true");
  const picker = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await picker.fill("HL-1");
  await picker.press("Tab");
  await expect(picker).toHaveAttribute("data-picked", "true");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill(quantity);
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: /^SO-2627-/ })).toBeVisible();
  await page.getByRole("button", { name: "Invoice and deliver now" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales invoice" })).toBeVisible();
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByRole("heading", { name: invoiceNumber })).toBeVisible();
}

/** Cash from the test's customer against its oldest unpaid invoices, as the signed-in member. */
async function receive(page: Page, amount: string, receiptNumber: string) {
  await page.goto("/receipts/new");
  await shown(page.getByLabel("Customer name or code")).fill("C-001");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByRole("list", { name: "Customers found" }).getByRole("link", { name: "Registered Dealer" }).click();
  await page.getByLabel("Amount received").fill(amount);
  await page.getByRole("button", { name: "Oldest invoices first" }).click();
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: receiptNumber })).toBeVisible();
}

test("a salesperson's invoice earns commission, which waits for the customer to pay", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Commission Earned Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id}),
    (${tenantId}, ${other.id}, ${other.email}, 'salesperson', ${owner.id}),
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id})`;
  // A new company finishes setup with Commissions off; the owner switches it on.
  await sql`insert into public.modules_enabled (tenant_id, module, enabled, created_by, updated_by) values (${tenantId}, 'commissions', true, ${owner.id}, ${owner.id})
    on conflict (tenant_id, module) do update set enabled = true`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  await sql`insert into public.customers (tenant_id, name, code, credit_days, created_by, updated_by) values (${tenantId}, 'Registered Dealer', 'C-001', 30, ${owner.id}, ${owner.id})`;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  await seedStock(sql, { tenantId, itemId: item.id, warehouseId: warehouse.id, quantity: "100", value: "60000", userId: owner.id });
  // The company's plan: 2% of sales before tax for everyone.
  await sql`insert into public.commission_plans (tenant_id, name, kind, rate, effective_from, created_by, updated_by) values (${tenantId}, 'Standard plan', 'flat', 2, '2026-07-01', ${owner.id}, ${owner.id})`;
  await page.context().clearCookies();

  // The salesperson sells 10 helmets: 10,000. Their own page shows 200 earned, waiting for the customer.
  await signIn(page, seller);
  await sell(page, "10", "SI-2627-00001");
  await rail(page).getByRole("link", { name: "My commission", exact: true }).click();
  await expect(page).toHaveURL(/\/commissions\/earned$/);
  await expect(page.getByRole("heading", { name: "My commission" })).toBeVisible();
  await expect(earned(page)).toHaveCount(1);
  await expect(earned(page)).toContainText("SI-2627-00001");
  await expect(earned(page)).toContainText("Waiting for the customer to pay");
  await expect(visible(page, "commission-totals")).toContainText("200.00");
  // They cannot approve or pay, and see no one else.
  await expect(page.getByRole("button", { name: "Approve the ticked for payment" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pay commission" })).toHaveCount(0);
  await expect(shown(page.getByRole("table", { name: "Commission by person" }))).toHaveCount(0);
  expect(`${await balance("5220")} ${await balance("2320")}`).toBe("200.00 -200.00");
});

test("the accountant approves what the customer's money has released, and pays it", async ({ page }) => {
  await signIn(page, accountant);
  await page.goto("/reports");
  await shown(page.getByRole("link", { name: "Commission earned" })).click();
  await expect(page).toHaveURL(/\/commissions\/earned$/);
  await expect(people(page)).toHaveCount(1);
  await people(page).getByRole("link").click();
  // Nothing has been paid by the customer: nothing to approve or pay.
  await expect(earned(page)).toContainText("Waiting for the customer to pay");
  await expect(page.getByRole("button", { name: "Approve the ticked for payment" })).toHaveCount(0);
  await expect(page.getByText("Nothing is approved for payment.")).toBeVisible();
  const person = page.url();

  // The customer pays half. Half the commission is released.
  await receive(page, "5000", "RC-2627-00001");
  await page.goto(person);
  await expect(earned(page)).toContainText("Released, to approve");
  await expect(earned(page)).toContainText("100.00");
  await page.getByRole("button", { name: "Approve the ticked for payment" }).click();
  await expect(shown(page.getByRole("status"))).toContainText("Commission approved for payment.");
  await expect(earned(page)).toContainText("Approved for payment");
  await expect(visible(page, "commission-due")).toContainText("To pay now: 100.00");
  await page.getByRole("button", { name: "Pay commission" }).click();
  await expect(shown(page.getByRole("status"))).toContainText("CP-2627-00001: 100.00 paid.");
  const payments = shown(page.getByRole("table", { name: "Commission payments" })).locator("tbody tr");
  await expect(payments).toHaveCount(1);
  await expect(payments).toContainText("CP-2627-00001");
  expect(`${await balance("5220")} ${await balance("2320")} ${await balance("1111")}`).toBe("200.00 -100.00 4900.00");
});

test("goods coming back after the commission was paid are owed back, and come out of the next payment", async ({ page }) => {
  // Six of the ten helmets come back: 80 is still earned, and of the 4,000 the invoice now comes
  // to all has been paid, so 80 is released. 100 was paid: 20 is owed back.
  await signIn(page, accountant);
  await page.goto("/sales?kind=invoice");
  await shown(page.getByRole("table", { name: "Sales invoices" })).getByRole("link", { name: "SI-2627-00001" }).click();
  await page.getByRole("button", { name: "Record a return" }).click();
  await expect(page.getByRole("heading", { name: "Draft credit note" })).toBeVisible();
  await shown(page.getByLabel("Returned now, line 1", { exact: true })).fill("6");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(shown(page.getByRole("status"))).toHaveText("Draft saved.");
  await page.getByRole("button", { name: "Post credit note" }).click();
  await expect(page.getByRole("heading", { name: "CN-2627-00001" })).toBeVisible();
  await page.goto("/commissions/earned");
  await people(page).getByRole("link").click();
  await expect(earned(page)).toContainText("Owed back: 20.00");
  await expect(earned(page)).toContainText("was 200.00");
  expect(`${await balance("5220")} ${await balance("2320")}`).toBe("80.00 20.00");
  const person = page.url();
  await page.context().clearCookies();

  // The salesperson's next sale, 5,000, is paid for at once: 100 earned and released.
  await signIn(page, seller);
  await sell(page, "5", "SI-2627-00002");
  await page.context().clearCookies();
  await signIn(page, accountant);
  // The customer pays the new invoice in full, in cash.
  await receive(page, "5000", "RC-2627-00002");
  await page.goto(person);
  await expect(earned(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Approve the ticked for payment" }).click();
  await expect(shown(page.getByRole("status"))).toContainText("Commission approved for payment.");
  // 100 approved, 20 owed back: 80 to pay.
  await expect(visible(page, "commission-due")).toContainText("To pay now: 80.00");
  await page.getByRole("button", { name: "Pay commission" }).click();
  await expect(shown(page.getByRole("status"))).toContainText("CP-2627-00002: 100.00 approved, 20.00 of what was owed back taken out of it, 80.00 paid.");
  await expect(visible(page, "commission-totals")).toContainText("0.00");
  expect(`${await balance("5220")} ${await balance("2320")}`).toBe("180.00 0.00");
  const logged = await sql<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantId} and action like 'commission.%' order by at`;
  expect(logged.map((row) => row.action)).toEqual(["commission.accrue", "commission.approve", "commission.pay", "commission.return", "commission.accrue", "commission.approve", "commission.pay"]);
});

test("another salesperson sees nothing of it", async ({ page }) => {
  await signIn(page, other);
  await page.goto("/commissions/earned");
  await expect(page.getByRole("heading", { name: "My commission" })).toBeVisible();
  await expect(page.getByText("Nothing yet.")).toBeVisible();
  await expect(page.getByText("No commission has been paid yet.")).toBeVisible();
});
