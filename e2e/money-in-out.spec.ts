import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Money in and Money out on screen (batch A): the owner records capital put into cash and drawings
// taken out of it, cancels one entered by mistake, and finds it in the account's ledger; the
// auditor reads them and cannot record; a salesperson has no way in. What each posts and what the
// database refuses are tested in src/modules/money-in-out.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let auditor: TestUser;
let seller: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("money-owner", { canCreateCompany: true });
  auditor = await createUser("money-auditor", { canCreateCompany: false });
  seller = await createUser("money-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const label = (page: Page, text: string) => shown(page.getByLabel(text, { exact: true }));
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);

test("the owner records capital put in and drawings taken out, and cancels one", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Money Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;

  await page.goto("/cash-bank");
  await shown(page.getByRole("navigation", { name: "Cash and bank" })).getByRole("link", { name: "Money in" }).click();
  await expect(page.getByRole("heading", { name: "Money in", exact: true })).toBeVisible();
  await label(page, "Into").selectOption({ label: "1111 Cash in hand" });
  await label(page, "What it is").selectOption({ label: "3100 Owner's capital" });
  await label(page, "Amount").fill("250,000");
  await label(page, "Received from").fill("The owner");
  await label(page, "Reference (cheque or slip no.)").fill("Slip 7");
  await page.getByRole("button", { name: "Record money in" }).click();
  await expect(page.getByText("Recorded as MI-2627-00001.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Money in" })).toContainText("The owner");
  expect(await journal("MI-2627-00001")).toEqual(["1111 250000 0", "3100 0 250000"]);

  await shown(page.getByRole("navigation", { name: "Cash and bank" })).getByRole("link", { name: "Money out" }).click();
  await expect(page.getByRole("heading", { name: "Money out", exact: true })).toBeVisible();
  // Expenses have a form of their own and are not offered here.
  const choices = await label(page, "What it is").locator("option").allTextContents();
  expect(choices).toContain("3200 Drawings");
  expect(choices.some((text) => /^5\d{3} /.test(text))).toBe(false);
  await label(page, "Out of").selectOption({ label: "1111 Cash in hand" });
  await label(page, "What it is").selectOption({ label: "3200 Drawings" });
  await label(page, "Amount").fill("15000");
  await label(page, "Paid to").fill("The owner");
  await page.getByRole("button", { name: "Record money out" }).click();
  await expect(page.getByText("Recorded as MO-2627-00001.")).toBeVisible();
  expect(await journal("MO-2627-00001")).toEqual(["3200 15000 0", "1111 0 15000"]);

  await page.getByRole("link", { name: "MO-2627-00001" }).click();
  await expect(page.getByRole("heading", { name: "MO-2627-00001" })).toBeVisible();
  await expect(page.getByRole("table", { name: "In the books" })).toContainText("3200 Drawings");
  await label(page, "Why").fill("Entered twice");
  await page.getByRole("button", { name: "Cancel entry" }).click();
  await expect(shown(page.getByTestId("document-status"))).toContainText("Cancelled: Entered twice.");
  await expect(page.getByRole("table", { name: "Taken back" })).toBeVisible();

  // The cash account's ledger shows both, with their numbers.
  await page.goto("/reports/general-ledger");
  await page.getByLabel("Account").selectOption({ label: "1111 Cash in hand" });
  await page.getByRole("button", { name: "Show" }).click();
  const ledger = page.getByRole("table", { name: "General ledger: 1111 Cash in hand" });
  await expect(ledger).toContainText("MI-2627-00001");
  await expect(ledger).toContainText("MO-2627-00001");
  await expect(ledger).toContainText("Reversal of MO-2627-00001");
});

test("the auditor reads them and cannot record", async ({ page }) => {
  await signIn(page, auditor);
  await page.goto("/cash-bank/money-in");
  await expect(page.getByRole("table", { name: "Money in" })).toContainText("MI-2627-00001");
  await expect(page.getByRole("button", { name: "Record money in" })).toHaveCount(0);
});

test("a salesperson has no way in", async ({ page }) => {
  await signIn(page, seller);
  await page.goto("/cash-bank/money-out");
  await expect(page.getByText("Your role does not include cash and bank.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Record money out" })).toHaveCount(0);
});
