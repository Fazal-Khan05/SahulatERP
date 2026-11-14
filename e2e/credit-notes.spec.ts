import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 21 on screen: the sales manager records goods coming back against a posted invoice,
// some of them damaged; the credit note brings down what the customer owes and puts the good
// ones back into stock; more than was invoiced cannot come back; and a return on an invoice
// that has been paid leaves the customer credit, which the owner sets against another invoice.
// What each of these posts is tested against the database in src/modules/credit-notes.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let manager: TestUser;
let seller: TestUser;
let tenantId: string;
let itemId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("credit-owner", { canCreateCompany: true });
  manager = await createUser("credit-manager", { canCreateCompany: false });
  seller = await createUser("credit-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

// A page visited earlier stays in the document, hidden: only what is on screen is looked at.
const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
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
const onHand = async () => {
  const [row] = await sql`select quantity::text, value::text from public.stock_balances where tenant_id = ${tenantId} and item_id = ${itemId}`;
  return `${Number(row.quantity)} worth ${Number(row.value)}`;
};

/** An order for so many helmets, submitted, invoiced and delivered at once, as the signed-in member. Ends on the posted invoice. */
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

test("an owner posts an invoice for five helmets", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Credit Note Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${manager.id}, ${manager.email}, 'sales_manager', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  itemId = item.id;
  await sql`insert into public.customers (tenant_id, name, code, credit_days, created_by, updated_by) values (${tenantId}, 'Registered Dealer', 'C-001', 30, ${owner.id}, ${owner.id})`;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  await seedStock(sql, { tenantId, itemId, warehouseId: warehouse.id, quantity: "10", value: "6000", userId: owner.id });

  await sell(page, "5", "SI-2627-00001");
  expect(await balance("1200")).toBe("5000.00");
  expect(await onHand()).toBe("5 worth 3000");
  // The invoice's page says how a mistake on it is put right, and offers to record a return.
  const returns = page.getByRole("heading", { name: "Returns and credit notes" });
  await expect(returns).toBeVisible();
  await expect(page.getByRole("button", { name: "Record a return" })).toBeVisible();
});

