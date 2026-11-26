import { expect, type Locator, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Daily expenses on screen: the owner enters the day's expenses on one screen and sees the day's
// total; uploads a sheet, sees what is wrong with it, puts it right and enters it whole; an
// accountant keeps a receipt with an expense and opens it again; the auditor reads it all and
// opens the receipt; a salesperson has no way in. What each of these posts, and who may keep and
// see a receipt, is tested against the database in src/modules/daily-expenses.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let accountant: TestUser;
let auditor: TestUser;
let seller: TestUser;
let tenantId: string;
let repairs: string;
let rent: string;

// The day in Pakistan, and the day before it.
const dayInPakistan = (back = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date(Date.now() - back * 86_400_000));
const TODAY = dayInPakistan();
const YESTERDAY = dayInPakistan(1);
const dayFirst = (iso: string) => iso.split("-").reverse().join("/");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const SHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("daily-owner", { canCreateCompany: true });
  accountant = await createUser("daily-accountant", { canCreateCompany: false });
  auditor = await createUser("daily-auditor", { canCreateCompany: false });
  seller = await createUser("daily-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const label = (page: Page, text: string) => shown(page.getByLabel(text, { exact: true }));
const rail = (page: Page) => page.getByRole("navigation", { name: "Main" });
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);
async function workbook(rows: (string | number | Date | null)[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const page = book.addWorksheet("Expenses");
  page.addRow(["Date", "What for", "Amount", "Paid from", "Paid to", "Note"]);
  for (const row of rows) page.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test("the owner enters the day's expenses on one screen and sees the day's total", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Daily Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id}),
    (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  const names = await sql<{ code: string; name: string }[]>`select code, name from public.accounts where tenant_id = ${tenantId} and code in ('5270', '5230')`;
  repairs = names.find((a) => a.code === "5270")!.name;
  rent = names.find((a) => a.code === "5230")!.name;

  await rail(page).getByRole("link", { name: "Daily expenses", exact: true }).click();
  await expect(page).toHaveURL(/\/daily-expenses$/);
  await expect(page.getByRole("heading", { name: "Daily expenses", level: 1 })).toBeVisible();
  await expect(shown(page.getByTestId("today-total"))).toContainText("0.00 spent today");
  // The company's one cash account is chosen to begin with.
  await expect(label(page, "Paid from")).toHaveValue(/.+/);

  await label(page, "What for").selectOption({ label: repairs });
  await label(page, "Amount (Rs)").fill("1,200");
  await label(page, "Note (optional)").fill("Tap for the shop");
  await page.getByRole("button", { name: "Add expense" }).click();
  await expect(shown(page.getByTestId("quick-added"))).toHaveText("Recorded as EX-2627-00001.");
  await expect(shown(page.getByTestId("today-total"))).toContainText("1,200.00 spent today, in 1 expense.");
  // The form is ready for the next one: the amount is cleared, the day and the account stay.
  await expect(label(page, "Amount (Rs)")).toHaveValue("");
  await expect(label(page, "Date")).toHaveValue(TODAY);

  await label(page, "What for").selectOption({ label: rent });
  await label(page, "Amount (Rs)").fill("300.50");
  await label(page, "Paid to (optional)").fill("Rickshaw");
  await page.getByRole("button", { name: "Add expense" }).click();
  await expect(shown(page.getByTestId("quick-added"))).toHaveText("Recorded as EX-2627-00002.");
  await expect(shown(page.getByTestId("today-total"))).toContainText("1,500.50 spent today, in 2 expenses.");
  const today = page.getByRole("table", { name: "Today's expenses" });
  await expect(today.getByRole("row").filter({ hasText: "EX-2627-00001" })).toContainText("Tap for the shop");
  await expect(today.getByRole("row").filter({ hasText: "EX-2627-00002" })).toContainText("Rickshaw");
  expect(await journal("EX-2627-00001")).toEqual(["5270 1200 0", "1111 0 1200"]);
  expect(await journal("EX-2627-00002")).toEqual(["5230 300.5 0", "1111 0 300.5"]);

  // What will not do is said, and nothing is entered.
  await label(page, "What for").selectOption({ label: rent });
  await label(page, "Amount (Rs)").fill("0");
  await page.getByRole("button", { name: "Add expense" }).click();
  await expect(shown(page.getByTestId("form-error"))).toHaveText("Enter an amount above nothing.");
  expect((await sql`select 1 from public.expenses where tenant_id = ${tenantId}`).length).toBe(2);

  // The same expenses are under Cash and bank, and an entry opened from here leads back here.
  await today.getByRole("link", { name: "EX-2627-00001" }).click();
  await expect(page.getByRole("heading", { name: "EX-2627-00001" })).toBeVisible();
  await page.getByRole("link", { name: "Daily expenses" }).first().click();
  await expect(page).toHaveURL(/\/daily-expenses$/);
  await page.goto("/cash-bank/expenses");
  await expect(page.getByRole("table", { name: "Expenses" })).toContainText("EX-2627-00002");
});

test("the owner uploads a sheet, is told what is wrong with it, and enters it whole once it is right", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/daily-expenses");
  await page.getByRole("link", { name: "Upload a sheet of expenses" }).click();
  await expect(page).toHaveURL(/\/daily-expenses\/import$/);
  await expect(shown(page.getByTestId("expense-account-names"))).toContainText(repairs);
  await expect(shown(page.getByTestId("money-account-names"))).toContainText("Cash in hand");

  // The template: the headings, and the names this company may use.
  const template = await page.request.get("/daily-expenses/import/template");
  expect(template.status()).toBe(200);
  expect(template.headers()["content-type"]).toBe(SHEET_TYPE);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await template.body()) as unknown as ExcelJS.Buffer);
  expect((book.worksheets[0].getRow(1).values as unknown[]).slice(1)).toEqual(["Date", "What for", "Amount", "Paid from", "Paid to", "Note"]);
  expect(book.worksheets[1].getColumn(1).values).toContain(repairs);

  // A sheet with a row that will not do: every row is shown, the bad one says why, and nothing can be entered.
  const bad = await workbook([
    [dayFirst(YESTERDAY), repairs, 2500, "Cash in hand", "Plumber", "Pipe"],
    [dayFirst(TODAY), "Tea and biscuits", "lots", "Cash in hand", null, null],
  ]);
  await label(page, "The sheet").setInputFiles({ name: "expenses.xlsx", mimeType: SHEET_TYPE, buffer: bad });
  await page.getByRole("button", { name: "Read the sheet" }).click();
  await expect(shown(page.getByTestId("sheet-summary"))).toHaveText("1 of 2 rows needs putting right. Nothing was entered: correct the sheet and read it again.");
  await expect(shown(page.getByTestId("row-problems"))).toContainText('No expense account is called "Tea and biscuits".');
  await expect(shown(page.getByTestId("row-problems"))).toContainText('"lots" is not an amount.');
  await expect(page.getByRole("button", { name: /^Enter / })).toHaveCount(0);
  expect((await sql`select 1 from public.expenses where tenant_id = ${tenantId}`).length).toBe(2);

  // Put right: three rows, a day Excel keeps as a day among them.
  const [year, month, day] = YESTERDAY.split("-").map(Number);
  const good = await workbook([
    [new Date(Date.UTC(year, month - 1, day)), repairs, 2500, "Cash in hand", "Plumber", "Pipe"],
    [dayFirst(YESTERDAY), rent, 45000, "cash in hand", "Landlord", null],
    [dayFirst(TODAY), repairs, 199.5, "Cash in hand", null, null],
  ]);
  await label(page, "The sheet").setInputFiles({ name: "expenses.xlsx", mimeType: SHEET_TYPE, buffer: good });
  await page.getByRole("button", { name: "Read the sheet" }).click();
  await expect(shown(page.getByTestId("sheet-summary"))).toHaveText("3 expenses, 47,699.50 in all. Nothing is entered until you press the button below.");
  expect((await sql`select 1 from public.expenses where tenant_id = ${tenantId}`).length).toBe(2);
  await page.getByRole("button", { name: "Enter these 3 expenses" }).click();
  await expect(shown(page.getByTestId("sheet-entered"))).toHaveText("Entered 3 expenses (EX-2627-00003 to EX-2627-00005), 47,699.50 in all.");
  expect((await sql`select 1 from public.expenses where tenant_id = ${tenantId}`).length).toBe(5);

  // On the list: today's total has grown, and yesterday has a total of its own.
  await page.goto("/daily-expenses");
  await expect(shown(page.getByTestId("today-total"))).toContainText("1,700.00 spent today, in 3 expenses.");
  await expect(shown(page.getByTestId("day-total"))).toContainText("47,500.00");
  await expect(shown(page.getByTestId("day-total"))).toContainText("in 2 expenses");
  await expect(shown(page.getByTestId("range-total"))).toContainText("49,200.00 in 5 expenses.");
  // Only yesterday.
  await label(page, "From").fill(YESTERDAY);
  await label(page, "To").fill(YESTERDAY);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(shown(page.getByTestId("range-total"))).toContainText("47,500.00 in 2 expenses.");
  await expect(page.getByTestId("today-total")).toHaveCount(0);
});

