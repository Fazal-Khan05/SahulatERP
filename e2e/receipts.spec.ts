import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 32 on screen: the recovery officer records cash and a cheque against a customer's
// invoice, the cheque goes to the bank, clears and then bounces, and the invoice is unpaid
// again; an advance is set against an invoice and a receipt entered by mistake is cancelled.
// What each of these posts is tested against the database in src/modules/receipts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let collector: TestUser;
let seller: TestUser;
let tenantId: string;
let customerId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("receipt-owner", { canCreateCompany: true });
  collector = await createUser("receipt-collector", { canCreateCompany: false });
  seller = await createUser("receipt-seller", { canCreateCompany: false });
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
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);

/** Opens a new receipt for the test's customer, by searching for it as a person would. */
async function newReceipt(page: Page) {
  await page.goto("/receipts/new");
  await shown(page.getByLabel("Customer name or code")).fill("C-001");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByRole("list", { name: "Customers found" }).getByRole("link", { name: "Registered Dealer" }).click();
  await expect(page.getByRole("heading", { name: "Receipt from Registered Dealer" })).toBeVisible();
}

test("an owner posts an invoice for the customer to pay", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Receipt Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${collector.id}, ${collector.email}, 'recovery_officer', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  const [customer] = await sql`insert into public.customers (tenant_id, name, code, credit_days, created_by, updated_by) values (${tenantId}, 'Registered Dealer', 'C-001', 30, ${owner.id}, ${owner.id}) returning id`;
  customerId = customer.id;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  await seedStock(sql, { tenantId, itemId: item.id, warehouseId: warehouse.id, quantity: "10", value: "6000", userId: owner.id });
  // A bank account of the company's own, under the chart's Bank accounts.
  await sql`insert into public.accounts (tenant_id, parent_id, code, name, type, is_group, control_type, created_by)
    select ${tenantId}, a.id, '1121', 'HBL current account', 'asset', false, 'bank', ${owner.id} from public.accounts a where a.tenant_id = ${tenantId} and a.code = '1120'`;

  await page.goto("/sales/new?kind=order");
  const picked = page.getByRole("combobox", { name: "Customer", exact: true });
  await picked.fill("C-001");
  await picked.press("Tab");
  await expect(picked).toHaveAttribute("data-picked", "true");
  const picker = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await picker.fill("HL-1");
  await picker.press("Tab");
  await expect(picker).toHaveAttribute("data-picked", "true");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: "SO-2627-00001" })).toBeVisible();
  await page.getByRole("button", { name: "Invoice and deliver now" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales invoice" })).toBeVisible();
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByRole("heading", { name: "SI-2627-00001" })).toBeVisible();
  expect(await balance("1200")).toBe("5000.00");

  // The owner's Collections entry leads to the recovery screens (Step 33), and from there to the receipts; a salesperson has no way in.
  await rail(page).getByRole("link", { name: "Collections", exact: true }).click();
  await expect(page).toHaveURL(/\/recovery$/);
  await page.getByRole("navigation", { name: "Collections" }).getByRole("link", { name: "Receipts", exact: true }).click();
  await expect(page).toHaveURL(/\/receipts$/);
  await expect(page.getByText("No receipts yet.")).toBeVisible();
});

test("the recovery officer records cash against the invoice", async ({ page }) => {
  await signIn(page, collector);
  await rail(page).getByRole("link", { name: "Receipts", exact: true }).click();
  await expect(page).toHaveURL(/\/receipts$/);
  await page.getByRole("link", { name: "New receipt" }).click();
  await shown(page.getByLabel("Customer name or code")).fill("dealer");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByRole("list", { name: "Customers found" }).getByRole("link", { name: "Registered Dealer" }).click();
  await expect(page.getByRole("heading", { name: "Receipt from Registered Dealer" })).toBeVisible();
  await expect(page.getByText("The books say Registered Dealer owes 5,000.00.")).toBeVisible();

  // 3,000 in cash. More against the invoice than was received is refused as it is typed and on the server.
  await page.getByLabel("Amount received").fill("3000");
  await shown(page.getByLabel("Pay now, SI-2627-00001", { exact: true })).fill("3500");
  await expect(visible(page, "receipt-split")).toContainText("500.00 more than the amount received");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(visible(page, "form-error")).toHaveText("The invoices come to more than the amount received. Lower what is set against them, or raise the amount.");
  await page.getByRole("button", { name: "Oldest invoices first" }).click();
  await expect(shown(page.getByLabel("Pay now, SI-2627-00001", { exact: true }))).toHaveValue("3000");
  await expect(visible(page, "receipt-split")).toContainText("Against invoices: 3,000.00. Kept as the customer's advance: 0.00.");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: "RC-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  expect(await journal("RC-2627-00001")).toEqual(["1111 3000 0", "1200 0 3000"]);
  expect(await balance("1200")).toBe("2000.00");
});

