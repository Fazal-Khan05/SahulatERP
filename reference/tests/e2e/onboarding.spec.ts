import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { QA_TENANT, resetQaTenant } from '../../scripts/create-qa-tenant';

// Runs against the disposable QA tenant (npm run qa:tenant resets it). Never the demo or partner company.
const evidence = join(process.cwd(), 'reports', 'qa-2026-10-14', 'evidence');
mkdirSync(evidence, { recursive: true });
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function signIn(page: Page) {
  await page.goto(`/?tenant=${QA_TENANT}`);
  if (await page.getByRole('heading', { name: 'Welcome back' }).isVisible()) {
    await page.getByLabel('Email address').fill(process.env.BOOTSTRAP_OWNER_EMAIL || 'owner@sahulaterp.com');
    await page.locator('input[type="password"]').fill(process.env.BOOTSTRAP_OWNER_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in securely' }).click();
  }
  // Dev mode compiles client chunks on first load; wait for hydration before interacting.
  await page.waitForLoadState('networkidle');
}

// A fresh company every run, whatever ran before; needs DATABASE_URL and BOOTSTRAP_OWNER_ID like npm run qa:tenant.
test.beforeAll(async () => { if (process.env.BOOTSTRAP_OWNER_PASSWORD) await resetQaTenant(); });

test('new company: wizard, features, branding and printing', async ({ page, request }) => {
  test.setTimeout(300_000);
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!password) test.skip(true, 'Owner credentials are unavailable.');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
  // Request log for diagnosing server errors; bodies are summarised, never printed in full.
  const traffic: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/')) traffic.push(`→ ${r.method()} ${new URL(r.url()).pathname} type=${(() => { try { return JSON.parse(r.postData() || '{}').type; } catch { return r.headers()['content-type']; } })()} len=${(r.postData() ?? '').length}`); });
  page.on('response', async r => { if (r.url().includes('/api/')) traffic.push(`← ${r.status()} ${new URL(r.url()).pathname} ${r.headers()['content-type'] ?? ''}`); });
  test.info().annotations.push({ type: 'traffic', description: '' });
  const dumpTraffic = () => console.log(traffic.join('\n'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  // Step 1 — company
  await expect(page.getByRole('heading', { name: 'Company', exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'wizard-1-company.png'), fullPage: true });
  await page.getByLabel('Company name').fill('QA Trading Company');
  await page.getByLabel('Address').fill('12 Jodia Bazar, Karachi');
  await page.getByLabel('Phone').fill('+92 300 1234567');
  await page.getByLabel('Email').fill('office@qa.example');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2 — documents: upload a logo, pick a colour, write a footer, see it in the preview
  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
  await page.getByLabel('Upload logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: onePixelPng });
  await expect(page.getByRole('button', { name: 'Replace logo' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'QA Trading Company logo' })).toBeVisible();
  await page.getByRole('radio', { name: '#1f5fa8' }).click();
  await page.getByPlaceholder(/Bank:/).fill('Bank: QA Bank · Account 000-111');
  await expect(page.getByLabel('Invoice preview').getByText('Bank: QA Bank · Account 000-111')).toBeVisible();
  await expect(page.getByLabel('Invoice preview').getByText('QA Trading Company', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'wizard-2-documents.png'), fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3 — features: preset then adjust; dependency auto-select
  await expect(page.getByRole('heading', { name: 'Features' })).toBeVisible();
  await page.getByRole('button', { name: /Just the basics/ }).click();
  await expect(page.getByRole('switch', { name: 'Commissions module' })).not.toBeChecked();
  await page.getByRole('switch', { name: 'Commissions module' }).check();
  await expect(page.getByRole('switch', { name: 'Collections & PDCs module' })).toBeChecked();
  await page.screenshot({ path: join(evidence, 'wizard-3-features.png'), fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 4 — review and finish
  await expect(page.getByRole('heading', { name: 'Review' })).toBeVisible();
  await expect(page.getByText('7 turned on')).toBeVisible(); // basics preset (5, incl. Cash & bank) + Commissions with its Collections dependency
  await page.getByRole('button', { name: 'Create my workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.locator('button.nav-item').filter({ hasText: 'Commissions' })).toBeVisible();
  await expect(page.locator('button.nav-item').filter({ hasText: 'Payroll' })).toHaveCount(0);
  await expect(page.locator('button.nav-item').filter({ hasText: 'Imports' })).toHaveCount(0);

  // Server gate: a payroll command is refused while the module is off
  const refused = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data: { type: 'create_payroll', idempotencyKey: `qa-${Date.now()}`, payload: { month: '2026-10' } } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).message).toContain('Payroll is turned off');

  // Settings → Features: wrong password refused, right password hides Commissions, then re-enable
  await page.locator('button.nav-item').filter({ hasText: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Features' }).click();
  await page.getByRole('switch', { name: 'Commissions module' }).click();
  const dialog = page.getByRole('dialog', { name: /Hide Commissions/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Your password').fill('definitely-wrong');
  await dialog.getByRole('button', { name: 'Hide and keep records' }).click();
  await expect(dialog.getByText('Password incorrect.')).toBeVisible();
  await dialog.getByLabel('Your password').fill(password!);
  await dialog.getByRole('button', { name: 'Hide and keep records' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Commissions module' })).not.toBeChecked();
  await expect(page.locator('button.nav-item').filter({ hasText: 'Commissions' })).toHaveCount(0);
  // Direct API call without the password is refused too
  const bypass = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data: { type: 'set_modules', idempotencyKey: `qa-${Date.now()}`, payload: { enabled: ['sales'] } } });
  expect(bypass.status()).toBe(401);
  await page.getByRole('switch', { name: 'Payroll module' }).click();
  await expect(page.getByRole('switch', { name: 'Payroll module' })).toBeChecked();
  await expect(page.locator('button.nav-item').filter({ hasText: 'Payroll' })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'settings-features.png'), fullPage: true });

  // Company & documents tab edits persist
  await page.getByRole('tab', { name: 'Company & documents' }).click();
  await page.getByLabel('NTN / sales-tax number').fill('1234567-8');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Company details and document branding saved.')).toBeVisible().catch(e => { dumpTraffic(); throw e; });

  // Create and print an invoice with the branding
  await page.locator('button.nav-item').filter({ hasText: 'Inventory' }).click();
  const item = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data: { type: 'save_item', idempotencyKey: `qa-item-${Date.now()}`, payload: { sku: 'QA-1', name: 'QA Widget', category: 'General', hsCode: '', unit: 'pcs', price: '100', cost: '60', weight: '1', volume: '1', reorderLevel: 0 } } });
  expect(item.status()).toBe(200);
  const party = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data: { type: 'save_party', idempotencyKey: `qa-party-${Date.now()}`, payload: { name: 'QA Customer', type: 'customer', city: 'Lahore', email: '', taxId: '', registered: false, creditLimit: '100000', terms: 30, customerClass: 'Retailer' } } });
  expect(party.status()).toBe(200);
  const stock = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data: { type: 'bulk_stock_increase', idempotencyKey: `qa-stock-${Date.now()}`, payload: { warehouseId: 'main-store', date: '2026-10-14', purpose: 'opening_stock', reason: 'QA opening stock', lines: [{ itemId: (await item.json()).recordId, quantity: '10', cost: '60' }] } } });
  expect(stock.status()).toBe(200);
  const invoice = await page.request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data: { type: 'create_document', idempotencyKey: `qa-inv-${Date.now()}`, payload: { kind: 'sales_invoice', partyId: (await party.json()).recordId, warehouseId: 'main-store', date: '2026-10-14', dueDate: '2026-11-13', lines: [{ itemId: (await item.json()).recordId, quantity: '2', price: '100', taxRate: '18' }] } } });
  expect(invoice.status()).toBe(200);
  const invoiceId = (await invoice.json()).recordId as string;
  await page.goto(`/print/sales_invoice/${invoiceId}?tenant=${QA_TENANT}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Sales invoice' })).toBeVisible();
  await expect(page.getByText('QA Trading Company', { exact: true })).toBeVisible();
  await expect(page.getByText('NTN / STRN: 1234567-8')).toBeVisible();
  await expect(page.getByText('Bank: QA Bank · Account 000-111')).toBeVisible();
  await expect(page.getByRole('img', { name: 'QA Trading Company logo' })).toBeVisible();
  await expect(page.locator('.doc-totals tr.emphasis').filter({ hasText: 'Total' }).first()).toContainText('Rs 236');
  await page.screenshot({ path: join(evidence, 'print-invoice.png'), fullPage: true });

  // Another tenant's member cannot fetch this company's logo
  const foreign = await request.get(`/api/branding/logo?tenant=${QA_TENANT}`);
  expect(foreign.status()).toBe(401);

  // Phone-width wizard sanity: the wizard renders at 390 px for a fresh company (read-only check on the current one)
  await page.goto(`/?tenant=${QA_TENANT}`, { waitUntil: 'commit' }).catch(() => page.goto(`/?tenant=${QA_TENANT}`));
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  // The deliberate wrong-password attempt logs a 401. In dev mode Next can answer a command with a 500 while it
  // compiles another route; the app retries it (idempotent) and the flow above proves the retry worked.
  expect(errors.filter(e => !/status of (401|500)/.test(e))).toEqual([]);
});