test("an accountant keeps a receipt with an expense and opens it again", async ({ page }) => {
  await signIn(page, accountant);
  await rail(page).getByRole("link", { name: "Daily expenses", exact: true }).click();
  await label(page, "What for").selectOption({ label: repairs });
  await label(page, "Amount (Rs)").fill("850");
  await label(page, "Note (optional)").fill("Lock for the store");
  await label(page, "Receipt (optional)").setInputFiles({ name: "Lock رسید.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.getByRole("button", { name: "Add expense" }).click();
  await expect(shown(page.getByTestId("quick-added"))).toHaveText("Recorded as EX-2627-00006. Its receipt is kept with it.");
  const row = page.getByRole("table", { name: "Today's expenses" }).getByRole("row").filter({ hasText: "EX-2627-00006" });
  await expect(row).toContainText("1 kept");

  await row.getByRole("link", { name: "EX-2627-00006" }).click();
  const receipts = shown(page.getByTestId("receipts"));
  await expect(receipts.getByRole("link", { name: "Lock رسید.pdf" })).toBeVisible();
  const [kept] = await sql<{ id: string; file_id: string }[]>`select r.id, r.file_id from public.expense_receipts r where r.tenant_id = ${tenantId}`;
  // The app answers with a redirect to a signed link at the object store, which returns the same bytes.
  const answer = await page.request.get(`/daily-expenses/receipts/${kept.id}`, { maxRedirects: 0 });
  expect(answer.status()).toBe(302);
  const link = answer.headers().location;
  expect(link).toContain(`/storage/v1/object/sign/files/${tenantId}/${kept.file_id}`);
  const fetched = await fetch(link);
  expect(fetched.status).toBe(200);
  expect(Buffer.compare(Buffer.from(await fetched.arrayBuffer()), PDF)).toBe(0);

  // One more receipt, added on the expense's own page.
  await label(page, "Add a receipt").setInputFiles({ name: "second.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.getByRole("button", { name: "Keep with this expense" }).click();
  await expect(receipts.getByRole("link", { name: "second.pdf" })).toBeVisible();
  // What is not a PDF or a photo is refused.
  await label(page, "Add a receipt").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByRole("button", { name: "Keep with this expense" }).click();
  await expect(shown(page.getByTestId("form-error"))).toHaveText("A receipt is a PDF, or a photo as PNG, JPEG or WebP.");
  expect((await sql`select 1 from public.expense_receipts where tenant_id = ${tenantId}`).length).toBe(2);
});

test("the auditor reads the expenses and opens a receipt, and changes nothing", async ({ page }) => {
  await signIn(page, auditor);
  await rail(page).getByRole("link", { name: "Daily expenses", exact: true }).click();
  await expect(shown(page.getByTestId("today-total"))).toContainText("2,550.00 spent today, in 4 expenses.");
  await expect(page.getByRole("button", { name: "Add expense" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Upload a sheet of expenses" })).toHaveCount(0);
  await page.getByRole("table", { name: "Today's expenses" }).getByRole("link", { name: "EX-2627-00006" }).click();
  await expect(shown(page.getByTestId("receipts")).getByRole("link", { name: "Lock رسید.pdf" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep with this expense" })).toHaveCount(0);
  const [kept] = await sql<{ id: string }[]>`select r.id from public.expense_receipts r where r.tenant_id = ${tenantId} order by r.created_at limit 1`;
  expect((await page.request.get(`/daily-expenses/receipts/${kept.id}`, { maxRedirects: 0 })).status()).toBe(302);
  await page.goto("/daily-expenses/import");
  await expect(page.getByText("Only the owner or an accountant enters the company's expenses.")).toBeVisible();
  expect((await page.request.get("/daily-expenses/import/template")).status()).toBe(404);
});

test("a salesperson has no way in to daily expenses", async ({ page }) => {
  await signIn(page, seller);
  await expect(rail(page).getByRole("link", { name: "Daily expenses", exact: true })).toHaveCount(0);
  await page.goto("/daily-expenses");
  await expect(page.getByText("Your role does not include cash and bank.")).toBeVisible();
  const [kept] = await sql<{ id: string }[]>`select r.id from public.expense_receipts r where r.tenant_id = ${tenantId} limit 1`;
  expect((await page.request.get(`/daily-expenses/receipts/${kept.id}`, { maxRedirects: 0 })).status()).toBe(404);
  expect((await page.request.get("/daily-expenses/import/template")).status()).toBe(404);
});
