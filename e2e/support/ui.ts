import { expect, test as base, type Page, type Request } from "@playwright/test";
import type { TestUser } from "./admin";

export async function signIn(page: Page, user: Pick<TestUser, "email" | "password">) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/sign-in$/);
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
