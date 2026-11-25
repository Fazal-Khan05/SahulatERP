import { expect } from "@playwright/test";
import { createUser, hasE2EEnv, type TestUser } from "./support/admin";
import { createCompany, test } from "./support/ui";

// The founder's switch (2026-11-25): with the site's setting TWO_STEP_REQUIRED=off, two-step
// sign-in is nobody's duty, an owner's included. The app under test must have the setting too,
// so this runs only when the tests themselves are started with it, on a port of their own:
//
//   TWO_STEP_REQUIRED=off NEXT_PUBLIC_APP_URL=http://localhost:3007 npx playwright test e2e/two-step-optional.spec.ts
//
// e2e/two-step.spec.ts is the rule as it holds without the setting.

const OFF = process.env.TWO_STEP_REQUIRED?.trim().toLowerCase() === "off";

test.describe.configure({ mode: "serial" });
test.skip(!hasE2EEnv(), "needs the Supabase and database settings in .env.local");
test.skip(!OFF, "runs only when started with TWO_STEP_REQUIRED=off");

const COMPANY = "E2E Optional Two Step Traders";

let owner: TestUser;

test.beforeAll(async () => {
  owner = await createUser("optional-owner", { canCreateCompany: true, twoStep: false });
});

test("with the rule switched off, an owner is offered two-step sign-in and may say Not now", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Offered, in the words everyone else reads, and with a way past it.
  await expect(page).toHaveURL(/\/two-step\/setup$/);
  await expect(page.getByText("Protect your account with a code")).toBeVisible();
  await expect(page.getByText("Your role needs two-step sign-in.")).toHaveCount(0);
  await page.getByRole("link", { name: "Not now" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/two-step"));

  // The owner creates a company and works in it without ever giving a code.
  await page.goto("/create-company");
  await expect(page).toHaveURL(/\/create-company$/);
  await createCompany(page, COMPANY);
  await expect(page.getByTestId("company-name")).toHaveText(COMPANY);
  await page.goto("/settings/members");
  await expect(page).toHaveURL(/\/settings\/members$/);
  await expect(page.getByRole("button", { name: "Invite" })).toBeVisible();

  // Your account says it is off and theirs to turn on; nothing says their role needs it.
  await page.goto("/account");
  await expect(page.getByTestId("two-step-status")).toContainText("Off.");
  await expect(page.getByRole("link", { name: "Set it up" })).toBeVisible();
  await expect(page.getByText("Your role needs it")).toHaveCount(0);
});
