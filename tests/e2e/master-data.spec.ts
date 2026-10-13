import { expect, test, type Page } from '@playwright/test';
import { QA_TENANT } from '../../scripts/create-qa-tenant';

// Runs on the disposable QA tenant after onboarding.spec.ts has set it up (or any set-up company).
async function signIn(page: Page) {
  await page.goto(`/?tenant=${QA_TENANT}`);
  if (await page.getByRole('heading', { name: 'Welcome back' }).isVisible()) {
    await page.getByLabel('Email address').fill(process.env.BOOTSTRAP_OWNER_EMAIL || 'owner@sahulaterp.com');
    await page.locator('input[type="password"]').fill(process.env.BOOTSTRAP_OWNER_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in securely' }).click();
  }
  await page.waitForLoadState('networkidle');
  // If this runs before onboarding.spec.ts on a fresh QA tenant, finish setup through the API so the test is order-independent.
  await page.getByRole('heading', { name: /^(Overview|Company)/ }).first().waitFor({ timeout: 60_000 });
  if (await page.getByRole('heading', { name: 'Company', exact: true }).isVisible()) {
    // Same idempotent retry the app's own client uses, for the dev server's occasional compile race.
    const post = async (type: string, payload: Record<string, unknown>) => {
      const data = { type, payload, idempotencyKey: `md-setup-${type}-${Date.now()}` };
      let response = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data });
      if (response.status() >= 500) response = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data });
      expect(response.status(), `${type} during setup`).toBe(200);
    };
    await post('save_company', { name: 'QA Trading Company', address: '12 Jodia Bazar, Karachi' });
    await post('set_modules', { enabled: ['sales', 'purchasing', 'inventory', 'collections', 'commissions', 'reports'] });
    await post('complete_setup', {});
    await page.reload();
    await page.waitForLoadState('networkidle');
  }
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
}
const openModule = (page: Page, module: string) => page.locator('button.nav-item').filter({ hasText: module }).click();

