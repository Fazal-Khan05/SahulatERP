import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Re-test of the 29 September 2026 SQA findings. Read-only: it opens dialogs and cancels them,
// and never submits, resets or changes hosted demo data.
const evidence = join(process.cwd(), 'reports', 'qa-2026-10-12', 'evidence');
mkdirSync(evidence, { recursive: true });

async function signIn(page: Page) {
  await page.goto('/?tenant=11111111-1111-4111-8111-111111111111');
  if (await page.getByRole('heading', { name: 'Welcome back' }).isVisible()) {
    await page.getByLabel('Email address').fill(process.env.BOOTSTRAP_OWNER_EMAIL || 'owner@sahulaterp.com');
    await page.locator('input[type="password"]').fill(process.env.BOOTSTRAP_OWNER_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in securely' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}
const openModule = (page: Page, module: string) => page.locator('button.nav-item').filter({ hasText: module }).click();

test('SQA findings are fixed in the owner workspace', async ({ page, request, browser }) => {
  test.setTimeout(300_000);
  if (!process.env.BOOTSTRAP_OWNER_PASSWORD) test.skip(true, 'Owner credentials are unavailable.');
  const results: Record<string, unknown> = {};
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  // API boundaries
  results.apiBoundaries = {
    anonymous: (await request.get('/api/workspace?tenant=00000000-0000-0000-0000-000000000000')).status(),
    missingTenant: (await page.request.get('/api/workspace')).status(),
    nonMember: (await page.request.get('/api/workspace?tenant=00000000-0000-0000-0000-000000000000')).status(),
  };
  expect(results.apiBoundaries).toEqual({ anonymous: 401, missingTenant: 403, nonMember: 403 });

  // SQA-10: chart is computed from records
  const chart = page.getByRole('img', { name: /Weekly sales and collections/ });
  await expect(chart).toBeVisible();
  results.chartLabel = await chart.getAttribute('aria-label');

  // SQA-09: search and shortcut
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('dialog', { name: 'Search' });
  await expect(search).toBeVisible();
  await search.getByLabel('Search the workspace').fill('INV-2026-0001');
  await expect(search.getByRole('listitem').filter({ hasText: 'INV-2026-0001' })).toBeVisible();
  await search.getByRole('listitem').filter({ hasText: 'INV-2026-0001' }).click();
  await expect(page.locator('h1')).toContainText('Sales');

  // SQA-17: notifications
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByText('NEEDS ATTENTION')).toBeVisible();
  await page.keyboard.press('Escape');

  // SQA-04: header actions match their module
  const headerDialogs: Record<string, string | null> = {};
  for (const module of ['Sales', 'Purchasing', 'Imports & costing', 'Collections', 'Commissions', 'Payroll', 'Accounting', 'Reports', 'Settings']) {
    await openModule(page, module);
    await expect(page.getByRole('button', { name: 'New transaction' })).toHaveCount(0);
    const action = page.locator('.heading-actions .button-primary');
    if (await action.count()) {
      await action.click();
      const dialog = page.getByRole('dialog');
      headerDialogs[module] = await dialog.getByRole('heading').first().innerText();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    } else headerDialogs[module] = null;
  }
  results.headerDialogs = headerDialogs;
  expect(headerDialogs).toEqual({ Sales: 'New sales invoice', Purchasing: 'New purchase order', 'Imports & costing': null, Collections: 'Record customer receipt', Commissions: null, Payroll: null, Accounting: null, Reports: null, Settings: null });

  // SQA-16: the posting date is shown and defaults to the Karachi calendar day
  await openModule(page, 'Sales');
  await page.locator('.heading-actions .button-primary').click();
  const karachiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
  await expect(page.getByRole('dialog').getByLabel('Posting date')).toHaveValue(karachiToday);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // SQA-08: branch filter changes the data shown
  const sales = page.locator('section.card').first();
  const allRows = await sales.locator('tbody tr').count();
  await page.getByRole('button', { name: /Branch filter/ }).click();
  await page.getByRole('menuitem', { name: 'Lahore' }).click();
  const lahoreRows = await sales.locator('tbody tr').count();
  results.branchFilter = { allRows, lahoreRows };
  expect(lahoreRows).toBeLessThan(allRows);
  await page.getByRole('button', { name: /Branch filter/ }).click();
  await page.getByRole('menuitem', { name: 'All branches' }).click();
  expect(await sales.locator('tbody tr').count()).toBe(allRows);

  // SQA-11: a returned-after-payment invoice shows a customer credit, not a negative balance due
  await sales.getByRole('button', { name: 'View invoice INV-2026-0002' }).click();
  const returned = page.getByRole('dialog', { name: 'Invoice INV-2026-0002' });
  results.returnedInvoiceBalance = await returned.locator('.invoice-balance').innerText();
  expect(results.returnedInvoiceBalance).not.toMatch(/-/);
  await returned.getByRole('button', { name: 'Close dialog' }).click();

  // SQA-15: follow-ups have a home in Collections
  await openModule(page, 'Collections');
  await expect(page.getByRole('heading', { name: 'Recovery follow-ups' })).toBeVisible();

  // Reports reconcile commission payable too
  await openModule(page, 'Reports');
  results.reconciliation = await page.locator('main table tbody tr').allInnerTexts();

  // SQA-05: reset asks first (cancelled here)
  await openModule(page, 'Settings');
  await page.getByRole('button', { name: 'Reset demo' }).click();
  await expect(page.getByRole('dialog', { name: 'Reset the demo company?' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // SQA-07: role preview can be exited without reloading
  for (const role of ['Salesperson', 'Recovery Officer', 'Warehouse Manager', 'Payroll Administrator']) {
    await openModule(page, 'Settings');
    await page.getByLabel('View as role').selectOption(role);
    await expect(page.getByText(`Previewing as ${role}`)).toBeVisible();
    await page.screenshot({ path: join(evidence, `preview-${role.toLowerCase().replaceAll(' ', '-')}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Exit preview' }).click();
    await expect(page.locator('button.nav-item').filter({ hasText: 'Settings' })).toBeVisible();
  }

  for (const module of ['Overview', 'Sales', 'Collections', 'Payroll', 'Reports']) {
    await openModule(page, module);
    await page.screenshot({ path: join(evidence, `desktop-${module.toLowerCase()}.png`), fullPage: true });
  }

  // SQA-13 / SQA-14: mobile
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');
  await openModule(page, 'Sales');
  await expect(page.locator('.table-scroll-hint').first()).toBeVisible();
  results.mobileActionColumnSticky = await page.locator('.table-scroll td:last-child').first().evaluate(node => getComputedStyle(node).position);
  expect(results.mobileActionColumnSticky).toBe('sticky');
  results.mobilePageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(results.mobilePageOverflow).toBe(false);
  await page.screenshot({ path: join(evidence, '390-sales.png'), fullPage: true });

  // SQA-03: password recovery page exists and rejects a missing/expired session
  const anonymous = await browser.newContext();
  const recovery = await anonymous.newPage();
  await recovery.goto('/account/reset');
  await expect(recovery.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
  await expect(recovery.getByText(/expired or was already used/)).toBeVisible();
  await recovery.screenshot({ path: join(evidence, 'account-reset-expired.png') });
  await anonymous.close();

  results.browserErrors = errors;
  writeFileSync(join(evidence, 'regression-results.json'), JSON.stringify(results, null, 2));
  expect(errors).toEqual([]);
});
