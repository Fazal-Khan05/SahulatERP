import { expect, test } from "@playwright/test";

test("a signed-out visitor is sent to the sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
});

test("the forgot-password page offers a reset link and a way back", async ({ page }) => {
  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Forgot your password?");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("an email link without a session is refused", async ({ page }) => {
  await page.goto("/auth/confirm");
  await expect(page.getByTestId("form-error")).toHaveText("This link is not valid. Ask for a new one.");
});

test("an expired email link is refused and its details leave the address bar", async ({ page }) => {
  await page.goto("/auth/confirm#error=access_denied&error_code=otp_expired&error_description=expired");
  await expect(page.getByTestId("form-error")).toHaveText("This link has expired or was already used. Ask for a new one.");
  await expect(page).toHaveURL(/\/auth\/confirm$/);
});

test("an email link that lands on another page is passed to the confirm page", async ({ page }) => {
  await page.goto("/sign-in#error=access_denied&error_code=otp_expired&error_description=expired");
  await expect(page).toHaveURL(/\/auth\/confirm$/);
  await expect(page.getByTestId("form-error")).toHaveText("This link has expired or was already used. Ask for a new one.");
});
