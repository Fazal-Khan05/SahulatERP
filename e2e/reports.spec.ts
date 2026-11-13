import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 16 on screen: the four ledger reports, their period and branch, the files they download
// as, and the printed page on the company's letterhead. The sums are tested in src/modules/reports.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let auditor: TestUser;
let seller: TestUser;
let tenantId: string;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
const shown = today.split("-").reverse().join("-");

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("report-owner", { canCreateCompany: true });
  auditor = await createUser("report-auditor", { canCreateCompany: false });
  seller = await createUser("report-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("an owner reads the books: trial balance, balance sheet, profit and loss, and one account's ledger", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Report Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;
  // Three entries through the posting engine, as the owner: capital in, rent paid, a cash sale.
  const accounts = Object.fromEntries((await sql<{ id: string; code: string }[]>`select id, code from public.accounts where tenant_id = ${tenantId}`).map((a) => [a.code, a.id]));
  const post = (debit: string, credit: string, amount: string, number: string, memo: string) =>
    sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${owner.id}, true), set_config('app.tenant_id', ${tenantId}, true)`;
      // Sent as text and read as JSON by the database: the driver would otherwise wrap it in quotes again.
      const lines = JSON.stringify([{ account_id: accounts[debit], debit: amount }, { account_id: accounts[credit], credit: amount }]);
      await tx`select app.post_journal(${today}::date, 'manual_journal', gen_random_uuid(), (${lines}::text)::jsonb, ${memo}, null, ${number})`;
    });
  await post("1111", "3100", "500000", "JV-0001", "Owner's money put in");
  await post("5230", "1111", "40000", "JV-0002", "Shop rent");
  await post("1111", "4100", "12500.50", "JV-0003", "Cash sale");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("list", { name: "Ledger reports" }).getByRole("link")).toHaveText(["Trial balance", "General ledger", "Balance sheet", "Profit and loss"]);

  // Trial balance: the fiscal year so far, and totals that agree.
  await page.getByRole("link", { name: "Trial balance" }).click();
  const tb = page.getByRole("table", { name: "Trial balance" });
  await expect(page.getByTestId("report-period")).toContainText(`to ${shown}`);
  await expect(tb.getByRole("row")).toHaveText([
    /Code\s*Account\s*Opening debit\s*Opening credit\s*Debits\s*Credits\s*Closing debit\s*Closing credit/,
    /1111\s*Cash in hand\s*5,12,500.50\s*40,000.00\s*4,72,500.50/,
    /3100\s*Owner's capital\s*5,00,000.00\s*5,00,000.00/,
    /4100\s*Sales\s*12,500.50\s*12,500.50/,
    /5230\s*Rent\s*40,000.00\s*40,000.00/,
    /Total\s*0.00\s*0.00\s*5,52,500.50\s*5,52,500.50\s*5,12,500.50\s*5,12,500.50/,
  ]);
  await expect(page.getByTestId("report-note")).toHaveCount(0);
  // A period before anything happened: nothing but a nil total. The period travels in the address.
  await page.getByLabel("From").fill("2020-01-01");
  await page.getByLabel("To", { exact: true }).fill("2020-12-31");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(/from=2020-01-01&to=2020-12-31/);
  await expect(page.getByRole("table", { name: "Trial balance" }).getByRole("row")).toHaveCount(2);

  // Balance sheet: assets equal liabilities plus equity, with the loss so far under equity.
  await page.goto("/reports/balance-sheet");
  const sheet = page.getByRole("table", { name: "Balance sheet" });
  await expect(page.getByTestId("report-period")).toHaveText(`As at the end of ${shown}`);
  await expect(sheet.getByRole("row").filter({ hasText: "Total assets" })).toHaveText(/Total assets\s*4,72,500.50/);
  await expect(sheet.getByRole("row").filter({ hasText: "Loss for this fiscal year so far" })).toHaveText(/-27,499.50/);
  await expect(sheet.getByRole("row").filter({ hasText: "Total liabilities and equity" })).toHaveText(/Total liabilities and equity\s*4,72,500.50/);
  await expect(page.getByLabel("From")).toHaveCount(0);
  // A day before anything happened is shown as that day, with nothing on it: the day asked for is never moved.
  await page.getByLabel("As at the end of").fill("2020-06-30");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByTestId("report-period").filter({ visible: true })).toHaveText("As at the end of 30-06-2020");
  await expect(page.getByRole("table", { name: "Balance sheet" }).filter({ visible: true }).getByRole("row").filter({ hasText: "Total assets" })).toHaveText(/Total assets\s*0.00/);

  // Profit and loss: income less expenses.
  await page.goto("/reports/profit-and-loss");
  const pl = page.getByRole("table", { name: "Profit and loss" });
  await expect(pl.getByRole("row").filter({ hasText: "Total income" })).toHaveText(/Total income\s*12,500.50/);
  await expect(pl.getByRole("row").filter({ hasText: "Total expenses" })).toHaveText(/Total expenses\s*40,000.00/);
  await expect(pl.getByRole("row").last()).toHaveText(/Net loss\s*-27,499.50/);

  // General ledger: nothing until an account is chosen, then its entries with a running balance.
  await page.goto("/reports/general-ledger");
  await expect(page.getByText("Choose an account to see its entries.")).toBeVisible();
  await page.getByLabel("Account").selectOption({ label: "1111 Cash in hand" });
  await page.getByRole("button", { name: "Show" }).click();
  const ledger = page.getByRole("table", { name: "General ledger: 1111 Cash in hand" });
  await expect(ledger.getByRole("row")).toHaveText([
    /Date\s*Document\s*Description\s*Debit\s*Credit\s*Balance/,
    /Opening balance\s*Nil/,
    new RegExp(`${shown}\\s*JV-0001\\s*Owner's money put in\\s*5,00,000.00\\s*5,00,000.00 Dr`),
    new RegExp(`${shown}\\s*JV-0002\\s*Shop rent\\s*40,000.00\\s*4,60,000.00 Dr`),
    new RegExp(`${shown}\\s*JV-0003\\s*Cash sale\\s*12,500.50\\s*4,72,500.50 Dr`),
    /Closing balance\s*5,12,500.50\s*40,000.00\s*4,72,500.50 Dr/,
  ]);
});

