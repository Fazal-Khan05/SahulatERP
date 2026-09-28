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
  await expect(page.getByRole('button', { name: 'Tax & FBR' })).toHaveCount(0);
  await expect(page.getByText('FBR simulations to review')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'View invoice INV-2026-0001' }).click();
  const invoice = page.getByRole('dialog', { name: 'Invoice INV-2026-0001' });
  await expect(invoice).toBeVisible();
  await expect(invoice.getByText('Al-Noor Electronics')).toBeVisible();
  await expect(invoice.getByText('LED Panel Light · 24W')).toBeVisible();
  await expect(invoice.getByText('Smart Extension Board')).toBeVisible();
  await expect(invoice.getByText('REC-0001')).toBeVisible();
  await expect(invoice.getByText('Balance due')).toBeVisible();
  await expect(invoice.locator('.invoice-balance')).toContainText('Rs 283,200');
  await invoice.getByRole('button', { name: 'Close dialog' }).click();
  for (const module of ['Sales','Purchasing','Imports & costing','Inventory','Collections','Commissions','Payroll','Accounting','Reports','Settings']) {
    await page.locator('button.nav-item').filter({ hasText: module }).click();
    await expect(page.locator('h1')).toContainText(module);
    if (module === 'Inventory') {
      await page.getByRole('button', { name: 'Increase stock' }).last().click();
      const increase = page.getByRole('dialog', { name: 'Increase inventory' });
      await expect(increase).toBeVisible();
      await increase.getByLabel('Increase LED Panel Light · 24W').fill('10');
      await expect(increase.getByText('1 product selected')).toBeVisible();
      await increase.getByLabel('Same quantity for all').fill('2');
      await increase.getByRole('button', { name: 'Fill all' }).click();
      await expect(increase.getByText('6 products selected')).toBeVisible();
      await increase.getByRole('button', { name: 'Cancel' }).click();
    }
  }
  const initialUrl = page.url();
  await page.getByRole('button', { name: /Switch company/ }).click();
  await expect(page.getByRole('menuitem', { name: /Sahulat Trading Co/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Design Partner/ })).toBeVisible();
  expect(page.url()).toBe(initialUrl);
  await page.getByRole('menuitem', { name: /Sahulat Trading Co/ }).click();
  expect(page.url()).toBe(initialUrl);
  await page.getByRole('button', { name: /Switch company/ }).click();
  await page.getByRole('menuitem', { name: /Design Partner/ }).click();
  await expect(page.getByRole('button', { name: /Switch company, current company Design Partner/ })).toBeVisible();
});
