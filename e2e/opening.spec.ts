import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 15 on screen: a company brings its books with it. Account balances, unpaid invoices and
// unpaid bills are entered or imported, posted as one journal, aged from their own dates, and
// corrected by reversing. The rules themselves are tested in src/modules/opening.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let auditor: TestUser;
let seller: TestUser;
let tenantId: string;

/** A date `days` before today in Pakistan, as 2026-06-30 and as 30-06-2026. */
function daysAgo(days: number): { iso: string; shown: string } {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date(Date.now() - days * 86_400_000));
  return { iso, shown: iso.split("-").reverse().join("-") };
}
const today = daysAgo(0);
const recent = daysAgo(10);
const older = daysAgo(45);
const old = daysAgo(200);

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("opening-owner", { canCreateCompany: true });
  auditor = await createUser("opening-auditor", { canCreateCompany: false });
  seller = await createUser("opening-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("an owner enters the books the company brings with it and posts them", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Opening Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  await sql`insert into public.customers (tenant_id, code, name, created_by, updated_by) values
    (${tenantId}, 'C-001', 'Alpha Motors', ${owner.id}, ${owner.id}), (${tenantId}, null, 'Delta Stores', ${owner.id}, ${owner.id})`;
  await sql`insert into public.suppliers (tenant_id, code, name, created_by, updated_by) values (${tenantId}, 'S-001', 'Sigma Imports', ${owner.id}, ${owner.id})`;

  await page.goto("/settings/opening-balances");
  await page.getByLabel("Opening date").fill(today.iso);
  await page.getByRole("button", { name: "Start opening balances" }).click();
  await expect(page.getByTestId("opening-status")).toHaveText("Draft: not in the books yet.");
  await expect(page.getByText("No account balances yet.")).toBeVisible();

  // One account at a time. Receivables, payables and stock are not offered here.
  const account = page.locator("form").filter({ has: page.getByRole("button", { name: "Save balance" }) });
  const options = await account.getByLabel("Account").locator("option").allTextContents();
  expect(options).toContain("1111 Cash in hand");
  for (const closed of ["1200 Trade receivables", "2110 Trade payables", "1300 Stock in trade", "3900 Opening balance equity", "1100 Current assets"]) expect(options).not.toContain(closed);
  await account.getByLabel("Account").selectOption({ label: "1111 Cash in hand" });
  await account.getByLabel("Debit").fill("50000");
  await account.getByRole("button", { name: "Save balance" }).click();
  const balances = page.getByRole("table", { name: "Account balances" });
  await expect(balances.getByRole("row").nth(1)).toHaveText(/1111 Cash in hand\s*50,000.00/);

  // The rest of the trial balance from a file. A bad row stops the whole file and is listed.
  const trial = page.locator("#accounts-file");
  const importAccounts = page.locator("form").filter({ has: trial });
  await trial.setInputFiles({ name: "tb.csv", mimeType: "text/csv", buffer: Buffer.from("Account code,Account name,Debit,Credit\n1510,Furniture and fixtures,125000,\n1200,Trade receivables,84700,\n3100,Owner's capital,,500000\n") });
  await importAccounts.getByRole("button", { name: "Import" }).click();
  await expect(page.getByTestId("import-problems")).toContainText("Nothing was imported. 1 row needs correcting");
  await expect(page.getByRole("table", { name: "Rows to correct" }).getByRole("row").nth(1)).toHaveText(/3\s*1200 Trade receivables\s*1200 Trade receivables is entered customer by customer, invoice by invoice, under Receivables/);
  await expect(balances.getByRole("row")).toHaveCount(2);
  await trial.setInputFiles({ name: "tb.csv", mimeType: "text/csv", buffer: Buffer.from("Account code,Account name,Debit,Credit\n1510,Furniture and fixtures,125000,\n5230,Rent,0,0\n3100,Owner's capital,,500000\n") });
  await importAccounts.getByRole("button", { name: "Import" }).click();
  await expect(page.getByTestId("import-done")).toHaveText("Imported 2 account balances.");
  await expect(balances.getByRole("row")).toHaveText([/Account/, /1111 Cash in hand\s*50,000.00/, /1510 Furniture and fixtures\s*1,25,000.00/, /3100 Owner's capital\s*5,00,000.00/]);

  // Unpaid invoices: one typed, the rest from a file, each with its own date.
  const invoice = page.locator("form").filter({ has: page.getByRole("button", { name: "Add invoice" }) });
  await invoice.getByLabel("Customer").fill("c-001");
  await invoice.getByLabel("Invoice number").fill("SI-0412");
  await invoice.getByLabel("Amount unpaid").fill("84500");
  await invoice.getByLabel("Invoice date").fill(old.iso);
  await invoice.getByRole("button", { name: "Add invoice" }).click();
  const invoices = page.getByRole("table", { name: "Unpaid invoices" });
  await expect(invoices.getByRole("row").nth(1)).toHaveText(new RegExp(`C-001 Alpha Motors\\s*SI-0412\\s*${old.shown}\\s*84,500.00`));
  // An invoice dated on the opening date is not an opening balance.
  await invoice.getByLabel("Customer").fill("C-001");
  await invoice.getByLabel("Invoice number").fill("SI-0999");
  await invoice.getByLabel("Amount unpaid").fill("1");
  await invoice.getByLabel("Invoice date").fill(today.iso);
  await invoice.getByRole("button", { name: "Add invoice" }).click();
  await expect(invoice.getByTestId("form-error")).toHaveText("The invoice's date must be before the opening date. One dated on or after it is entered as an ordinary invoice.");
  await page.locator("#receivable-file").setInputFiles({ name: "ar.csv", mimeType: "text/csv", buffer: Buffer.from(`Customer,Invoice number,Invoice date,Due date,Amount unpaid\nAlpha Motors,SI-0455,${older.iso},,200\nDelta Stores,SI-0601,${recent.iso},,1500.75\n`) });
  await page.locator("form").filter({ has: page.locator("#receivable-file") }).getByRole("button", { name: "Import" }).click();
  await expect(invoices.getByRole("row")).toHaveCount(5);

  // One unpaid bill.
  const bill = page.locator("form").filter({ has: page.getByRole("button", { name: "Add bill" }) });
  await bill.getByLabel("Supplier").fill("Sigma Imports");
  await bill.getByLabel("Bill number").fill("B-1");
  await bill.getByLabel("Amount unpaid").fill("12000");
  await bill.getByLabel("Bill date").fill(recent.iso);
  await bill.getByRole("button", { name: "Add bill" }).click();
  await expect(page.getByRole("table", { name: "Unpaid bills" }).getByRole("row").nth(1)).toHaveText(/S-001 Sigma Imports\s*B-1/);

  // Debits 175,000 + 86,200.75, credits 500,000 + 12,000: equity takes the 250,799.25 between them.
  const totals = page.getByRole("table", { name: "Opening balances in total" });
  await expect(totals.getByRole("row")).toHaveText([/Debit\s*Credit/, /Account balances\s*1,75,000.00\s*5,00,000.00/, /Customers' unpaid invoices\s*86,200.75/, /Suppliers' unpaid bills\s*12,000.00/, /Opening balance equity.*2,50,799.25/]);
  await expect(page.getByTestId("equity-debit")).toHaveText("2,50,799.25");
  await expect(page.getByTestId("equity-note")).toContainText("If your books balanced, it is the value of your stock on that day");

  await page.getByRole("button", { name: "Post opening balances" }).click();
  await expect(page.getByTestId("opening-status")).toContainText("Posted on");
  await expect(page.getByRole("button", { name: "Save balance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add invoice" })).toHaveCount(0);

  // One journal, balanced, with receivables customer by customer.
  const booked = await sql`
    select a.code, coalesce(c.name, s.name, '') as party, l.debit::text as debit, l.credit::text as credit
    from public.journals j
    join public.journal_lines l on l.tenant_id = j.tenant_id and l.journal_id = j.id
    join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
    left join public.customers c on c.id = l.customer_id
    left join public.suppliers s on s.id = l.supplier_id
    where j.tenant_id = ${tenantId} and j.source_type = 'opening_balance' and j.journal_date = ${today.iso}
    order by a.code, party`;
  expect(booked.map((b) => `${b.code} ${b.party} ${b.debit} ${b.credit}`)).toEqual([
    "1111  50000.0000 0.0000",
    "1200 Alpha Motors 84700.0000 0.0000",
    "1200 Delta Stores 1500.7500 0.0000",
    "1510  125000.0000 0.0000",
    "2110 Sigma Imports 0.0000 12000.0000",
    "3100  0.0000 500000.0000",
    "3900  250799.2500 0.0000",
  ]);

  // Aged from each invoice's own date: 10 days, 45 days and 200 days old today.
  const aged = page.getByRole("table", { name: "Receivables by age" });
  await expect(aged.getByRole("row")).toHaveText([
    /Customer\s*0 to 30 days\s*31 to 60 days\s*61 to 90 days\s*Over 90 days\s*Total/,
    /^\s*Alpha Motors\s*200.00\s*84,500.00\s*84,700.00\s*$/,
    /^\s*Delta Stores\s*1,500.75\s*1,500.75\s*$/,
    /^\s*Total\s*1,500.75\s*200.00\s*84,500.00\s*86,200.75\s*$/,
  ]);
  const alpha = aged.getByRole("row").nth(1).getByRole("cell");
  await expect(alpha).toHaveText(["Alpha Motors", "", "200.00", "", "84,500.00", "84,700.00"]);
});

test("posted balances are corrected by reversing them; an auditor only reads; a salesperson has no way in", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/settings/opening-balances");
  await page.getByRole("button", { name: "Reverse and correct" }).click();
  await expect(page.getByTestId("opening-status")).toHaveText("Draft: not in the books yet.");
  // The same lines are back as a draft, and the two journals cancel out.
  await expect(page.getByRole("table", { name: "Unpaid invoices" }).getByRole("row")).toHaveCount(5);
  const left = await sql`select account_id from public.journal_lines where tenant_id = ${tenantId} group by account_id, customer_id, supplier_id having sum(debit) <> sum(credit)`;
  expect(left).toHaveLength(0);
  await page.getByRole("button", { name: "Remove 1510" }).click();
  await expect(page.getByRole("table", { name: "Account balances" }).getByRole("row")).toHaveCount(3);
  await page.getByRole("button", { name: "Post opening balances" }).click();
  await expect(page.getByTestId("opening-status")).toContainText("Posted on");
  const audited = await sql`select action from public.audit_log where tenant_id = ${tenantId} and action like 'opening.%' order by at, action`;
  expect(audited.map((a) => a.action)).toEqual([
    "opening.start",
    "opening.set_account",
    "opening.import_account",
    "opening.add_receivable",
    "opening.import_receivable",
    "opening.add_payable",
    "opening.post",
    "opening.reverse",
    "opening.remove_line",
    "opening.post",
  ]);

  await page.context().clearCookies();
  await signIn(page, auditor);
  await page.goto("/settings/opening-balances");
  await expect(page.getByRole("table", { name: "Unpaid invoices" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Receivables by age" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reverse and correct" })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, seller);
  await page.goto("/settings/opening-balances");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see the opening balances.")).toBeVisible();
});
