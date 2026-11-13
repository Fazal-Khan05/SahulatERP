import { expect, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { railLabels, signIn, test } from "./support/ui";

// Step 3 acceptance: switching a module off removes its menu entry, and renaming the product
// needs no deploy. The tests run in order and build on each other.

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

const COMPANY = "E2E Shell Traders";
const OWNER_MENU = [
  "Home",
  "Needs attention",
  "Sales",
  "Customers",
  "Price lists",
  "Collections",
  "Purchases and imports",
  "Suppliers",
  "Stock",
  "Items",
  "Cash and bank",
  "Commissions",
  "Reports",
  "Settings",
];
// The smallest valid PNG: one transparent pixel.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let sql: AdminSql;
let owner: TestUser;
let seller: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("shell-owner", { canCreateCompany: true });
  seller = await createUser("shell-seller", { canCreateCompany: false });
});

test.afterAll(async () => {
  await sql.end();
});

async function auditCount(action: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from public.audit_log
    where tenant_id = ${tenantId} and action = ${action} and actor_user_id = ${owner.id}`;
  return rows[0].n;
}

function moduleRow(page: Page, key: string) {
  return page.locator(`tr[data-module="${key}"]`);
}

test("the owner gets the shell: their menu, an empty inbox and their company in the top bar", async ({ page }) => {
  await signIn(page, owner);
  await page.getByLabel("Company name").fill(COMPANY);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByTestId("company-name")).toHaveText(COMPANY);
  // A new company lands on the setup wizard; this test starts from Home, on a fresh page.
  await page.goto("/");
  await expect(page.getByTestId("product-name")).toHaveText("SahulatERP");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");

  const rows = await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`;
  tenantId = rows[0].id;
  // A second person in the same company, as a salesperson.
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by)
    values (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id})`;

  expect(await railLabels(page)).toEqual(OWNER_MENU);
  // Only screens that exist are links.
  const rail = page.getByRole("navigation", { name: "Main" });
  await expect(rail.getByRole("link")).toHaveText(["Home", "Needs attention", "Customers", "Price lists", "Suppliers", "Items", "Settings"]);
  await expect(rail.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

  await expect(page.getByText("Nothing needs your attention.").filter({ visible: true })).toHaveCount(1);
  await rail.getByRole("link", { name: "Needs attention" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Needs attention");
  await expect(page.getByText("Nothing needs your attention.").filter({ visible: true })).toHaveCount(1);
  await expect(rail.getByRole("link", { name: "Needs attention" })).toHaveAttribute("aria-current", "page");
});

test("a salesperson gets their own short menu and no settings", async ({ page }) => {
  await signIn(page, seller);
  await expect(page.getByTestId("company-name")).toHaveText(COMPANY);
  expect(await railLabels(page)).toEqual(["Home", "Needs attention", "My customers", "Orders", "My commission"]);

  for (const path of ["/settings", "/settings/modules"]) {
    await page.goto(path);
    await expect(page.getByText("Only an owner or an auditor can open these settings.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Turn o/ })).toHaveCount(0);
  }
  // Of the settings tabs, only the branches they work in.
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link")).toHaveText(["Branches"]);
});

test("switching a module off removes its menu entry for everyone, and on brings it back", async ({ page, browser }) => {
  await signIn(page, owner);
  await page.goto("/settings/modules");
  const commissions = moduleRow(page, "commissions");
  await expect(commissions).toContainText("On");

  await commissions.getByRole("button", { name: "Turn off" }).click();
  await expect(commissions.getByRole("button", { name: "Turn on" })).toBeVisible();
  await expect(commissions).toContainText("Off");
  // The menu changed without a reload, and stays changed after one.
  expect(await railLabels(page)).toEqual(OWNER_MENU.filter((label) => label !== "Commissions"));
  await page.reload();
  expect(await railLabels(page)).toEqual(OWNER_MENU.filter((label) => label !== "Commissions"));

  const stored = await sql`select enabled from public.modules_enabled where tenant_id = ${tenantId} and module = 'commissions'`;
  expect(stored.map((r) => r.enabled)).toEqual([false]);
  expect(await auditCount("module.update")).toBe(1);

  const sellerContext = await browser.newContext();
  const sellerPage = await sellerContext.newPage();
  await signIn(sellerPage, seller);
  expect(await railLabels(sellerPage)).toEqual(["Home", "Needs attention", "My customers", "Orders"]);

  await moduleRow(page, "commissions").getByRole("button", { name: "Turn on" }).click();
  await expect(moduleRow(page, "commissions").getByRole("button", { name: "Turn off" })).toBeVisible();
  expect(await railLabels(page)).toEqual(OWNER_MENU);
  await sellerPage.reload();
  expect(await railLabels(sellerPage)).toEqual(["Home", "Needs attention", "My customers", "Orders", "My commission"]);
  await sellerContext.close();
  expect(await auditCount("module.update")).toBe(2);
});

test("the dependency rules refuse a switch that would break another module", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/settings/modules");

  // Sales cannot go while Collections and Commissions are on.
  await moduleRow(page, "sales").getByRole("button", { name: "Turn off" }).click();
  await expect(moduleRow(page, "sales").getByTestId("form-error")).toHaveText(
    "Turn off Collections and Commissions first. It needs Sales.",
  );
  await expect(moduleRow(page, "sales").getByRole("button", { name: "Turn off" })).toBeVisible();
  expect(await railLabels(page)).toContain("Sales");

  // Imports off, then Purchases off: allowed in that order, and the menu follows.
  await moduleRow(page, "imports").getByRole("button", { name: "Turn off" }).click();
  await expect(moduleRow(page, "imports").getByRole("button", { name: "Turn on" })).toBeVisible();
  expect(await railLabels(page)).toContain("Purchases");
  await moduleRow(page, "purchasing").getByRole("button", { name: "Turn off" }).click();
  await expect(moduleRow(page, "purchasing").getByRole("button", { name: "Turn on" })).toBeVisible();
  const without = await railLabels(page);
  expect(without).not.toContain("Purchases");
  expect(without).not.toContain("Purchases and imports");
  // The supplier list belongs to Purchases: it leaves the menu and its screen says why.
  expect(without).not.toContain("Suppliers");
  await page.goto("/suppliers");
  await expect(page.getByText("Suppliers are part of Purchases, which is switched off for this company.")).toBeVisible();
  await page.goto("/settings/modules");

  // Imports cannot come back before Purchases.
  await moduleRow(page, "imports").getByRole("button", { name: "Turn on" }).click();
  await expect(moduleRow(page, "imports").getByTestId("form-error")).toHaveText("Turn on Purchases first. Imports needs it.");

  await moduleRow(page, "purchasing").getByRole("button", { name: "Turn on" }).click();
  await expect(moduleRow(page, "purchasing").getByRole("button", { name: "Turn off" })).toBeVisible();
  await moduleRow(page, "imports").getByRole("button", { name: "Turn on" }).click();
  await expect(moduleRow(page, "imports").getByRole("button", { name: "Turn off" })).toBeVisible();
  expect(await railLabels(page)).toEqual(OWNER_MENU);

  // A module that is off by default can be turned on, and shows up.
  await moduleRow(page, "payroll").getByRole("button", { name: "Turn on" }).click();
  await expect(moduleRow(page, "payroll").getByRole("button", { name: "Turn off" })).toBeVisible();
  expect(await railLabels(page)).toContain("Payroll");
});

test("renaming the product shows at once, for everyone in the company, with no deploy", async ({ page, browser }) => {
  await signIn(page, owner);
  await page.goto("/settings");
  await expect(page.getByLabel("Product name")).toHaveValue("SahulatERP");

  await page.getByLabel("Product name").fill("   ");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("Enter the product name.");

  await page.getByLabel("Product name").fill("Karachi Parts Desk");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("product-name")).toHaveText("Karachi Parts Desk");
  await expect(page.getByLabel("Product name")).toHaveValue("Karachi Parts Desk");
  await page.reload();
  await expect(page.getByTestId("product-name")).toHaveText("Karachi Parts Desk");
  expect(await auditCount("settings.update")).toBe(1);

  const sellerContext = await browser.newContext();
  const sellerPage = await sellerContext.newPage();
  await signIn(sellerPage, seller);
  await expect(sellerPage.getByTestId("product-name")).toHaveText("Karachi Parts Desk");
  await sellerContext.close();
});

test("the logo shows in the header and on the letterhead, and only real images are accepted", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/settings");
  await expect(page.getByTestId("brand-mark")).toBeVisible();

  // A text file with an image's name is refused.
  await page.getByLabel("Logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("form-error")).toHaveText("Use a PNG, JPEG or WebP image.");
  await expect(page.getByTestId("brand-logo")).toHaveCount(0);

  await page.getByLabel("Logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Save" }).click();
  const logo = page.getByTestId("brand-logo");
  await expect(logo).toBeVisible();
  const src = await logo.getAttribute("src");
  const served = await page.request.get(src!);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/png");
  expect(Buffer.compare(await served.body(), PNG)).toBe(0);

  await page.getByRole("link", { name: "See how printed documents will start" }).click();
  const letterhead = page.getByTestId("print-header");
  await expect(letterhead).toContainText(COMPANY);
  await expect(letterhead).toContainText("Karachi Parts Desk");
  await expect(letterhead.locator("img")).toHaveAttribute("src", src!);

  await page.getByRole("link", { name: "Back to settings" }).click();
  await page.getByLabel("Remove the logo").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("brand-mark")).toBeVisible();
  await expect(page.getByTestId("brand-logo")).toHaveCount(0);
  expect((await page.request.get(src!)).status()).toBe(404);
});

test("a signed-out visitor still sees the product's own name and no company logo", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByText("SahulatERP", { exact: true })).toBeVisible();
  // Asking for a logo without a session leads to the sign-in page, not to an image.
  const logo = await page.request.get("/branding/logo", { maxRedirects: 0 });
  expect(logo.status()).toBe(307);
  expect(logo.headers().location).toMatch(/\/sign-in$/);
});