test("the sales manager records two helmets coming back, one of them damaged", async ({ page }) => {
  await signIn(page, manager);
  await page.goto("/sales?kind=invoice");
  await shown(page.getByRole("table", { name: "Sales invoices" })).getByRole("link", { name: "SI-2627-00001" }).click();
  await page.getByRole("button", { name: "Record a return" }).click();
  await expect(page.getByRole("heading", { name: "Draft credit note" })).toBeVisible();
  const sheet = shown(page.getByRole("table", { name: "Lines to take back" }));
  await expect(sheet.locator("tbody tr")).toContainText("HL-1");

  // More than the invoice billed cannot come back; nor can more be damaged than came back.
  await shown(page.getByLabel("Returned now, line 1", { exact: true })).fill("6");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(visible(page, "form-error")).toHaveText("HL-1: the invoice billed 5, so 6 cannot come back.");
  await shown(page.getByLabel("Returned now, line 1", { exact: true })).fill("2");
  await shown(page.getByLabel("Of which damaged, line 1", { exact: true })).fill("3");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(visible(page, "form-error")).toHaveText("Line 1: no more can be damaged than came back.");

  // Two came back, one damaged. Asked to post straight away, it is saved and shown first: nothing is posted unseen.
  await shown(page.getByLabel("Of which damaged, line 1", { exact: true })).fill("1");
  await shown(page.getByLabel("Reason")).fill("Wrong size sent; one arrived cracked");
  await page.getByRole("button", { name: "Post credit note" }).click();
  await expect(shown(page.getByRole("status"))).toContainText("Saved, not posted yet");
  await expect(visible(page, "document-total")).toHaveText("2,000.00");
  expect(await balance("1200")).toBe("5000.00");
  await page.getByRole("button", { name: "Post credit note" }).click();
  await expect(page.getByRole("heading", { name: "CN-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Posted");

  // The customer owes 2,000 less; one helmet is back on the shelf at what it cost, and one is written off.
  expect(await journal("CN-2627-00001")).toEqual(["4100 2000 0", "1200 0 2000", "1300 600 0", "5110 600 0", "5100 0 1200"]);
  expect(await balance("1200")).toBe("3000.00");
  expect(await onHand()).toBe("6 worth 3600");
  const settled = shown(page.getByRole("table", { name: "What it was set against" }));
  await expect(settled.locator("tbody tr")).toContainText("SI-2627-00001");
  await expect(settled.locator("tbody tr")).toContainText("2,000.00");
  await expect(visible(page, "credit-left")).toHaveText("All of it is set against invoices.");
  await expect(shown(page.getByRole("table", { name: "In the books" }))).toHaveCount(0);
  await expect(page.getByText("1 damaged")).toBeVisible();

  // It is on the list of credit notes, and on its invoice's page.
  await page.goto("/sales?kind=credit_note");
  const list = shown(page.getByRole("table", { name: "Credit notes" }));
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(list.locator("tbody tr")).toContainText("2,000.00");
  await list.getByRole("link", { name: "CN-2627-00001" }).click();
  await shown(page.getByRole("link", { name: "SI-2627-00001" })).first().click();
  await expect(page.getByRole("heading", { name: "SI-2627-00001" })).toBeVisible();
  await expect(shown(page.getByRole("list", { name: "Credit notes" })).getByRole("listitem")).toContainText("CN-2627-00001");

  // Three are left to return, not four.
  await page.getByRole("button", { name: "Record a return" }).click();
  await expect(page.getByRole("heading", { name: "Draft credit note" })).toBeVisible();
  await shown(page.getByLabel("Returned now, line 1", { exact: true })).fill("4");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(visible(page, "form-error")).toHaveText("HL-1: the invoice billed 5 and 2 has already come back, so only 3 more can.");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page).toHaveURL(/\/sales\?kind=credit_note$/);
  await expect(shown(page.getByRole("table", { name: "Credit notes" })).locator("tbody tr")).toHaveCount(1);
});

test("a return on an invoice that has been paid leaves credit, which the owner sets against another invoice", async ({ page }) => {
  // The customer pays the 3,000 still owed on the first invoice, in cash.
  await signIn(page, owner);
  await page.goto("/receipts/new");
  await shown(page.getByLabel("Customer name or code")).fill("C-001");
  await page.getByRole("button", { name: "Find" }).click();
  await page.getByRole("list", { name: "Customers found" }).getByRole("link", { name: "Registered Dealer" }).click();
  await expect(page.getByText("The books say Registered Dealer owes 3,000.00.")).toBeVisible();
  await page.getByLabel("Amount received").fill("3000");
  await page.getByRole("button", { name: "Oldest invoices first" }).click();
  await page.getByRole("button", { name: "Post receipt" }).click();
  await expect(page.getByRole("heading", { name: "RC-2627-00001" })).toBeVisible();
  expect(await balance("1200")).toBe("0.00");

  // One more helmet comes back, fit to sell. Nothing is left to pay on the invoice: the 1,000 is the customer's credit.
  await page.goto("/sales?kind=invoice");
  await shown(page.getByRole("table", { name: "Sales invoices" })).getByRole("link", { name: "SI-2627-00001" }).click();
  await page.getByRole("button", { name: "Record a return" }).click();
  await expect(page.getByRole("heading", { name: "Draft credit note" })).toBeVisible();
  await shown(page.getByLabel("Returned now, line 1", { exact: true })).fill("1");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(shown(page.getByRole("status"))).toHaveText("Draft saved.");
  await page.getByRole("button", { name: "Post credit note" }).click();
  await expect(page.getByRole("heading", { name: "CN-2627-00002" })).toBeVisible();
  expect(await journal("CN-2627-00002")).toEqual(["4100 1000 0", "2130 0 1000", "1300 600 0", "5100 0 600"]);
  await expect(visible(page, "credit-left")).toContainText("1,000.00");
  // The owner reads the ledger, so the page shows what the credit note put into the books.
  await expect(shown(page.getByRole("table", { name: "In the books" }))).toBeVisible();
  const creditNote = page.url();

  // A new invoice for one helmet; 600 of the credit is set against it, and 400 stays the customer's credit.
  await sell(page, "1", "SI-2627-00002");
  await page.goto(creditNote);
  await shown(page.getByLabel("From the credit, SI-2627-00002", { exact: true })).fill("1500");
  await page.getByRole("button", { name: "Set against these invoices" }).click();
  await expect(visible(page, "form-error")).toHaveText("This credit note has 1000.00 not yet set against an invoice. Lower the amounts.");
  await shown(page.getByLabel("From the credit, SI-2627-00002", { exact: true })).fill("600");
  await page.getByRole("button", { name: "Set against these invoices" }).click();
  await expect(visible(page, "credit-left")).toContainText("400.00");
  await expect(shown(page.getByRole("table", { name: "What it was set against" })).locator("tbody tr")).toContainText("SI-2627-00002");
  expect(`${await balance("1200")} ${await balance("2130")}`).toBe("400.00 -400.00");

  // Every act is in the activity log.
  const logged = await sql<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantId} and action like 'credit_note.%' order by at`;
  expect(logged.map((row) => row.action)).toEqual(["credit_note.post", "credit_note.post", "credit_note.apply"]);
});

test("a salesperson reads credit notes of their own sales only, and records no return", async ({ page }) => {
  await signIn(page, seller);
  // The invoices above were the owner's own sales: the salesperson sees none of them.
  await page.goto("/sales?kind=credit_note");
  await expect(page.getByText("No credit notes yet.")).toBeVisible();
  // Their own sale: the invoice's page tells them who records a return.
  await sell(page, "1", "SI-2627-00003");
  await expect(page.getByText("An owner, an accountant or the sales manager records a return.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Record a return" })).toHaveCount(0);
});
