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
    if (module === 'Sales') {
      const sales = page.locator('section.card').first();
      await sales.getByLabel('Document type').selectOption('sales_invoice');
      await sales.getByLabel('Search invoices').fill('INV-2026-0001');
      await expect(sales.locator('tbody tr')).toHaveCount(1);
      await expect(sales.getByRole('cell', { name: 'Al-Noor Electronics' })).toBeVisible();
      await sales.getByRole('button', { name: 'View invoice INV-2026-0001' }).click();
      await expect(page.getByRole('dialog', { name: 'Invoice INV-2026-0001' })).toBeVisible();
      await page.getByRole('dialog', { name: 'Invoice INV-2026-0001' }).getByRole('button', { name: 'Close dialog' }).click();
      await sales.getByLabel('Customer').selectOption('c-2');
      await expect(sales.getByText('No sales documents match these filters.')).toBeVisible();
      await sales.getByRole('button', { name: 'Clear filters' }).click();
      expect(await sales.locator('tbody tr').count()).toBeGreaterThan(1);
    }
    if (module === 'Inventory') {
      const inventory = page.locator('section.card').first();
      await inventory.getByLabel('Search inventory').fill('HM-002');
      await expect(inventory.locator('tbody tr')).toHaveCount(1);
      await inventory.getByLabel('Warehouse filter').selectOption('lhe-main');
      await expect(inventory.getByRole('heading', { name: 'Stock in Lahore · Distribution' })).toBeVisible();
      await inventory.getByLabel('Stock level').selectOption('out');
      await expect(inventory.getByText('No products match these filters.')).toBeVisible();
      await inventory.getByRole('button', { name: 'Clear filters' }).click();
      await page.getByRole('button', { name: 'View Rechargeable Desk Fan' }).click();
      const item = page.getByRole('dialog', { name: 'Rechargeable Desk Fan' });
      await expect(item).toBeVisible();
      await expect(item.getByText('Stock by warehouse')).toBeVisible();
      await expect(item.getByRole('cell', { name: 'Karachi · Main' }).first()).toBeVisible();
      await expect(item.getByRole('cell', { name: 'Lahore · Distribution' }).first()).toBeVisible();
      await item.getByRole('button', { name: 'Close dialog' }).click();
      await page.getByRole('button', { name: 'Edit Rechargeable Desk Fan' }).click();
      const edit = page.getByRole('dialog', { name: 'Edit Rechargeable Desk Fan' });
      await expect(edit.getByLabel('New quantity')).toBeVisible();
      await edit.getByLabel('Warehouse').selectOption('lhe-main');
      await expect(edit.getByLabel('Current quantity')).not.toHaveValue('');
      await edit.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('dialog', { name: 'Rechargeable Desk Fan' }).getByRole('button', { name: 'Close dialog' }).click();
      await page.getByRole('button', { name: 'Transfer stock' }).click();
      const transfer = page.getByRole('dialog', { name: 'Transfer stock' });
      await expect(transfer).toBeVisible();
      await transfer.getByLabel('Product').selectOption('i-4');
      await transfer.getByLabel('To warehouse').selectOption('lhe-main');
      await transfer.getByLabel('Quantity to move').fill('280');
      await expect(transfer.locator('.stock-transfer-preview').getByText('Lahore · Distribution')).toBeVisible();
      await transfer.getByRole('button', { name: 'Cancel' }).click();
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
