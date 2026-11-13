import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { railLabels, signIn, test } from "./support/ui";

// Step 8 on screen: units and categories, items with their other units, archive and restore,
// and the all-or-nothing CSV import. The conversion rule itself (a line entered in cartons
// becomes pieces) is proved in src/modules/items/rules.test.ts and items.test.ts.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let storekeeper: TestUser;
let collector: TestUser;
let tenantId: string;

const itemCount = async () => (await sql<{ n: number }[]>`select count(*)::int as n from public.items where tenant_id = ${tenantId}`)[0].n;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("item-owner", { canCreateCompany: true });
  storekeeper = await createUser("item-store", { canCreateCompany: false });
  collector = await createUser("item-recovery", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("an owner sets up units and a category, then adds an item sold by the carton", async ({ page }) => {
  await signIn(page, owner);
  await page.getByLabel("Company name").fill("E2E Item Traders");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText("E2E Item Traders");
  // A new company lands on the setup wizard; this test starts from Home, on a fresh page.
  await page.goto("/");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${storekeeper.id}, ${storekeeper.email}, 'warehouse_manager', ${owner.id}),
    (${tenantId}, ${collector.id}, ${collector.email}, 'recovery_officer', ${owner.id})`;

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Items" }).click();
  await expect(page.getByText("No items yet.")).toBeVisible();
  // An item needs a unit first, and the screen says so.
  await page.getByRole("link", { name: "New item" }).click();
  await expect(page.getByText("Add a unit first")).toBeVisible();
  await page.getByRole("link", { name: "Units and categories" }).click();

  for (const [name, code] of [["Piece", "pc"], ["Carton", "ctn"]]) {
    await page.getByLabel("Unit name").fill(name);
    await page.getByLabel("Short form").fill(code);
    await page.getByRole("button", { name: "Add unit" }).click();
    await expect(page.getByRole("list", { name: "Units" }).getByRole("listitem").filter({ hasText: name })).toContainText(`(${code})`);
  }
  await page.getByLabel("Unit name").fill("Pieces");
  await page.getByLabel("Short form").fill("PC");
  await page.getByRole("button", { name: "Add unit" }).click();
  await expect(page.locator("form").filter({ has: page.getByRole("button", { name: "Add unit" }) }).getByTestId("form-error")).toHaveText(
    "A unit with this name or short form already exists.",
  );
  await page.getByLabel("Category name").fill("Engine parts");
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByRole("list", { name: "Categories" }).getByRole("listitem")).toHaveText(["Engine parts"]);

  await page.goto("/items/new");
  await page.getByLabel("Code", { exact: true }).fill("BP-100");
  await page.getByLabel("Name", { exact: true }).fill("Brake pad");
  await page.getByLabel("Category", { exact: true }).selectOption({ label: "Engine parts" });
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "Piece (pc)" });
  await page.getByLabel("Retail price").fill("1,250");
  await page.getByLabel("Reorder level").fill("20");
  await page.getByLabel("Pack unit").selectOption({ label: "Carton (ctn)" });
  await page.getByLabel("Units per pack").fill("24");
  await page.getByLabel("Tax category").selectOption({ label: "Standard rate" });
  await page.getByLabel("HS code").fill("8714.1090");
  await page.getByRole("button", { name: "Add item" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("Retail price: Enter the amount as a plain number without commas, such as 500000.");
  await page.getByLabel("Retail price").fill("1250.50");
  await page.getByRole("button", { name: "Add item" }).click();

  // The item's own screen opens: its unit is fixed, and the carton holds 24 pieces.
  await expect(page.getByRole("heading", { name: "Brake pad", level: 1 })).toBeVisible();
  await expect(page.getByTestId("item-unit")).toHaveText("Piece (pc)");
  await expect(page.getByRole("table", { name: "Other units" }).getByRole("row")).toHaveText([/1 carton \(ctn\) = 24 pc/]);
  await expect(page.getByLabel("Retail price")).toHaveValue("1250.5");
  expect(await sql`select i.code, u.code as unit, x.factor::text from public.items i join public.units u on u.id = i.base_unit_id
    join public.item_units x on x.item_id = i.id where i.tenant_id = ${tenantId}`).toEqual([{ code: "BP-100", unit: "pc", factor: "24.000000" }]);

  // The carton is corrected to 20, then the price is changed; each is saved and audited.
  await page.getByLabel("Other unit", { exact: true }).selectOption({ label: "Carton (ctn)" });
  await page.getByLabel("How many pc it holds").fill("20");
  await page.getByRole("button", { name: "Save unit" }).click();
  await expect(page.getByRole("table", { name: "Other units" }).getByRole("row")).toHaveText([/1 carton \(ctn\) = 20 pc/]);
  await page.getByLabel("Retail price").fill("1300");
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Save changes" }).click();
  await reloaded;
  await expect(page.getByLabel("Retail price")).toHaveValue("1300");
  const audited = await sql`select action from public.audit_log where tenant_id = ${tenantId} and entity = 'item' order by at`;
  expect(audited.map((a) => a.action)).toEqual(["item.create", "item_unit.set", "item.update"]);

  await page.getByRole("link", { name: "Back to items" }).click();
  await expect(page.getByRole("table", { name: "Items" }).getByRole("row").nth(1)).toHaveText(/BP-100\s*Brake pad\s*Engine parts\s*pc\s*1,300\.00\s*20/);
});

test("an owner archives an item and restores it", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/items");
  await page.getByRole("link", { name: "BP-100" }).click();
  await page.getByRole("button", { name: "Archive item" }).click();
  await expect(page.getByTestId("archived-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save unit" })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to items" }).click();
  await expect(page.getByText("No items yet.")).toBeVisible();
  await page.getByRole("link", { name: "Archived", exact: true }).click();
  await page.getByRole("link", { name: "BP-100" }).click();
  await page.getByRole("button", { name: "Restore item" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  expect(await itemCount()).toBe(1);
});

test("an import with bad rows imports nothing and lists them; put right, every row arrives", async ({ page }) => {
  const lines = ["Code,Name,Unit,Category,Retail price,Pack unit,Units per pack"];
  for (let i = 1; i <= 300; i++) lines.push(`IM-${String(i).padStart(4, "0")},Import Item ${i},pc,Engine parts,${i * 10},ctn,12`);
  const bad = [...lines];
  bad[50] = "IM-0050,,pc,,,,"; // row 51: no name
  bad[150] = "IM-0150,Import Item 150,box,,,,"; // row 151: a unit the company does not have
  bad[250] = "bp-100,Import Item 250,pc,,,,"; // row 251: the code of the item already there
  const file = (text: string) => ({ name: "items.csv", mimeType: "text/csv", buffer: Buffer.from(text, "utf8") });

  await signIn(page, owner);
  await page.goto("/items");
  await page.getByRole("link", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("import-columns")).toContainText("Code, Name, Category, Unit, Tax category");
  await page.getByLabel("CSV file").setInputFiles(file(bad.join("\n")));
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByTestId("import-problems")).toContainText("Nothing was imported. 3 rows need correcting");
  await expect(page.getByRole("table", { name: "Rows to correct" }).getByRole("row")).toHaveText([
    /Row\s*Name\s*What is wrong/,
    /51\s*IM-0050\s*Enter the item's name\./,
    /151\s*Import Item 150\s*Unit: there is no unit called "box"\. Add it under Items, Units and categories first\./,
    /251\s*Import Item 250\s*Another item already has this code\./,
  ]);
  expect(await itemCount()).toBe(1);

  await page.getByLabel("CSV file").setInputFiles(file(lines.join("\n")));
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByTestId("import-done")).toHaveText("Imported 300 items.");
  expect(await itemCount()).toBe(301);
  expect(await sql`select count(*)::int as n from public.item_units where tenant_id = ${tenantId} and factor = 12`).toEqual([{ n: 300 }]);

  await page.getByRole("link", { name: "Back to items" }).click();
  await expect(page.getByText("Showing the first 200. Search to find the rest.")).toBeVisible();
  await page.getByLabel("Search items").fill("IM-0299");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("table", { name: "Items" }).getByRole("row").nth(1)).toHaveText(/IM-0299\s*Import Item 299\s*Engine parts\s*pc\s*2,990\.00/);
});

test("a warehouse manager reads items but cannot change them; a recovery officer has no way in", async ({ page }) => {
  await signIn(page, storekeeper);
  expect(await railLabels(page)).toContain("Items");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Items" }).click();
  await expect(page.getByRole("table", { name: "Items" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New item" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Import", exact: true })).toHaveCount(0);
  await page.getByLabel("Search items").fill("BP-100");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: "BP-100" }).click();
  await expect(page.getByLabel("Details")).toContainText("1,300.00");
  await expect(page.getByRole("table", { name: "Other units" })).toContainText("1 carton (ctn) = 20 pc");
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save unit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive item" })).toHaveCount(0);
  await page.goto("/items/units");
  await expect(page.getByRole("list", { name: "Units" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add unit" })).toHaveCount(0);
  await page.goto("/items/new");
  await expect(page.getByText("Your role cannot add an item.")).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, collector);
  expect(await railLabels(page)).not.toContain("Items");
  await page.goto("/items");
  await expect(page.getByText("Your role does not include the item list.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Items" })).toHaveCount(0);
});