test("a cheque is received, deposited and cleared, and when it bounces the invoice is unpaid again", async ({ page }) => {
  await signIn(page, collector);
  await newReceipt(page);
  const sheet = shown(page.getByRole("table", { name: "Unpaid invoices" }));
  await expect(sheet.locator("tbody tr")).toContainText("2,000.00");

  // A cheque for 2,500 against the 2,000 still unpaid: the other 500 is the customer's advance.
  await page.getByLabel("How it came").selectOption({ label: "Cheque" });
  await page.getByLabel("Amount received").fill("2500");
  await page.getByLabel("Cheque number").fill("00451872");
  await page.getByLabel("Bank it is drawn on").fill("Meezan Bank");
  await page.getByRole("button", { name: "Oldest invoices first" }).click();
  await expect(visible(page, "receipt-split")).toContainText("Against invoices: 2,000.00. Kept as the customer's advance: 500.00.");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: "RC-2627-00002" })).toBeVisible();
  await expect(visible(page, "cheque-stage")).toHaveText("In hand");
  await expect(visible(page, "receipt-advance")).toContainText("500.00");
  const receiptUrl = new URL(page.url()).pathname;
  // The invoice is paid and the cheque is an asset in hand.
  expect(await journal("RC-2627-00002")).toEqual(["1130 2500 0", "1200 0 2000", "2130 0 500"]);
  expect(`${await balance("1200")} ${await balance("1130")}`).toBe("0.00 2500.00");

  // It shows in the cheques register and in "Needs attention", as ready for the bank.
  await rail(page).getByRole("link", { name: "Cheques", exact: true }).click();
  await expect(page).toHaveURL(/\/receipts\/cheques$/);
  await expect(visible(page, "cheques-in-hand")).toHaveText("2,500.00");
  await expect(shown(page.getByRole("table", { name: "Cheques" })).locator("tbody tr")).toContainText("can be deposited");
  await page.goto("/inbox");
  await page.getByRole("list", { name: "Waiting on you" }).getByRole("link", { name: "Deposit a cheque from Registered Dealer" }).click();
  await expect(page).toHaveURL(/\/receipts\/cheques$/);
  await shown(page.getByRole("table", { name: "Cheques" })).getByRole("link", { name: "RC-2627-00002" }).click();
  await expect(page).toHaveURL(new RegExp(`${receiptUrl}$`));

  // To the bank: nothing is posted yet.
  await page.getByLabel("Bank account it was deposited in").selectOption({ label: "1121 HBL current account" });
  await page.getByRole("button", { name: "Mark as deposited" }).click();
  await expect(visible(page, "cheque-stage")).toContainText("Deposited");
  expect(`${await balance("1130")} ${await balance("1121")}`).toBe("2500.00 0.00");
  // A cheque at the bank clears or bounces; it is no longer cancelled.
  await expect(page.getByRole("button", { name: "Cancel receipt" })).toHaveCount(0);

  // Cleared: the bank has the money, less the 25 it kept.
  await shown(page.getByLabel("Kept by the bank")).fill("25");
  await page.getByRole("button", { name: "Mark as cleared" }).click();
  await expect(visible(page, "cheque-stage")).toContainText("Cleared");
  expect(`${await balance("1130")} ${await balance("1121")} ${await balance("5810")}`).toBe("0.00 2475.00 25.00");

  // Bounced after all: the bank takes the cheque back in full and keeps its charge; the invoice is unpaid again and the advance is gone.
  await shown(page.getByLabel("Why", { exact: true })).fill("Insufficient funds");
  await page.getByRole("button", { name: "Mark as bounced" }).click();
  await expect(visible(page, "document-status")).toHaveText("Bounced");
  await expect(visible(page, "cheque-stage")).toContainText("Insufficient funds");
  expect(`${await balance("1200")} ${await balance("1130")} ${await balance("2130")} ${await balance("1121")} ${await balance("5810")}`).toBe("2000.00 0.00 0.00 -25.00 25.00");
  await expect(page.getByRole("button", { name: /Mark as|Cancel receipt/ })).toHaveCount(0);
  await newReceipt(page);
  await expect(shown(page.getByRole("table", { name: "Unpaid invoices" })).locator("tbody tr")).toContainText("2,000.00");
});

