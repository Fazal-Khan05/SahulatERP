import { expect, type Locator, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 35 on screen: the owner banks cash and draws some back, imports the bank's statement as an
// Excel workbook (two of its three lines matched at once, the books reconciled with the bank; a
// CSV file is read by the same rules, tested in src/modules/bank-reconciliation), unmatches one line
// and has it matched again; the auditor reads the reconciliation and changes nothing. What each
// of these does, the acceptance among them, is tested against the database in
// src/modules/bank-reconciliation.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let auditor: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("reconcile-owner", { canCreateCompany: true });
  auditor = await createUser("reconcile-auditor", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const label = (page: Page, text: string) => shown(page.getByLabel(text, { exact: true }));
const tabs = (page: Page) => shown(page.getByRole("navigation", { name: "Cash and bank" }));
/** Today in Pakistan, as a day in Excel. */
const today = () => new Date(`${new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10)}T00:00:00Z`);
/**
 * The bank's statement as its internet banking gives it in Excel: days as days, money as numbers
 * (a fixture: Excel itself keeps a binary fraction), the cheque number as text.
 */
async function statement(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Statement");
  sheet.addRows([
    ["Habib Bank Limited"],
    ["Account Title", "E2E Reconcile Traders"],
    [],
    ["Transaction Date", "Transaction Details", "Cheque No.", "Debit", "Credit", "Balance"],
    [today(), "Opening Balance", null, null, null, 0],
    [today(), "Cash deposit", null, null, 50000, 50000],
    [today(), "Cash withdrawal", "000412", 20000, null, 30000],
    [today(), "Bank charges", null, 250, null, 29750],
  ]);
  sheet.getColumn(1).numFmt = "dd/mm/yyyy";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("the owner imports the bank's Excel statement and the books reconcile with it", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Reconcile Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id})`;

  // A bank account, 50,000 banked from the cash in hand, and 20,000 drawn back.
  await page.goto("/cash-bank");
  await label(page, "Kind").selectOption("bank");
  await label(page, "Name").fill("HBL current account");
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByRole("table", { name: "Cash and bank accounts" })).toContainText("HBL current account");
  await tabs(page).getByRole("link", { name: "Transfers" }).click();
  for (const [index, [from, to, amount]] of [
    ["1111 Cash in hand", "1121 HBL current account", "50000"],
    ["1121 HBL current account", "1111 Cash in hand", "20000"],
  ].entries()) {
    await label(page, "From").selectOption({ label: from });
    await label(page, "To").selectOption({ label: to });
    await label(page, "Amount").fill(amount);
    await page.getByRole("button", { name: "Record transfer" }).click();
    await expect(page.getByText(new RegExp(`^Recorded as TR-\\d{4}-0000${index + 1}\\.$`))).toBeVisible();
  }

  await tabs(page).getByRole("link", { name: "Reconcile" }).click();
  await page.getByRole("link", { name: "1121 HBL current account" }).click();
  await expect(page.getByRole("heading", { name: "Reconcile 1121 HBL current account" })).toBeVisible();
  await label(page, "CSV or Excel file").setInputFiles({
    name: "hbl.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: await statement(),
  });
  await label(page, "The bank").selectOption("hbl");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("Imported 3 lines; 2 were matched with the books.")).toBeVisible();
  // The bank charges are on the statement, not in the books: explained, so reconciled.
  await expect(page.getByRole("table", { name: "Statement lines to match" })).toContainText("Bank charges");
  await expect(shown(page.getByTestId("reconcile-verdict"))).toContainText("Reconciled: the books, with what is still to come through, equal the bank.");
  const figures = page.getByLabel("Reconciliation");
  await expect(figures).toContainText("29,750.00");
  await expect(figures).toContainText("30,000.00");

  // A match taken back, and found again.
  await page.getByRole("list", { name: "Matches" }).getByRole("button", { name: "Unmatch" }).first().click();
  await expect(page.getByRole("list", { name: "Matches" }).getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Match what is sure" }).click();
  await expect(page.getByRole("list", { name: "Matches" }).getByRole("listitem")).toHaveCount(2);
  const [lines] = await sql<{ n: number }[]>`select count(*)::int as n from public.bank_statement_lines where tenant_id = ${tenantId} and match_id is not null`;
  expect(lines.n).toBe(2);
});

test("the auditor reads the reconciliation and changes nothing", async ({ page }) => {
  await signIn(page, auditor);
  await page.goto("/cash-bank/reconcile");
  await page.getByRole("link", { name: "1121 HBL current account" }).click();
  await expect(shown(page.getByTestId("reconcile-verdict"))).toContainText("Reconciled");
  await expect(page.getByRole("button", { name: "Import" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unmatch" })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});
