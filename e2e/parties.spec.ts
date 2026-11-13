import { expect } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { railLabels, signIn, test } from "./support/ui";

// Step 7 on screen: customers and suppliers, archive and restore, and the all-or-nothing CSV
// import. The rules themselves are proved in src/modules/parties/rules.test.ts and
// parties.test.ts. Every tax number here is made up.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

let sql: AdminSql;
let owner: TestUser;
let accountant: TestUser;
let seller: TestUser;
let storekeeper: TestUser;
let tenantId: string;

const customerCount = async () => (await sql<{ n: number }[]>`select count(*)::int as n from public.customers where tenant_id = ${tenantId}`)[0].n;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("party-owner", { canCreateCompany: true });
  accountant = await createUser("party-accountant", { canCreateCompany: false });
  seller = await createUser("party-seller", { canCreateCompany: false });
  storekeeper = await createUser("party-store", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

test("an owner adds a customer, finds it in the list and changes it", async ({ page }) => {
  await signIn(page, owner);
  await page.getByLabel("Company name").fill("E2E Party Traders");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText("E2E Party Traders");
  // A new company lands on the setup wizard; this test starts from Home, on a fresh page.
  await page.goto("/");
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id}),
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id}),
    (${tenantId}, ${storekeeper.id}, ${storekeeper.email}, 'warehouse_manager', ${owner.id})`;

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Customers" }).click();
  await expect(page.getByText("No customers yet.")).toBeVisible();
  await page.getByRole("link", { name: "New customer" }).click();

  // A wrong tax number is refused in plain words and what was typed stays.
  await page.getByLabel("Name").fill("Khan Autos");
  await page.getByLabel("Code").fill("C-001");
  await page.getByLabel("Class").fill("Wholesale");
  await page.getByLabel("Credit days").fill("30");
  await page.getByLabel("Credit limit").fill("500000");
  await page.getByLabel("NTN").fill("12345");
  await page.getByLabel("Phone").fill("0300-1111111");
  await page.getByLabel("City").fill("Lahore");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("NTN: 7 digits, with or without the check digit, such as 1234567-8.");
  await expect(page.getByLabel("Name")).toHaveValue("Khan Autos");
  await page.getByLabel("NTN").fill("1111111-1");
  await page.getByRole("button", { name: "Add customer" }).click();

  // The customer's own screen opens, holding what was saved.
  await expect(page.getByRole("heading", { name: "Khan Autos", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Credit limit")).toHaveValue("500000");
  await expect(page.getByLabel("NTN")).toHaveValue("1111111-1");

  // Changing it saves and shows the new value.
  await page.getByLabel("Credit days").fill("45");
  // Saving reloads the screen from the database; wait for that, not for the field we just typed in.
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Save changes" }).click();
  await reloaded;
  await expect(page.getByLabel("Credit days")).toHaveValue("45");
  const audited = await sql`
    select action, before, after from public.audit_log where tenant_id = ${tenantId} and entity = 'customer' order by at`;
  expect(audited.map((a) => a.action)).toEqual(["customer.create", "customer.update"]);
  expect([audited[1].before, audited[1].after]).toEqual([{ creditDays: 30 }, { creditDays: 45 }]);

  // The list shows it, with the limit grouped the Pakistani way, and the search finds it.
  await page.getByRole("link", { name: "Back to customers" }).click();
  const list = page.getByRole("table", { name: "Customers" });
  await expect(list.getByRole("row").filter({ hasText: "Khan Autos" })).toHaveText(/C-001\s*Khan Autos\s*Wholesale\s*Lahore\s*0300-1111111\s*5,00,000\.00\s*45/);
  await page.getByLabel("Search customers").fill("nobody");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText('No customer matches "nobody".')).toBeVisible();
  await page.getByLabel("Search customers").fill("lahore");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(list.getByRole("row")).toHaveCount(2);

  // The same name again is refused.
  await page.goto("/customers/new");
  await page.getByLabel("Name").fill("khan autos");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("A customer with this name already exists.");
  expect(await customerCount()).toBe(1);
});

test("an owner archives a customer and restores it; nothing is deleted", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/customers");
  await page.getByRole("link", { name: "Khan Autos" }).click();
  await page.getByRole("button", { name: "Archive customer" }).click();
  await expect(page.getByTestId("archived-note")).toContainText("Archived");
  // Archived, it is shown but cannot be changed.
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(page.getByLabel("Details")).toContainText("Wholesale");

  await page.getByRole("link", { name: "Back to customers" }).click();
  await expect(page.getByText("No customers yet.")).toBeVisible();
  await page.getByRole("link", { name: "Archived" }).click();
  await expect(page.getByRole("heading", { name: "Archived customers" })).toBeVisible();
  await page.getByRole("link", { name: "Khan Autos" }).click();
  await page.getByRole("button", { name: "Restore customer" }).click();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await expect(page.getByTestId("archived-note")).toHaveCount(0);
  expect(await customerCount()).toBe(1);
  const audited = await sql`select action from public.audit_log where tenant_id = ${tenantId} and action in ('customer.archive', 'customer.restore') order by at`;
  expect(audited.map((a) => a.action)).toEqual(["customer.archive", "customer.restore"]);
});

test("an import of 500 rows with 3 bad rows imports nothing and lists the 3", async ({ page }) => {
  const lines = ["Code,Name,NTN,Credit limit,Credit days,Phone,City"];
  for (let i = 1; i <= 500; i++) lines.push(`I${String(i).padStart(4, "0")},Import Customer ${i},,250000,30,,Karachi`);
  const good = lines.join("\n");
  const bad = [...lines];
  bad[120] = "I0120,,,250000,30,,Karachi"; // row 121: no name
  bad[250] = "I0250,Import Customer 250,12345,250000,30,,Karachi"; // row 251: not an NTN
  bad[400] = "I0400,Import Customer 7,,250000,30,,Karachi"; // row 401: the name of row 8 again
  const file = (text: string) => ({ name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from(text, "utf8") });

  await signIn(page, owner);
  await page.goto("/customers");
  await page.getByRole("link", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("import-columns")).toContainText("Code, Name, Registration, NTN, CNIC, STRN");

  await page.getByLabel("CSV file").setInputFiles(file(bad.join("\n")));
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByTestId("import-problems")).toContainText("Nothing was imported. 3 rows need correcting");
  await expect(page.getByRole("table", { name: "Rows to correct" }).getByRole("row")).toHaveText([
    /Row\s*Name\s*What is wrong/,
    /121\s*\(no name\)\s*Enter the name\./,
    /251\s*Import Customer 250\s*NTN: 7 digits, with or without the check digit, such as 1234567-8\./,
    /401\s*Import Customer 7\s*The same name is in row 8\./,
  ]);
  expect(await customerCount()).toBe(1);

  // The file put right: every row arrives.
  await page.getByLabel("CSV file").setInputFiles(file(good));
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByTestId("import-done")).toHaveText("Imported 500 customers.");
  await expect(page.getByTestId("import-problems")).toHaveCount(0);
  expect(await customerCount()).toBe(501);
  const imports = await sql`select after from public.audit_log where tenant_id = ${tenantId} and action = 'customer.import'`;
  expect(imports).toHaveLength(1);
  expect(imports[0].after).toMatchObject({ rows: 500, file: "customers.csv" });
  expect(imports[0].after.ids).toHaveLength(500);

  await page.getByRole("link", { name: "Back to customers" }).click();
  await expect(page.getByText("Showing the first 200. Search to find the rest.")).toBeVisible();
  await page.getByLabel("Search customers").fill("Import Customer 499");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("table", { name: "Customers" }).getByRole("row").nth(1)).toHaveText(/I0499\s*Import Customer 499\s*Karachi\s*2,50,000\.00\s*30/);

  // A file that is not a list of customers is refused whole, saying why.
  await page.goto("/customers/import");
  await page.getByLabel("CSV file").setInputFiles(file("Name,Salary\nSomeone,5\n"));
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByTestId("form-error")).toHaveText('The column "Salary" is not one this import knows. Rename or remove it.');
  expect(await customerCount()).toBe(501);
});

test("an accountant adds a supplier with its type and tax registration", async ({ page }) => {
  await signIn(page, accountant);
  expect(await railLabels(page)).toEqual(expect.arrayContaining(["Customers", "Suppliers"]));
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Suppliers" }).click();
  await page.getByRole("link", { name: "New supplier" }).click();
  // A supplier has a type and no credit limit or class.
  await expect(page.getByLabel("Credit limit")).toHaveCount(0);
  await expect(page.getByLabel("Class")).toHaveCount(0);
  await page.getByLabel("Name").fill("Anwar & Brothers");
  await page.getByLabel("Supplier type").selectOption({ label: "Association of persons (AOP)" });
  await page.getByLabel("Sales tax registration").selectOption({ label: "Registered for sales tax" });
  await page.getByRole("button", { name: "Add supplier" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("A supplier registered for sales tax needs an NTN, an STRN or a CNIC.");
  await page.getByLabel("STRN").fill("11-11-1111-111-11");
  await page.getByLabel("Active Taxpayers List").selectOption({ label: "On the list" });
  await page.getByLabel("Province").selectOption({ label: "Sindh" });
  await page.getByRole("button", { name: "Add supplier" }).click();
  await expect(page.getByRole("heading", { name: "Anwar & Brothers", level: 1 })).toBeVisible();
  await expect(page.getByLabel("STRN")).toHaveValue("1111111111111");

  await page.getByRole("link", { name: "Back to suppliers" }).click();
  await expect(page.getByRole("table", { name: "Suppliers" }).getByRole("row").nth(1)).toHaveText(/Anwar & Brothers\s*Association of persons \(AOP\)/);
  const stored = await sql`select supplier_type, registration_type, strn, atl_status, atl_checked_at is not null as checked, province, created_by
    from public.suppliers where tenant_id = ${tenantId}`;
  expect(stored).toEqual([
    { supplier_type: "aop", registration_type: "registered", strn: "1111111111111", atl_status: "active", checked: true, province: "sindh", created_by: accountant.id },
  ]);
});

test("a salesperson reads customers but cannot change them, and has no way to suppliers", async ({ page }) => {
  await signIn(page, seller);
  expect(await railLabels(page)).not.toContain("Suppliers");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My customers" }).click();
  await expect(page.getByRole("table", { name: "Customers" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New customer" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Import", exact: true })).toHaveCount(0);

  await page.getByLabel("Search customers").fill("Khan");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("link", { name: "Khan Autos" }).click();
  await expect(page.getByLabel("Details")).toContainText("5,00,000.00");
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive customer" })).toHaveCount(0);

  await page.goto("/customers/new");
  await expect(page.getByText("Your role cannot add a customer.")).toBeVisible();
  await page.goto("/customers/import");
  await expect(page.getByText("Your role cannot import customers.")).toBeVisible();
  await page.goto("/suppliers");
  await expect(page.getByText("Your role does not include the supplier list.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Suppliers" })).toHaveCount(0);
});

test("a warehouse manager reads suppliers and has no way to customers", async ({ page }) => {
  await signIn(page, storekeeper);
  await page.goto("/suppliers");
  await expect(page.getByRole("table", { name: "Suppliers" }).getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "New supplier" })).toHaveCount(0);
  await page.getByRole("link", { name: "Anwar & Brothers" }).click();
  await expect(page.getByLabel("Details")).toContainText("Association of persons (AOP)");
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);

  await page.goto("/customers");
  await expect(page.getByText("Your role does not include the customer list.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Customers" })).toHaveCount(0);
});
