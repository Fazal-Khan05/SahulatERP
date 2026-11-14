import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { seedStock } from "../tests/support/stock";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 33 on screen: an invoice that is overdue shows on the overdue list and in the aged
// receivables, for the same amount; the recovery officer writes down a promise and a follow-up,
// and prints the customer's statement and downloads its PDF. The figures over a fuller history,
// and what each role may do, are tested in src/modules/recovery/recovery.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let collector: TestUser;
let customerId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("recovery-owner", { canCreateCompany: true });
  collector = await createUser("recovery-collector", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
const rail = (page: Page) => page.getByRole("navigation", { name: "Main" });
const ISSUED = "2026-10-01";
/** A day from today in Pakistan, the app's own date, as YYYY-MM-DD. */
const inDays = (days: number) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) + days)).toISOString().slice(0, 10);
};

test("an overdue invoice shows on the overdue list and in the aged receivables, for the same amount", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Recovery Traders");
  const [{ id: tenantId }] = await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${collector.id}, ${collector.email}, 'recovery_officer', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  const [item] = await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'HL-1', 'Helmet', ${unit.id}, 1000, ${owner.id}, ${owner.id}) returning id`;
  const [customer] = await sql`insert into public.customers (tenant_id, name, code, credit_days, created_by, updated_by) values (${tenantId}, 'Khan Autos', 'C-001', 15, ${owner.id}, ${owner.id}) returning id`;
  customerId = customer.id;
  const [warehouse] = await sql`select id from public.warehouses where tenant_id = ${tenantId}`;
  await seedStock(sql, { tenantId, itemId: item.id, warehouseId: warehouse.id, quantity: "10", value: "6000", userId: owner.id });

  // An order and its invoice dated 1 October, with 15 days' credit: overdue since the 16th.
  await page.goto("/sales/new?kind=order");
  await page.getByLabel("Date", { exact: true }).fill(ISSUED);
  const picked = page.getByRole("combobox", { name: "Customer", exact: true });
  await picked.fill("C-001");
  await picked.press("Tab");
  await expect(picked).toHaveAttribute("data-picked", "true");
  const line = page.getByRole("combobox", { name: "Item, line 1", exact: true });
  await line.fill("HL-1");
  await line.press("Tab");
  await expect(line).toHaveAttribute("data-picked", "true");
  await page.getByLabel("Quantity, line 1", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Submit order" }).click();
  await expect(page.getByRole("heading", { name: "SO-2627-00001" })).toBeVisible();
  await page.getByRole("button", { name: "Invoice and deliver now" }).click();
  await expect(page.getByRole("heading", { name: "Draft sales invoice" })).toBeVisible();
  await shown(page.getByLabel("Date of invoice")).fill(ISSUED);
  // A changed draft is saved and shown first; the second press posts it.
  await page.getByRole("button", { name: "Post invoice" }).click();
  await page.getByRole("button", { name: "Post invoice" }).click();
  await expect(page.getByRole("heading", { name: "SI-2627-00001" })).toBeVisible();

  // Collections opens the overdue list; the aged receivables show the same 3,000 past due.
  await rail(page).getByRole("link", { name: "Collections", exact: true }).click();
  await expect(page).toHaveURL(/\/recovery\/overdue$/);
  const overdue = shown(page.getByRole("table", { name: "Overdue customers" })).locator("tbody tr");
  await expect(overdue).toHaveCount(1);
  await expect(overdue.first()).toContainText("Khan Autos");
  await expect(visible(page, "overdue-total")).toHaveText("3,000.00");
  await page.getByRole("navigation", { name: "Collections" }).getByRole("link", { name: "Aged receivables" }).click();
  const aged = shown(page.getByRole("table", { name: "Aged receivables" }));
  const khan = aged.locator("tbody tr").filter({ hasText: "Khan Autos" });
  await expect(khan).toContainText("3,000.00");
  // Nothing is "not due yet": all of it is in one overdue band.
  await expect(khan.locator("td").nth(2)).toHaveText("");
  const file = await page.request.get("/recovery/ageing/export?format=csv");
  expect(file.status()).toBe(200);
  expect(await file.text()).toContain("Khan Autos");
});

test("the recovery officer notes a promise and a follow-up, and prints the statement", async ({ page }) => {
  await signIn(page, collector);
  await rail(page).getByRole("link", { name: "Overdue customers", exact: true }).click();
  await shown(page.getByRole("table", { name: "Overdue customers" })).getByRole("link", { name: "Khan Autos" }).click();
  await expect(page.getByRole("heading", { name: "Khan Autos" })).toBeVisible();

  await page.getByLabel("Amount promised").fill("2000");
  await page.getByLabel("To pay by").fill(inDays(3));
  await page.getByLabel("Note", { exact: true }).fill("By cheque");
  await page.getByRole("button", { name: "Save promise" }).click();
  await expect(shown(page.getByRole("list", { name: "Promises to pay" })).locator("li")).toHaveCount(1);
  await expect(shown(page.getByRole("list", { name: "Promises to pay" }))).toContainText("Waiting");

  await page.getByLabel("What was said").fill("Called; cheque promised for Friday");
  await page.getByLabel("Follow up again on").fill(inDays(0));
  await page.getByRole("button", { name: "Save follow-up" }).click();
  await expect(shown(page.getByRole("list", { name: "Follow-ups" })).locator("li")).toHaveCount(1);

  // Today's follow-ups list the customer; the promise is still to come.
  await rail(page).getByRole("link", { name: "Follow-ups", exact: true }).click();
  await expect(shown(page.getByRole("list", { name: "To follow up today" }))).toContainText("Khan Autos");
  await expect(shown(page.getByRole("table", { name: "Promises still to come" }))).toContainText("2,000.00");

  // The statement, from the books: the invoice, and 3,000 owed at the end.
  await page.goto(`/recovery/statements?customer=${customerId}&from=2026-10-01&to=${inDays(0)}`);
  await expect(shown(page.getByRole("table", { name: "Statement" })).locator("tbody tr").filter({ hasText: "SI-2627-00001" })).toContainText("3,000.00");
  await expect(visible(page, "statement-closing")).toHaveText("3,000.00");
  // The menu marks the page the officer is on, and only that one.
  await expect(rail(page).getByRole("link", { name: "Customer statements", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(rail(page).getByRole("link", { name: "Overdue customers", exact: true })).not.toHaveAttribute("aria-current", "page");
  await expect(visible(page, "email-not-set-up")).toBeVisible();
  const pdf = await page.request.get(`/print/statement/${customerId}/pdf?from=2026-10-01&to=${inDays(0)}`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(Buffer.from(await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  await visible(page, "statement-print").click();
  await expect(page.getByTestId("print-header")).toContainText("E2E Recovery Traders");
  await expect(page.getByTestId("statement-customer")).toHaveText("Khan Autos");
});
