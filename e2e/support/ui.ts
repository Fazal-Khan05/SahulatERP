import { expect, test as base, type Page, type Request } from "@playwright/test";
import type { TestUser } from "./admin";
import { freshCode } from "./two-step";

/**
 * Signs in with the password and, for an account with an authenticator app, its code. An account
 * without one is offered the setup; this passes it by ("Not now") where the role allows.
 */
export async function signIn(page: Page, user: Pick<TestUser, "email" | "password" | "totp">) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/sign-in$/);
  await page.waitForURL((url) => url.pathname !== "/sign-in");
  if (new URL(page.url()).pathname === "/two-step") await giveCode(page, user);
  else if (new URL(page.url()).pathname === "/two-step/setup") {
    const notNow = page.getByRole("link", { name: "Not now" });
    if (await notNow.isVisible()) {
      await notNow.click();
      await page.waitForURL((url) => !url.pathname.startsWith("/two-step"));
    }
  }
}

/** Gives the authenticator app's code on the code page. */
export async function giveCode(page: Page, user: Pick<TestUser, "email" | "totp">) {
  if (!user.totp) throw new Error(`${user.email} has no authenticator app in this test`);
  await page.getByLabel("Code", { exact: true }).fill(await freshCode(user.totp));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname !== "/two-step");
}

/** The labels in the left rail, links and not-yet-built entries alike, in order. */
export async function railLabels(page: Page): Promise<string[]> {
  const rail = page.getByRole("navigation", { name: "Main" });
  await expect(rail.getByRole("link", { name: "Home" })).toBeVisible();
  return rail.locator("a, span[aria-disabled]").allTextContents();
}

/**
 * `test` with one addition: a test fails if its page raised an uncaught error or React reported
 * that the server and the browser rendered different markup.
 */
export const test = base.extend<{ failOnPageError: void }>({
  failOnPageError: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" && /hydrat/i.test(message.text())) problems.push(message.text().slice(0, 300));
      });
      await use();
      expect(problems, "errors raised in the page").toEqual([]);
    },
    { auto: true },
  ],
});

/** A server action call, as opposed to any other POST the page makes. */
export function isServerAction(request: Request): boolean {
  return request.method() === "POST" && "next-action" in request.headers();
}

/**
 * Creates a company as the signed-in user and takes it through the setup wizard with the usual
 * answers, not registered for sales tax. Ends on the inbox.
 */
export async function createCompany(page: Page, name: string) {
  await page.getByLabel("Company name").fill(name);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await page.locator('input[name="salesTaxRegistered"][value="no"]').check();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
}
