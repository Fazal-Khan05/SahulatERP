import { expect, type Locator, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, signIn, test } from "./support/ui";

// Step 30 on screen: an owner brings opening stock in, the warehouse transfers some of it and
// counts the shelves, and the owner posts the differences and writes a broken item off. What
// each of these posts is tested against the database in src/modules/inventory.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let keeper: TestUser;
let tenantId: string;
let mainName: string;
let countUrl: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("stock-owner", { canCreateCompany: true });
  keeper = await createUser("stock-keeper", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

// A page visited earlier stays in the document, hidden: only what is on screen is looked at.
const shown = (locator: Locator) => locator.filter({ visible: true });
const visible = (page: Page, testId: string) => shown(page.getByTestId(testId));
const rail = (page: Page) => page.getByRole("navigation", { name: "Main" });
const stock = async (code: string, warehouse: string) => {
  const [row] = await sql`
    select b.quantity::text, b.value::text from public.stock_balances b
    join public.items i on i.id = b.item_id join public.warehouses w on w.id = b.warehouse_id
    where b.tenant_id = ${tenantId} and i.code = ${code} and w.name = ${warehouse}`;
  return row ? `${Number(row.quantity)} worth ${Number(row.value)}` : "none";
};
const journal = async (number: string) =>
  (
    await sql<{ line: string }[]>`
      select a.code || ' ' || trim_scale(l.debit)::text || ' ' || trim_scale(l.credit)::text as line from public.journals j
      join public.journal_lines l on l.journal_id = j.id join public.accounts a on a.id = l.account_id
      where j.tenant_id = ${tenantId} and j.document_number = ${number} order by l.line_no`
  ).map((row) => row.line);

async function fillLine(page: Page, row: number, code: string, quantity: string, cost?: string) {
  await shown(page.getByLabel(`Item code, line ${row}`, { exact: true })).fill(code);
  await shown(page.getByLabel(`Quantity, line ${row}`, { exact: true })).fill(quantity);
  if (cost !== undefined) await shown(page.getByLabel(`Cost of one, line ${row}`, { exact: true })).fill(cost);
}

test("an owner brings in opening stock, by hand and from a file", async ({ page }) => {
  await signIn(page, owner);
  await createCompany(page, "E2E Stock Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values (${tenantId}, ${keeper.id}, ${keeper.email}, 'warehouse_manager', ${owner.id})`;
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  for (const [code, name] of [["HL-1", "Helmet"], ["CH-2", "Chain"], ["GR-3", "Grip"]]) {
    await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, ${code}, ${name}, ${unit.id}, 100, ${owner.id}, ${owner.id})`;
  }
  const [main] = await sql<{ name: string; branch_id: string }[]>`select name, branch_id from public.warehouses where tenant_id = ${tenantId}`;
  mainName = main.name;
  await sql`insert into public.warehouses (tenant_id, branch_id, name, created_by) values (${tenantId}, ${main.branch_id}, 'City store', ${owner.id})`;

  await rail(page).getByRole("link", { name: "Stock", exact: true }).click();
  await expect(page).toHaveURL(/\/stock$/);
  await expect(page.getByText("Nothing is in stock yet.")).toBeVisible();
  await page.getByRole("navigation", { name: "Stock" }).getByRole("link", { name: "Adjustments and opening stock" }).click();
  await expect(page.getByText("No adjustments or opening stock yet.")).toBeVisible();
  await page.getByRole("link", { name: "Enter opening stock" }).click();
  await expect(page.getByRole("heading", { name: "Opening stock", exact: true })).toBeVisible();

  // The item's name shows beside its code as it is typed; a code that is no item says so.
  await page.getByLabel("Warehouse", { exact: true }).first().selectOption({ label: mainName });
  await fillLine(page, 1, "HL-1", "10", "600");
  await expect(visible(page, "item-name-1")).toHaveText("Helmet (pc)");
  await fillLine(page, 2, "XX-9", "1", "1");
  await expect(visible(page, "item-name-2")).toHaveText("No item has this code");
  await page.getByRole("button", { name: "Post opening stock" }).click();
  await expect(visible(page, "form-error")).toHaveText("Line 2: there is no item with the code XX-9.");
  await fillLine(page, 2, "CH-2", "20", "270");
  await page.getByRole("button", { name: "Post opening stock" }).click();
  await expect(page.getByRole("heading", { name: "SA-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  await expect(visible(page, "adjustment-total")).toHaveText("11,400.00");
  expect(await stock("HL-1", mainName)).toBe("10 worth 6000");
  expect(await journal("SA-2627-00001")).toEqual(["1300 11400 0", "3900 0 11400"]);

  // From a file: a wrong row is named and nothing is kept; a right file opens as a draft to look over.
  await page.goto("/stock/adjustments/new?kind=opening");
  await page.locator("#import-warehouse").selectOption({ label: "City store" });
  await page.locator("#import-file").setInputFiles({ name: "opening.csv", mimeType: "text/csv", buffer: Buffer.from("Item code,Quantity,Unit cost\nGR-3,40,12.5\nZZ-1,5,1\n") });
  await page.getByRole("button", { name: "Read the file" }).click();
  await expect(visible(page, "import-problems")).toContainText("There is no item with this code.");
  await page.locator("#import-file").setInputFiles({ name: "opening.csv", mimeType: "text/csv", buffer: Buffer.from("Item code,Quantity,Unit cost\nGR-3,40,12.5\n") });
  await page.getByRole("button", { name: "Read the file" }).click();
  await expect(page.getByRole("heading", { name: "Draft opening stock" })).toBeVisible();
  await expect(shown(page.getByLabel("Item code, line 1", { exact: true }))).toHaveValue("GR-3");
  await expect(shown(page.getByLabel("Cost of one, line 1", { exact: true }))).toHaveValue("12.5");
  await page.getByRole("button", { name: "Post opening stock" }).click();
  await expect(page.getByRole("heading", { name: "SA-2627-00002" })).toBeVisible();
  expect(await stock("GR-3", "City store")).toBe("40 worth 500");

  // What the warehouses hold, and the way there for an accountant, whose menu has no Stock entry.
  await page.goto("/stock");
  const onHand = page.getByRole("table", { name: "Stock on hand" });
  await expect(onHand.locator("tbody tr")).toHaveCount(3);
  await expect(onHand.locator("tbody tr").filter({ hasText: "HL-1" })).toContainText("10");
  await page.goto("/reports");
  await expect(page.getByRole("list", { name: "Stock" }).getByRole("link", { name: "Stock on hand" })).toHaveAttribute("href", "/stock");
});

test("the warehouse transfers stock and counts the shelves, without seeing what stock costs", async ({ page }) => {
  await signIn(page, keeper);
  await rail(page).getByRole("link", { name: "Transfers", exact: true }).click();
  await expect(page).toHaveURL(/\/stock\/transfers$/);
  await page.getByRole("link", { name: "New transfer" }).click();
  await page.getByLabel("From warehouse").selectOption({ label: mainName });
  await page.getByLabel("To warehouse").selectOption({ label: "City store" });
  // More than the warehouse holds is refused, and the draft keeps what was typed.
  await fillLine(page, 1, "HL-1", "40");
  await page.getByRole("button", { name: "Post transfer" }).click();
  await expect(page.getByRole("heading", { name: "Draft transfer" })).toBeVisible();
  await expect(visible(page, "form-error")).toContainText("Saved as a draft, but not posted.");
  await fillLine(page, 1, "HL-1", "4");
  await page.getByRole("button", { name: "Post transfer" }).click();
  await expect(page.getByRole("heading", { name: "ST-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  expect(await stock("HL-1", mainName)).toBe("6 worth 3600");
  expect(await stock("HL-1", "City store")).toBe("4 worth 2400");
  expect(await journal("ST-2627-00001")).toEqual([]);

  // Adjustments are not the warehouse's: no way in from the stock screens, and none by the address.
  await page.goto("/stock");
  await expect(page.getByRole("navigation", { name: "Stock" }).getByRole("link", { name: "Adjustments and opening stock" })).toHaveCount(0);
  await page.goto("/stock/adjustments");
  await expect(page.getByText("Only an owner, an accountant or an auditor can see stock adjustments.")).toBeVisible();

  // The count: a sheet of what the books say the warehouse holds, without the figures.
  await rail(page).getByRole("link", { name: "Stock count", exact: true }).click();
  await expect(page).toHaveURL(/\/stock\/counts$/);
  await page.getByLabel("Warehouse to count").selectOption({ label: mainName });
  await page.getByRole("button", { name: "Start count" }).click();
  await expect(page.getByRole("heading", { name: `Count of ${mainName}` })).toBeVisible();
  countUrl = new URL(page.url()).pathname;
  await expect(page.getByRole("columnheader", { name: "Books say" })).toHaveCount(0);
  await expect(visible(page, "count-progress")).toContainText("0 of 2 counted.");
  // One helmet is missing; the chains are all there.
  await shown(page.getByLabel("Counted, HL-1", { exact: true })).fill("5");
  await shown(page.getByLabel("Counted, CH-2", { exact: true })).fill("20");
  await page.getByRole("button", { name: "Finish counting" }).click();
  await expect(visible(page, "document-status")).toHaveText("Finished, to be posted");
  // The warehouse cannot post it; it can take it back.
  await expect(page.getByRole("button", { name: /Post count/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Take back" })).toBeVisible();
  expect(await stock("HL-1", mainName)).toBe("6 worth 3600");

  // The sheet for the shelves, on the company's letterhead, without what the books say.
  await page.goto(`/print/stock-count/${countUrl.split("/").pop()}`);
  await expect(page.getByRole("heading", { name: "Stock count sheet" })).toBeVisible();
  await expect(page.getByTestId("print-header")).toBeVisible();
  await expect(page.getByRole("table", { name: "Count sheet" }).locator("tbody tr").filter({ hasText: "HL-1" })).toHaveCount(1);
});

test("the owner posts the count's differences to the stock adjustments account", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/inbox");
  await page.getByRole("list", { name: "Waiting on you" }).getByRole("link", { name: `Post or send back: stock count of ${mainName}` }).click();
  await expect(page).toHaveURL(new RegExp(`${countUrl}$`));
  const sheet = shown(page.getByRole("table", { name: "Count sheet" }));
  await expect(sheet.locator("tbody tr").filter({ hasText: "HL-1" })).toContainText("-1");
  await page.getByRole("button", { name: "Post count", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SC-2627-00001" })).toBeVisible();
  await expect(visible(page, "document-status")).toHaveText("Posted");
  // One helmet short, at its average cost of 600: out of stock, into Stock adjustments.
  expect(await stock("HL-1", mainName)).toBe("5 worth 3000");
  expect(await journal("SC-2627-00001")).toEqual(["5110 600 0", "1300 0 600"]);
  await page.goto("/inbox");
  await expect(page.getByText("Nothing needs your attention.")).toBeVisible();
});

test("the owner is asked which came first when stock moved after the shelves were counted", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/stock/counts");
  await page.getByLabel("Warehouse to count").selectOption({ label: mainName });
  await page.getByRole("button", { name: "Start count" }).click();
  await expect(page.getByRole("heading", { name: `Count of ${mainName}` })).toBeVisible();
  const sheetUrl = new URL(page.url()).pathname;
  // The owner sees what the books say beside each line. Nineteen chains counted, of twenty.
  await expect(page.getByRole("columnheader", { name: "Books say" })).toBeVisible();
  await shown(page.getByLabel("Counted, CH-2", { exact: true })).fill("19");
  await page.getByRole("button", { name: "Finish counting" }).click();
  await expect(visible(page, "document-status")).toHaveText("Finished, to be posted");

  // Two chains go to the city store before the count is posted.
  await page.goto("/stock/transfers/new");
  await page.getByLabel("From warehouse").selectOption({ label: mainName });
  await page.getByLabel("To warehouse").selectOption({ label: "City store" });
  await fillLine(page, 1, "CH-2", "2");
  await page.getByRole("button", { name: "Post transfer" }).click();
  await expect(page.getByRole("heading", { name: "ST-2627-00002" })).toBeVisible();

  await page.goto(sheetUrl);
  await expect(visible(page, "moved-CH-2")).toHaveText("Stock has moved since: the books now say 18.");
  await expect(visible(page, "moved-note")).toContainText("Which came first?");
  await expect(page.getByRole("button", { name: "Post count", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Post count: counted before the stock moved" }).click();
  await expect(page.getByRole("heading", { name: "SC-2627-00002" })).toBeVisible();
  // One chain short of the twenty counted against, taken from the eighteen there now.
  expect(await stock("CH-2", mainName)).toBe("17 worth 4590");
  expect(await journal("SC-2627-00002")).toEqual(["5110 270 0", "1300 0 270"]);
});

test("the owner writes a broken item off, with the reason", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/stock/adjustments");
  await page.getByRole("link", { name: "New adjustment" }).click();
  await page.getByLabel("Warehouse", { exact: true }).selectOption({ label: mainName });
  await fillLine(page, 1, "HL-1", "1");
  await shown(page.getByLabel("Add or take out, line 1", { exact: true })).selectOption({ label: "Take out" });
  // A reason is asked for; "Other" asks for a note as well.
  await page.getByLabel("Reason").selectOption({ label: "Other" });
  await expect(page.getByLabel("Note (say what the reason is)")).toBeVisible();
  await page.getByLabel("Reason").selectOption({ label: "Damaged" });
  await page.getByLabel("Note", { exact: true }).fill("Dropped while unloading");
  await page.getByRole("button", { name: "Post adjustment" }).click();
  await expect(page.getByRole("heading", { name: "SA-2627-00003" })).toBeVisible();
  await expect(visible(page, "adjustment-total")).toHaveText("-600.00");
  expect(await stock("HL-1", mainName)).toBe("4 worth 2400");
  expect(await journal("SA-2627-00003")).toEqual(["5110 600 0", "1300 0 600"]);
  const list = page.getByRole("table", { name: "Adjustments and opening stock" });
  await page.goto("/stock/adjustments");
  await expect(list.locator("tbody tr").first()).toContainText("Damaged: Dropped while unloading");

  // Every posting is in the activity log under the name of whoever did it.
  const logged = await sql<{ action: string }[]>`select action from public.audit_log where tenant_id = ${tenantId} and action like 'stock_%.post' order by at`;
  expect(logged.map((row) => row.action)).toEqual(["stock_adjustment.post", "stock_adjustment.post", "stock_transfer.post", "stock_count.post", "stock_transfer.post", "stock_count.post", "stock_adjustment.post"]);
});