test("a report downloads as Excel and as CSV, and prints on the company's letterhead", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/reports/trial-balance");
  const csvLink = await page.getByRole("link", { name: "Download CSV" }).getAttribute("href");
  const excelLink = await page.getByRole("link", { name: "Download Excel" }).getAttribute("href");
  expect(csvLink).toContain("report=trial-balance");

  const csv = await page.request.get(csvLink!);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(csv.headers()["content-disposition"]).toMatch(/attachment; filename="trial-balance-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
  const text = (await csv.text()).replace(/^\ufeff/, "").split("\r\n");
  expect(text.slice(0, 2)).toEqual(["E2E Report Traders", "Trial balance"]);
  expect(text[4]).toBe("Code,Account,Opening debit,Opening credit,Debits,Credits,Closing debit,Closing credit");
  expect(text).toContain("1111,Cash in hand,,,512500.50,40000.00,472500.50,");
  expect(text).toContain(",Total,0.00,0.00,552500.50,552500.50,512500.50,512500.50");

  const excel = await page.request.get(excelLink!);
  expect(excel.status()).toBe(200);
  expect(excel.headers()["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const bytes = await excel.body();
  // An Excel file is a zip archive: it starts with "PK".
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  expect(bytes.length).toBeGreaterThan(2000);
  // Anything else asked of the address is simply not found.
  expect((await page.request.get("/reports/export?report=cash-flow&format=csv")).status()).toBe(404);
  expect((await page.request.get("/reports/export?report=trial-balance&format=pdf")).status()).toBe(404);

  await page.getByRole("link", { name: "Print" }).click();
  await expect(page).toHaveURL(/\/print\/reports\/trial-balance\?/);
  await expect(page.getByTestId("print-header")).toContainText("E2E Report Traders");
  await expect(page.getByRole("heading", { name: "Trial balance" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Trial balance" }).getByRole("row").last()).toHaveText(/Total\s*0.00\s*0.00\s*5,52,500.50\s*5,52,500.50/);
  await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
  // The menu is not part of a printed page.
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
});

test("an auditor reads the reports; a salesperson has no way in, by screen or by address", async ({ page }) => {
  await signIn(page, auditor);
  await page.goto("/reports/profit-and-loss");
  await expect(page.getByRole("table", { name: "Profit and loss" }).getByRole("row").last()).toHaveText(/Net loss/);

  await page.context().clearCookies();
  await signIn(page, seller);
  await page.goto("/reports");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see the ledger reports.")).toBeVisible();
  await page.goto("/reports/trial-balance");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see the ledger reports.").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("table", { name: "Trial balance" })).toHaveCount(0);
  expect((await page.request.get("/reports/export?report=trial-balance&format=csv")).status()).toBe(404);
  // The printed page shows them nothing either: no letterhead, no table, no figures.
  await page.goto("/print/reports/trial-balance");
  await expect(page.getByRole("table", { name: "Trial balance" })).toHaveCount(0);
  await expect(page.getByTestId("print-header")).toHaveCount(0);
  await expect(page.getByText("5,12,500.50")).toHaveCount(0);
});