test('master data: forms, archive, CSV import and export', async ({ page }) => {
  test.setTimeout(240_000);
  if (!process.env.BOOTSTRAP_OWNER_PASSWORD) test.skip(true, 'Owner credentials are unavailable.');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const stamp = Date.now().toString().slice(-6);

  // Customers: create through the form, then edit
  await openModule(page, 'Sales');
  await page.getByRole('tab', { name: 'Customers' }).click();
  await page.getByRole('button', { name: 'New customer' }).click();
  const form = page.getByRole('dialog', { name: 'New customer' });
  await form.getByLabel('Customer name').fill(`Form Customer ${stamp}`);
  await form.getByLabel('City').fill('Multan');
  await form.getByLabel('Credit limit (PKR)').fill('250000');
  await form.getByRole('button', { name: 'Add customer' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByText(`Form Customer ${stamp} saved.`)).toBeVisible();
  const row = page.locator('tbody tr').filter({ hasText: `Form Customer ${stamp}` });
  await expect(row).toContainText('Multan');
  await expect(row).toContainText('Rs 250,000');
  // Duplicate name is refused with the engine's message
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByRole('dialog', { name: 'New customer' }).getByLabel('Customer name').fill(`form customer ${stamp}`);
  await page.getByRole('dialog', { name: 'New customer' }).getByRole('button', { name: 'Add customer' }).click();
  await expect(page.getByRole('dialog', { name: 'New customer' }).getByRole('alert')).toContainText('already exists');
  await page.getByRole('dialog', { name: 'New customer' }).getByRole('button', { name: 'Cancel' }).click();

  // Archive hides from the active list and from the new-invoice picker; restore brings it back
  await row.getByRole('button', { name: `Archive Form Customer ${stamp}` }).click();
  await expect(page.getByText(`Form Customer ${stamp} archived`)).toBeVisible();
  await expect(page.locator('tbody tr').filter({ hasText: `Form Customer ${stamp}` })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Documents' }).click();
  await page.getByRole('button', { name: 'New invoice' }).click();
  await expect(page.getByRole('dialog').getByLabel('Party').locator('option', { hasText: `Form Customer ${stamp}` })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('tab', { name: 'Customers' }).click();
  await page.getByLabel('Record status').selectOption('archived');
  await page.locator('tbody tr').filter({ hasText: `Form Customer ${stamp}` }).getByRole('button', { name: `Restore Form Customer ${stamp}` }).click();
  await expect(page.getByText(`Form Customer ${stamp} restored.`)).toBeVisible();

  // Products: CSV import with a bad row is rejected naming the row; a clean file imports
  await openModule(page, 'Inventory');
  await page.getByRole('tab', { name: 'Products' }).click();
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const importDialog = page.getByRole('dialog', { name: /Import products/ });
  const bad = `Item Code,Product Name,Selling Price,UOM\nIMP-${stamp}-1,Imported One,100,pcs\n,Missing Code,50,pcs\nIMP-${stamp}-3,Imported Three,75,box\n`;
  await importDialog.getByLabel('Choose CSV file').setInputFiles({ name: 'products.csv', mimeType: 'text/csv', buffer: Buffer.from(bad) });
  await expect(importDialog.getByText('Item Code → SKU / code')).toBeVisible();
  await expect(importDialog.getByText('3 rows in the file')).toBeVisible();
  await importDialog.getByRole('button', { name: /Import 3 rows/ }).click();
  await expect(importDialog.getByRole('alert')).toContainText('Row 3: SKU is required');
  const good = `Item Code,Product Name,Selling Price,UOM\nIMP-${stamp}-1,Imported One,100,pcs\nIMP-${stamp}-3,Imported Three,75,box\n`;
  await importDialog.getByLabel('Choose CSV file').setInputFiles({ name: 'products.csv', mimeType: 'text/csv', buffer: Buffer.from(good) });
  await importDialog.getByRole('button', { name: /Import 2 rows/ }).click();
  await expect(importDialog).toHaveCount(0);
  await expect(page.getByText('Imported 2 items: 2 created, 0 updated.')).toBeVisible();
  await expect(page.locator('tbody tr').filter({ hasText: `IMP-${stamp}-3` })).toContainText('box');

  // Export produces a CSV with the importer's headers
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const file = await download;
  const text = await (await file.createReadStream()).toArray().then(chunks => Buffer.concat(chunks as Buffer[]).toString('utf8'));
  expect(text.split('\n')[0]).toBe('sku,name,category,unit,price,cost,hsCode,reorderLevel,weight,volume');
  expect(text).toContain(`IMP-${stamp}-1,Imported One`);

  // Warehouses and branches
  await page.getByRole('tab', { name: 'Warehouses' }).click();
  await page.getByLabel('New branch name').fill(`Branch ${stamp}`);
  await page.getByRole('button', { name: 'Add branch' }).click();
  await expect(page.getByText(`Branch Branch ${stamp} saved.`)).toBeVisible();
  await page.getByRole('button', { name: 'New warehouse' }).click();
  const wh = page.getByRole('dialog', { name: 'New warehouse' });
  await wh.getByLabel('Warehouse name').fill(`Godown ${stamp}`);
  await wh.getByLabel('Branch').selectOption({ label: `Branch ${stamp}` });
  await wh.getByRole('button', { name: 'Add warehouse' }).click();
  await expect(page.getByText(`Warehouse Godown ${stamp} saved.`)).toBeVisible();
  await expect(page.locator('tbody tr').filter({ hasText: `Godown ${stamp}` })).toContainText(`Branch ${stamp}`);

  // Commission plan editing with rate pairs (turn the module on first; turning on needs no password)
  const current = await (await page.request.get(`/api/workspace?tenant=${QA_TENANT}`)).json();
  const enabled = Array.from(new Set([...current.workspace.modules, 'sales', 'collections', 'commissions']));
  expect((await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data: { type: 'set_modules', idempotencyKey: `md-modules-${Date.now()}`, payload: { enabled } } })).status()).toBe(200);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await openModule(page, 'Commissions');
  await page.getByRole('tab', { name: 'Plans' }).click();
  await page.locator('tbody tr').first().getByRole('button', { name: /^Edit / }).click();
  const plan = page.getByRole('dialog', { name: 'Edit commission plan' });
  await plan.getByLabel('Plan type').selectOption('category');
  await plan.getByLabel('Category rates').fill('General = 2.5\nLighting = 3');
  await plan.getByRole('button', { name: 'Save changes' }).click();
  await expect(plan).toHaveCount(0);
  await expect(page.locator('tbody tr').first()).toContainText('category');

  expect(errors).toEqual([]);
});
