import { expect, test } from '@playwright/test';

test('owner can sign in and review every ERP module', async ({ page }) => {
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!password) test.skip(true, 'BOOTSTRAP_OWNER_PASSWORD is not configured.');
  await page.goto('/');
  if (await page.getByRole('heading', { name: 'Welcome back' }).isVisible()) {
    await page.getByLabel('Email address').fill(process.env.BOOTSTRAP_OWNER_EMAIL || 'owner@sahulaterp.com');
    await page.locator('input[type="password"]').fill(password!);
    await page.getByRole('button', { name: 'Sign in securely' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  for (const module of ['Sales','Purchasing','Imports & costing','Inventory','Collections','Commissions','Payroll','Accounting','Tax & FBR','Reports','Settings']) {
    await page.locator('button.nav-item').filter({ hasText: module }).click();
    await expect(page.locator('h1')).toContainText(module);
  }
});
