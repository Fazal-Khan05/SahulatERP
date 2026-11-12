import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { railLabels, signIn, test } from "./support/ui";

// Step 9 on screen: price lists, an item's special prices and a customer's price list. The rule
// that picks the price (customer > class > list > item default) is proved in
// src/modules/prices/rules.test.ts and prices.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let seller: TestUser;
let storekeeper: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("price-owner", { canCreateCompany: true });
  seller = await createUser("price-seller", { canCreateCompany: false });
  storekeeper = await createUser("price-store", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("an owner adds price lists and sets an item's prices from dates", async ({ page }) => {
  await signIn(page, owner);
  await page.getByLabel("Company name").fill("E2E Price Traders");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText("E2E Price Traders");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id}),
    (${tenantId}, ${storekeeper.id}, ${storekeeper.email}, 'warehouse_manager', ${owner.id})`;
  // An item and a customer to price, put in place directly: their own screens are tested elsewhere.
  const [unit] = await sql`insert into public.units (tenant_id, code, name, created_by) values (${tenantId}, 'pc', 'Piece', ${owner.id}) returning id`;
  await sql`insert into public.items (tenant_id, code, name, base_unit_id, default_price, created_by, updated_by) values (${tenantId}, 'BP-100', 'Brake pad', ${unit.id}, 110, ${owner.id}, ${owner.id})`;
  await sql`insert into public.customers (tenant_id, name, code, customer_class, created_by, updated_by) values (${tenantId}, 'Khan Autos', 'C-001', 'Wholesale', ${owner.id}, ${owner.id})`;

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Price lists" }).click();
  await expect(page.getByText("No price lists yet.")).toBeVisible();
  for (const name of ["Standard", "Retail"]) {
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Add price list" }).click();
    await expect(page.getByRole("table", { name: "Price lists" }).getByRole("row").filter({ hasText: name })).toBeVisible();
  }
  // The first list added is the default.
  await expect(page.getByRole("table", { name: "Price lists" }).getByRole("row").filter({ hasText: "Standard" })).toContainText("Default");
  await page.getByLabel("Name").fill("standard");
  await page.getByRole("button", { name: "Add price list" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("A price list with this name already exists.");

  await page.getByRole("link", { name: "Standard" }).click();
  await expect(page.getByTestId("default-note")).toBeVisible();
  const setPrice = page.locator("form").filter({ has: page.getByRole("button", { name: "Save price" }) });
  await setPrice.getByLabel("Item code").fill("nope");
  await setPrice.getByLabel("Price").fill("100");
  await setPrice.getByLabel("From date").fill("2026-07-01");
  await setPrice.getByRole("button", { name: "Save price" }).click();
  await expect(setPrice.getByTestId("form-error")).toHaveText('There is no item with the code "nope".');
  await setPrice.getByLabel("Item code").fill("bp-100");
  await setPrice.getByRole("button", { name: "Save price" }).click();
  const prices = page.getByRole("table", { name: "Prices" });
  await expect(prices.getByRole("row").nth(1)).toHaveText(/BP-100 Brake pad\s*100\.00\s*01-07-2026\s*In force/);
  // A dearer price from a date still to come waits its turn.
  await setPrice.getByLabel("Item code").fill("BP-100");
  await setPrice.getByLabel("Price").fill("105");
  await setPrice.getByLabel("From date").fill("2099-01-01");
  await setPrice.getByRole("button", { name: "Save price" }).click();
  await expect(prices.getByRole("row")).toHaveText([/Item/, /105\.00\s*01-01-2099\s*Not yet/, /100\.00\s*01-07-2026\s*In force/]);

  // Retail becomes the default, and says so. The lists screen counts each list's prices.
  await page.getByRole("link", { name: "Back to price lists" }).click();
  await expect(page.getByRole("table", { name: "Price lists" }).getByRole("row").filter({ hasText: "Standard" })).toHaveText(/Standard\s*2\s*Default/);
  await page.getByRole("link", { name: "Retail" }).click();
  await page.getByRole("button", { name: "Make this the default" }).click();
  // The Standard list's page, visited a moment ago, is kept hidden by the router; look at the one on screen.
  await expect(page.getByTestId("default-note").filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Make this the default" }).filter({ visible: true })).toHaveCount(0);
  expect(await sql`select name from public.price_lists where tenant_id = ${tenantId} and is_default`).toEqual([{ name: "Retail" }]);
});

test("an owner gives an item a class price and a customer price, and puts a customer on a list", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/items");
  await page.getByRole("link", { name: "BP-100" }).click();
  await expect(page.getByLabel("Selling price")).toHaveValue("110");
  await expect(page.getByRole("table", { name: "Price list prices" }).getByRole("row").filter({ hasText: "In force" })).toHaveText(/Standard\s*100\.00/);

  const classForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save class price" }) });
  await classForm.getByLabel("Customer class").fill("Wholesale");
  await classForm.getByLabel("Price").fill("95");
  await classForm.getByLabel("From date").fill("2026-07-01");
  await classForm.getByRole("button", { name: "Save class price" }).click();
  await expect(page.getByRole("table", { name: "Class prices" }).getByRole("row").nth(1)).toHaveText(/Wholesale\s*95\.00\s*01-07-2026\s*In force/);

  const customerForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save customer price" }) });
  await customerForm.getByLabel("Customer", { exact: true }).fill("Nobody Ltd");
  await customerForm.getByLabel("Price").fill("90");
  await customerForm.getByLabel("From date").fill("2026-07-01");
  await customerForm.getByLabel("Until date").fill("2026-06-30");
  await customerForm.getByRole("button", { name: "Save customer price" }).click();
  await expect(customerForm.getByTestId("form-error")).toHaveText("The last day cannot be before the first.");
  await customerForm.getByLabel("Until date").fill("2099-12-31");
  await customerForm.getByRole("button", { name: "Save customer price" }).click();
  await expect(customerForm.getByTestId("form-error")).toHaveText('There is no customer with the code or name "Nobody Ltd".');
  await customerForm.getByLabel("Customer", { exact: true }).fill("c-001");
  await customerForm.getByRole("button", { name: "Save customer price" }).click();
  await expect(page.getByRole("table", { name: "Customer prices" }).getByRole("row").nth(1)).toHaveText(/Khan Autos\s*90\.00\s*01-07-2026\s*31-12-2099\s*In force/);
  const audited = await sql`select after from public.audit_log where tenant_id = ${tenantId} and action = 'price.set' order by at`;
  expect(audited.map((a) => ["list", "class", "customer"].find((kind) => kind in a.after))).toEqual(["list", "list", "class", "customer"]);

  // The customer's own screen offers the lists; no choice means the default list.
  await page.goto("/customers");
  await page.getByRole("link", { name: "Khan Autos" }).click();
  await expect(page.getByLabel("Price list")).toHaveValue("");
  await page.getByLabel("Price list").selectOption({ label: "Standard" });
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Save changes" }).click();
  await reloaded;
  await expect(page.getByLabel("Price list").locator("option:checked")).toHaveText("Standard");
  expect(await sql`select l.name from public.customers c join public.price_lists l on l.id = c.price_list_id where c.tenant_id = ${tenantId}`).toEqual([{ name: "Standard" }]);
});

test("a salesperson reads prices but cannot set them; a warehouse manager sees none", async ({ page }) => {
  await signIn(page, seller);
  expect(await railLabels(page)).not.toContain("Price lists");
  await page.goto("/price-lists");
  await expect(page.getByRole("table", { name: "Price lists" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add price list" })).toHaveCount(0);
  await page.getByRole("link", { name: "Standard" }).click();
  await expect(page.getByRole("table", { name: "Prices" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save price" })).toHaveCount(0);
  await page.goto("/items");
  await page.getByRole("link", { name: "BP-100" }).click();
  await expect(page.getByRole("table", { name: "Customer prices" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save class price" })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, storekeeper);
  await page.goto("/price-lists");
  await expect(page.getByText("Your role does not include prices.")).toBeVisible();
  // The item itself is theirs to read; its special prices are not.
  await page.goto("/items");
  await page.getByRole("link", { name: "BP-100" }).click();
  await expect(page.getByLabel("Details")).toBeVisible();
  await expect(page.getByText("Special prices")).toHaveCount(0);
});
