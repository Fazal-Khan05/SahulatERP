import { expect, test } from "@playwright/test";

test("home page shows the heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("SahulatERP — rebuilding");
});
