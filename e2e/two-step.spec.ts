import { expect, type Page } from "@playwright/test";
import { adminSql, type AdminSql } from "../tests/support/admin-db";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, giveCode, signIn, test } from "./support/ui";
import { freshCode, keyFromPage } from "./support/two-step";

// Step 47 on screen: two-step sign-in with an authenticator app, the sign-in history, and a
// session ended when left idle. The plan's test: "A member without 2FA is prompted on next login".

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");

const COMPANY = "E2E Two Step Traders";

let sql: AdminSql;
let owner: TestUser;
let seller: TestUser;
let accountant: TestUser;
let tenantId: string;

test.beforeAll(async () => {
  sql = adminSql();
  owner = await createUser("twostep-owner", { canCreateCompany: true, twoStep: false });
  seller = await createUser("twostep-seller", { canCreateCompany: false, twoStep: false });
  accountant = await createUser("twostep-accountant", { canCreateCompany: false, twoStep: false });
});

test.afterAll(async () => {
  await sql.end();
});

async function passwordOnly(page: Page, user: TestUser) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Goes through the setup page and returns the key the app would have been given. */
async function setUp(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Set it up" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  return keyFromPage(await page.getByTestId("two-step-key").innerText());
}

async function count(action: string, actor: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.audit_log where tenant_id = ${tenantId} and action = ${action} and actor_user_id = ${actor}`;
  return n;
}

test("an owner without two-step sign-in sets it up before going on", async ({ page }) => {
  await passwordOnly(page, owner);
  await expect(page).toHaveURL(/\/two-step\/setup$/);
  await expect(page.getByText("Your role needs two-step sign-in.")).toBeVisible();
  // No way past it: not offered, and not by typing an address.
  await expect(page.getByRole("link", { name: "Not now" })).toHaveCount(0);
  await page.goto("/create-company");
  await expect(page).toHaveURL(/\/two-step\/setup$/);

  const key = await setUp(page);
  await page.getByLabel("Code from the app").fill("000000");
  await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
  await expect(page.getByTestId("form-error")).toContainText("That code is not right.");
  await page.getByLabel("Code from the app").fill(await freshCode(key));
  await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
  await expect(page).toHaveURL(/\/create-company$/);
  owner.totp = key;

  await createCompany(page, COMPANY);
  tenantId = (await sql<{ id: string }[]>`select id from public.tenants where created_by = ${owner.id}`)[0].id;
  await sql`insert into public.memberships (tenant_id, user_id, email, role, created_by) values
    (${tenantId}, ${seller.id}, ${seller.email}, 'salesperson', ${owner.id}),
    (${tenantId}, ${accountant.id}, ${accountant.email}, 'accountant', ${owner.id})`;

  // Next time, the code is asked for after the password; a wrong one is refused and recorded.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await passwordOnly(page, owner);
  await expect(page).toHaveURL(/\/two-step$/);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/two-step$/);
  await page.getByLabel("Code", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("form-error")).toContainText("That code is not right.");
  expect(await count("auth.two_step_failed", owner.id)).toBe(1);
  await giveCode(page, owner);
  await expect(page.getByTestId("company-name")).toHaveText(COMPANY);
  expect(await count("auth.two_step_passed", owner.id)).toBe(1);

  // Its role needs it, so it cannot be turned off.
  await page.goto("/account");
  await expect(page.getByTestId("two-step-status")).toContainText("On.");
  await expect(page.getByText("Your role needs it, so it stays on.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn it off" })).toHaveCount(0);
});

test("a member without two-step sign-in is prompted on next login, and may set it up or not", async ({ page }) => {
  await passwordOnly(page, seller);
  await expect(page).toHaveURL(/\/two-step\/setup$/);
  await expect(page.getByText("Protect your account with a code")).toBeVisible();
  await page.getByRole("link", { name: "Not now" }).click();
  await expect(page.getByTestId("company-name")).toHaveText(COMPANY);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);

  // Asked again at the next sign-in; this time it is set up, from the account page.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await passwordOnly(page, seller);
  await expect(page).toHaveURL(/\/two-step\/setup$/);
  await page.goto("/account");
  await expect(page.getByTestId("two-step-status")).toContainText("Off.");
  await page.getByRole("link", { name: "Set it up" }).click();
  const key = await setUp(page);
  await page.getByLabel("Code from the app").fill(await freshCode(key));
  await page.getByRole("button", { name: "Turn on two-step sign-in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/two-step"));
  await expect(page.getByTestId("company-name")).toBeVisible();
  expect(await count("auth.two_step_on", seller.id)).toBe(1);

  // A salesperson's role does not need it, so it can be turned off again.
  await page.goto("/account");
  await expect(page.getByTestId("two-step-status")).toContainText("On.");
  await page.getByRole("button", { name: "Turn it off" }).click();
  await expect(page.getByRole("button", { name: "Turn it off" })).toHaveCount(0);
  await expect(page.getByTestId("two-step-status")).toContainText("Off.");
  expect(await count("auth.two_step_off", seller.id)).toBe(1);
});

test("an accountant without two-step sign-in cannot pass it by", async ({ page }) => {
  await passwordOnly(page, accountant);
  await expect(page).toHaveURL(/\/two-step\/setup$/);
  await expect(page.getByRole("link", { name: "Not now" })).toHaveCount(0);
  await page.goto("/");
  await expect(page).toHaveURL(/\/two-step\/setup$/);
  await page.goto("/settings/accounts");
  await expect(page).toHaveURL(/\/two-step\/setup$/);
});

test("the owner sees every sign-in, with the device, and wrong codes", async ({ page }) => {
  await signIn(page, owner);
  await page.goto("/settings/sign-ins");
  const table = page.getByRole("table", { name: "Sign-ins" });
  await expect(table.getByRole("row").filter({ hasText: "Gave a wrong two-step code" }).first()).toContainText(owner.email);
  await expect(table.getByRole("row").filter({ hasText: "Turned two-step sign-in off" })).toContainText(seller.email);
  const signedIn = table.getByRole("row").filter({ hasText: "Signed in" }).filter({ hasText: owner.email }).first();
  await expect(signedIn).toContainText("Password");
  await expect(signedIn).toContainText(/Chrome|Firefox|Safari|Edge/);
});

test("a session left idle is ended", async ({ page, context, baseURL }) => {
  await signIn(page, owner);
  await expect(page.getByTestId("company-name")).toHaveText(COMPANY);
  // As if the last request was two hours ago.
  const twoHoursAgo = String(Math.floor(Date.now() / 1000) - 2 * 3600);
  await context.addCookies([{ name: "last_active", value: twoHoursAgo, url: baseURL! }]);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in\?ended=idle$/);
  await expect(page.getByText("You were signed out because the app was not used for a while.")).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
});
