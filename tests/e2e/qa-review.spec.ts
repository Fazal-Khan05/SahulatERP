import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const evidence = join(process.cwd(), 'reports', 'qa-2026-09-29', 'evidence');
mkdirSync(evidence, { recursive: true });

test('read-only full-workspace QA review', async ({ page, request }) => {
  test.setTimeout(300_000);
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!password) test.skip(true, 'Owner credentials are unavailable in the local test environment.');
  const observations: Record<string, unknown> = { modules: {}, dialogs: {}, rolePreview: {}, browserErrors: [] };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  if (await page.getByRole('heading', { name: 'Welcome back' }).isVisible()) {
    await page.getByLabel('Email address').fill(process.env.BOOTSTRAP_OWNER_EMAIL || 'owner@sahulaterp.com');
    await page.locator('input[type="password"]').fill(password!);
    await page.getByRole('button', { name: 'Sign in securely' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  observations.revision = await page.locator('.demo-note small').innerText();
  observations.apiBoundaries = {
    anonymousGet: (await request.get('/api/workspace?tenant=00000000-0000-0000-0000-000000000000')).status(),
    missingTenant: (await page.request.get('/api/workspace')).status(),
    nonMemberTenant: (await page.request.get('/api/workspace?tenant=00000000-0000-0000-0000-000000000000')).status(),
  };
  await page.keyboard.press('ControlOrMeta+k');
  observations.searchShortcutOpened = await page.getByRole('dialog').count() > 0 || await page.locator('input[type="search"]').count() > 0;

  const modules = ['Overview', 'Sales', 'Purchasing', 'Imports & costing', 'Inventory', 'Collections', 'Commissions', 'Payroll', 'Accounting', 'Reports', 'Settings'];
  for (const module of modules) {
    await page.locator('button.nav-item').filter({ hasText: module }).click();
    await expect(page.locator('h1')).toContainText(module);
    const key = module.toLowerCase().replaceAll(/[^a-z]+/g, '-');
    const headings = await page.locator('main h2').allTextContents();
    const buttons = await page.locator('main button').evaluateAll(nodes => nodes.filter(node => (node as HTMLElement).offsetParent !== null).map(node => ({ text: (node.textContent || '').trim(), label: node.getAttribute('aria-label'), disabled: (node as HTMLButtonElement).disabled })));
    const tableRows = await page.locator('main table tbody tr').count();
    (observations.modules as Record<string, unknown>)[module] = { headings, buttons, tableRows };
    await page.screenshot({ path: join(evidence, `desktop-${key}.png`), fullPage: true });
  }

  await page.locator('button.nav-item').filter({ hasText: 'Overview' }).click();
  const beforeBranch = await page.locator('main').innerText();
  await page.getByRole('button', { name: 'All branches' }).click();
  observations.branchButtonChangedPage = (await page.locator('main').innerText()) !== beforeBranch;
  observations.branchMenuCount = await page.getByRole('menu').count();

  for (const module of ['Sales', 'Purchasing', 'Imports & costing', 'Collections', 'Commissions', 'Payroll', 'Accounting', 'Reports', 'Settings']) {
    await page.locator('button.nav-item').filter({ hasText: module }).click();
    const action = page.getByRole('button', { name: 'New transaction' });
    if (await action.count()) {
      await action.click();
      const dialog = page.getByRole('dialog');
      (observations.dialogs as Record<string, string>)[module] = await dialog.getByRole('heading').innerText();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    }
  }

  await page.locator('button.nav-item').filter({ hasText: 'Sales' }).click();
  const sales = page.locator('section.card').first();
  const salesBase = await sales.locator('tbody tr').count();
  await sales.getByLabel('Document type').selectOption('sales_invoice');
  await sales.getByLabel('Search invoices').fill('INV-2026-0001');
  expect(await sales.locator('tbody tr').count()).toBe(1);
  await sales.getByLabel('Customer').selectOption('c-2');
  expect(await sales.getByText('No sales documents match these filters.').isVisible()).toBe(true);
  await sales.getByRole('button', { name: 'Clear filters' }).click();
  expect(await sales.locator('tbody tr').count()).toBe(salesBase);
  await sales.getByLabel('From date').fill('2026-10-01');
  observations.salesDateFromResults = await sales.locator('tbody tr').count();
  await sales.getByRole('button', { name: 'Clear filters' }).click();
  await sales.getByRole('button', { name: 'View invoice INV-2026-0002' }).click();
  const returnedInvoice = page.getByRole('dialog', { name: 'Invoice INV-2026-0002' });
  observations.returnedInvoiceBalance = await returnedInvoice.locator('.invoice-balance').innerText();
  await returnedInvoice.getByRole('button', { name: 'Close dialog' }).click();

  await page.locator('button.nav-item').filter({ hasText: 'Inventory' }).click();
  const inventory = page.locator('section.card').first();
  await inventory.getByLabel('Search inventory').fill('HM-002');
  expect(await inventory.locator('tbody tr').count()).toBe(1);
  await inventory.getByLabel('Warehouse filter').selectOption('lhe-main');
  observations.warehouseRow = await inventory.locator('tbody tr').first().innerText();
  await inventory.getByLabel('Stock level').selectOption('out');
  expect(await inventory.getByText('No products match these filters.').isVisible()).toBe(true);
  await inventory.getByRole('button', { name: 'Clear filters' }).click();
  await inventory.getByLabel('Category').selectOption('Home');
  observations.homeCategoryRows = await inventory.locator('tbody tr').count();
  await inventory.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: 'Edit Rechargeable Desk Fan' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Rechargeable Desk Fan' });
  await edit.getByLabel('Warehouse').selectOption('lhe-main');
  observations.editLahoreCount = await edit.getByLabel('Current quantity').inputValue();
  await edit.getByLabel('New quantity').fill('999');
  observations.editDifference = await edit.locator('.item-details-change').innerText();
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog', { name: 'Rechargeable Desk Fan' }).getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Transfer stock' }).click();
  const transfer = page.getByRole('dialog', { name: 'Transfer stock' });
  observations.transferInitialAvailable = await transfer.locator('.stock-transfer-preview').innerText();
  await transfer.getByRole('button', { name: 'Cancel' }).click();

  await page.locator('button.nav-item').filter({ hasText: 'Settings' }).click();
  for (const role of ['Owner', 'Accountant', 'Sales Manager', 'Salesperson', 'Recovery Officer', 'Warehouse Manager', 'Payroll Administrator', 'Auditor']) {
    await page.getByLabel('View as role').selectOption(role);
    (observations.rolePreview as Record<string, unknown>)[role] = {
      modules: await page.locator('button.nav-item').allTextContents(),
      previewControlVisible: await page.getByLabel('View as role').count() > 0,
    };
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await page.locator('button.nav-item').filter({ hasText: 'Settings' }).click();
  }

  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const module of ['Overview', 'Sales', 'Inventory']) {
      if (width === 390) {
        await page.getByRole('button', { name: 'Overview', exact: true }).count();
        const menu = page.locator('button.mobile-menu');
        await menu.click();
      }
      await page.locator('button.nav-item').filter({ hasText: module }).click();
      await expect(page.locator('h1')).toContainText(module);
      const key = module.toLowerCase();
      await page.screenshot({ path: join(evidence, `${width}-${key}.png`), fullPage: true });
      (observations as Record<string, unknown>)[`${width}-${key}-pageOverflow`] = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      (observations as Record<string, unknown>)[`${width}-${key}-tableScrollNeeded`] = await page.locator('.table-scroll').evaluateAll(nodes => nodes.some(node => node.scrollWidth > node.clientWidth));
    }
  }
  observations.browserErrors = errors;
  writeFileSync(join(evidence, 'observations.json'), JSON.stringify(observations, null, 2));
});
