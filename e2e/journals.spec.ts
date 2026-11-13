import { expect, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, railLabels, signIn, test } from "./support/ui";

// Steps 13 and 14 on screen: a manual journal is drafted, posted into the books with its number,
// refused in a locked month, and reversed. The engine itself is tested in src/modules/ledger.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let accountant: TestUser;
let auditor: TestUser;
let seller: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("journal-owner", { canCreateCompany: true });
  accountant = await createUser("journal-accountant", { canCreateCompany: false });
  auditor = await createUser("journal-auditor", { canCreateCompany: false });
  seller = await createUser("journal-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

/** Fills one row of the lines grid; rows are numbered from 1. */
async function fillLine(page: Page, row: number, account: string, debit: string, credit: string, description = "") {
  await page.getByLabel(`Account, line ${row}`).selectOption({ label: account });
  if (description) await page.getByLabel(`Description, line ${row}`).fill(description);
  await page.getByLabel(`Debit, line ${row}`).fill(debit);
  await page.getByLabel(`Credit, line ${row}`).fill(credit);
}

test("an owner drafts a journal, posts it and finds it in the books", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Journal Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id}),
    (${tenantId}, ${auditor.id}, ${auditor.email}, 'auditor', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Journals" }).click();
  await expect(page.getByText("No journals yet.")).toBeVisible();
  await page.getByRole("link", { name: "New journal" }).click();
  await expect(page).toHaveURL(/\/journals\/new$/);

  // The accounts kept by their own documents are not offered; this company sees no sales tax accounts.
  await expect(page.getByLabel("Account, line 1").locator("option", { hasText: "5230 Rent" })).toHaveCount(1);
  const options = await page.getByLabel("Account, line 1").locator("option").allTextContents();
  expect(options).toContain("5230 Rent");
  expect(options).not.toContain("1200 Trade receivables");
  expect(options).not.toContain("5200 Operating expenses");
  expect(options.join("|")).not.toContain("Sales tax");

  await page.getByLabel("Date").fill("2026-11-02");
  await page.getByLabel("What it is for").fill("Shop rent for November 2026, paid in cash");
  await fillLine(page, 1, "5230 Rent", "40000", "", "November rent");
  await fillLine(page, 2, "1111 Cash in hand", "", "39000");
  await expect(page.getByTestId("balance-note")).toHaveText("Debits and credits differ by 1,000.00: credits are short.");

  // Posting what does not balance keeps it as a draft and says why.
  await page.getByRole("button", { name: "Post journal" }).click();
  await expect(page).toHaveURL(/\/journals\/[0-9a-f-]{36}\?refused=1$/);
  await expect(page.getByTestId("form-error")).toHaveText("Saved as a draft, but not posted. The journal does not balance: debits are 40,000.00 and credits are 39,000.00.");
  await expect(page.getByRole("heading", { name: "Draft journal" })).toBeVisible();
  expect((await sql`select count(*)::int as n from public.journals where tenant_id = ${tenantId}`)[0].n).toBe(0);

  // Corrected, with a third line added, it posts and takes the first number.
  await page.getByLabel("Credit, line 2").fill("38500");
  await page.getByRole("button", { name: "Add a line" }).click();
  await fillLine(page, 3, "1111 Cash in hand", "", "1500", "Paid the next day");
  await expect(page.getByTestId("balance-note")).toHaveText("Debits equal credits.");
  await page.getByRole("button", { name: "Post journal" }).click();
  await expect(page.getByRole("heading", { name: "JV-2627-00001" })).toBeVisible();
  await expect(page.getByTestId("journal-status").filter({ visible: true })).toHaveText("Posted");
  const lines = page.getByRole("table", { name: "Journal lines" });
  await expect(lines.getByRole("row")).toHaveText([/Account\s*Description\s*Debit\s*Credit/, /5230 Rent\s*November rent\s*40,000.00/, /1111 Cash in hand\s*38,500.00/, /1111 Cash in hand\s*Paid the next day\s*1,500.00/, /Total\s*40,000.00\s*40,000.00/]);
  await expect(page.getByRole("button", { name: "Save as draft" })).toHaveCount(0);

  const booked = await sql`
    select j.document_number, j.journal_date::text as date, a.code, l.debit::text as debit, l.credit::text as credit
    from public.journals j
    join public.journal_lines l on l.tenant_id = j.tenant_id and l.journal_id = j.id
    join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
    where j.tenant_id = ${tenantId} order by l.line_no`;
  expect(booked.map((b) => `${b.document_number} ${b.date} ${b.code} ${b.debit} ${b.credit}`)).toEqual([
    "JV-2627-00001 2026-11-02 5230 40000.0000 0.0000",
    "JV-2627-00001 2026-11-02 1111 0.0000 38500.0000",
    "JV-2627-00001 2026-11-02 1111 0.0000 1500.0000",
  ]);

  await page.goto("/journals");
  await expect(page.getByRole("table", { name: "Journals" }).getByRole("row").nth(1)).toHaveText(/JV-2627-00001\s*02-11-2026\s*Shop rent for November 2026, paid in cash\s*40,000.00\s*Posted/);
});