test("an advance is set against an invoice, and a receipt entered by mistake is cancelled", async ({ page }) => {
  await signIn(page, owner);
  await newReceipt(page);
  // 800 into the bank, 50 of it kept by the bank, and only 300 against the invoice for now.
  await page.getByLabel("How it came").selectOption({ label: "Bank transfer or deposit" });
  await page.getByLabel("Amount received").fill("800");
  await page.getByLabel("Kept by the bank").fill("50");
  await shown(page.getByLabel("Pay now, SI-2627-00001", { exact: true })).fill("300");
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: "RC-2627-00003" })).toBeVisible();
  expect(await journal("RC-2627-00003")).toEqual(["1121 750 0", "5810 50 0", "1200 0 300", "2130 0 500"]);
  await expect(visible(page, "receipt-advance")).toContainText("500.00");

  // 200 of the advance goes against the invoice; 300 stays the customer's advance.
  await shown(page.getByLabel("From the advance, SI-2627-00001", { exact: true })).fill("200");
  await page.getByRole("button", { name: "Set against these invoices" }).click();
  await expect(visible(page, "receipt-advance")).toContainText("300.00");
  await expect(shown(page.getByRole("table", { name: "What it pays" })).locator("tbody tr")).toHaveCount(2);
  expect(`${await balance("1200")} ${await balance("2130")}`).toBe("1500.00 -300.00");

  // It was the wrong customer's money after all: cancelled, with the reason. Everything it paid is unpaid again.
  await shown(page.getByLabel("Why it is cancelled")).fill("Wrong customer");
  await page.getByRole("button", { name: "Cancel receipt" }).click();
  await expect(visible(page, "document-status")).toHaveText("Cancelled");
  expect(`${await balance("1200")} ${await balance("2130")} ${await balance("1121")} ${await balance("5810")}`).toBe("2000.00 0.00 -25.00 25.00");
  const list = shown(page.getByRole("table", { name: "Receipts" }));
  await page.goto("/receipts");
  await expect(list.locator("tbody tr")).toHaveCount(3);

  // Every act is in the activity log under the name of whoever did it.
  const logged = await sql<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantId} and (action like 'receipt.%' or action like 'cheque.%') and action not in ('receipt.create', 'receipt.update') order by at`;
  expect(logged.map((row) => row.action)).toEqual(["receipt.post", "receipt.post", "cheque.deposit", "cheque.clear", "cheque.bounce", "receipt.post", "receipt.apply_advance", "receipt.cancel"]);
  expect((await sql`select count(*)::int as n from public.receipts where tenant_id = ${tenantId} and customer_id = ${customerId}`)[0].n).toBe(3);
});

test("a salesperson has no way in to receipts", async ({ page }) => {
  await signIn(page, seller);
  await expect(rail(page).getByRole("link", { name: /Receipts|Cheques|Collections/ })).toHaveCount(0);
  await page.goto("/receipts");
  await expect(page.getByText("Your role does not include receipts.")).toBeVisible();
  await page.goto("/receipts/new");
  await expect(page.getByText("Only an owner, an accountant or the recovery officer can record receipts.")).toBeVisible();
});