test("posting into a locked month is refused with a clear message", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/settings/periods");
  await page.getByRole("button", { name: "Lock August 2026" }).click();
  await expect(page.getByRole("table", { name: "Fiscal year 2026-27" }).getByRole("row").nth(2)).toContainText("Locked");

  await page.goto("/journals/new");
  await page.getByLabel("Date").fill("2026-08-15");
  await page.getByLabel("What it is for").fill("August rent, entered late");
  await fillLine(page, 1, "5230 Rent", "40000", "");
  await fillLine(page, 2, "1111 Cash in hand", "", "40000");
  await page.getByRole("button", { name: "Post journal" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("Saved as a draft, but not posted. The period August 2026 is locked. An owner can unlock it under Settings, Fiscal periods.");
  await expect(page.getByRole("heading", { name: "Draft journal" })).toBeVisible();
  // Nothing reached the books and no number was used.
  expect((await sql`select count(*)::int as n from public.journals where tenant_id = ${tenantId}`)[0].n).toBe(1);

  // Trying again from the saved draft, with the reason changed, saves the change and gives the same answer.
  await page.getByLabel("What it is for").fill("August rent, entered late (second try)");
  await page.getByRole("button", { name: "Post journal" }).click();
  await expect(page.getByRole("button", { name: "Post journal" })).toBeEnabled();
  await expect(page.getByTestId("form-error")).toHaveText("Saved as a draft, but not posted. The period August 2026 is locked. An owner can unlock it under Settings, Fiscal periods.");
  expect((await sql`select memo from public.manual_journals where tenant_id = ${tenantId} and status = 'draft'`).map((r) => r.memo)).toEqual(["August rent, entered late (second try)"]);
  // Only what the page itself works out is shown: text put in the address is not.
  await page.goto(page.url().replace("refused=1", "refused=Call%20this%20number"));
  await expect(page.getByTestId("form-error")).toHaveText("Saved as a draft, but not posted. The period August 2026 is locked. An owner can unlock it under Settings, Fiscal periods.");

  // The draft is thrown away; the next journal to post still gets the next number.
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(page).toHaveURL(/\/journals$/);
  await expect(page.getByRole("table", { name: "Journals" }).getByRole("row")).toHaveCount(2);
});

test("an accountant reverses a posted journal; an auditor only reads; a salesperson has no way in", async ({ page }) => {
  await signIn(page, accountant);
  expect(await railLabels(page)).toContain("Journals");
  await page.goto("/journals");
  await page.getByRole("link", { name: "JV-2627-00001" }).click();
  const reverse = page.locator("form").filter({ has: page.getByRole("button", { name: "Reverse journal" }) });
  // A reversal cannot be dated before the journal it reverses.
  await reverse.getByLabel("Date of the reversal").fill("2026-11-10");
  await reverse.getByRole("button", { name: "Reverse journal" }).click();
  await expect(page.getByTestId("journal-status").filter({ visible: true })).toHaveText("Reversed");
  await expect(page.getByRole("button", { name: "Reverse journal" })).toHaveCount(0);

  const booked = await sql`
    select j.source_type, j.journal_date::text as date, j.document_number, sum(l.debit)::text as debit, sum(l.credit)::text as credit
    from public.journals j join public.journal_lines l on l.tenant_id = j.tenant_id and l.journal_id = j.id
    where j.tenant_id = ${tenantId} group by j.id order by j.created_at`;
  expect(booked.map((b) => `${b.source_type} ${b.date} ${b.document_number} ${b.debit} ${b.credit}`)).toEqual([
    "manual_journal 2026-11-02 JV-2627-00001 40000.0000 40000.0000",
    "reversal 2026-11-10 null 40000.0000 40000.0000",
  ]);
  // Together they leave nothing on any account.
  const left = await sql`select account_id from public.journal_lines where tenant_id = ${tenantId} group by account_id having sum(debit) <> sum(credit)`;
  expect(left).toHaveLength(0);
  const audited = await sql`select action from public.audit_log where tenant_id = ${tenantId} and (action like 'manual_journal.%' or action like 'journal.%') order by at, action`;
  expect(audited.map((a) => a.action)).toEqual([
    "manual_journal.create",
    "manual_journal.update",
    "journal.post",
    "manual_journal.post",
    "manual_journal.create",
    "manual_journal.update",
    "manual_journal.discard",
    "journal.reverse",
    "manual_journal.reverse",
  ]);

  await page.context().clearCookies();
  await signIn(page, auditor);
  await page.goto("/journals");
  await expect(page.getByRole("link", { name: "New journal" })).toHaveCount(0);
  await page.getByRole("link", { name: "JV-2627-00001" }).click();
  await expect(page.getByRole("table", { name: "Journal lines" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reverse journal" })).toHaveCount(0);
  await page.goto("/journals/new");
  await expect(page.getByText("Only an owner or an accountant can write journals.")).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, seller);
  expect(await railLabels(page)).not.toContain("Journals");
  await page.goto("/journals");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see journals.")).toBeVisible();
});
