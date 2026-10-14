import { expect, test, type Page } from '@playwright/test';
import { F, PHONE, gotoApp, home, openModule, readWorkspaceApi, sharedSession, signedInPage, type Session, keepSignedIn } from './helpers';

let s: Session;
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); });
test.beforeEach(async ({ browser }) => { if (s) await keepSignedIn(browser, s.context, s.page); });
test.afterAll(async () => { await s?.context.close(); });

const editor = (page: Page) => page.getByRole('dialog', { name: 'New sales invoice' });
async function newInvoice(page: Page) {
  await home(page);
  await openModule(page, 'Sales');
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  await expect(editor(page)).toBeVisible();
}
const salesRows = (page: Page) => page.locator('section.card').first().locator('tbody tr');
const salesKinds = ['quotation', 'sales_order', 'delivery', 'sales_invoice', 'credit_note'];

test('SAL-069 Sales list is ordered newest first', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const created = w.documents.filter(d => salesKinds.includes(d.kind)).map(d => d.number).reverse();
  await home(page);
  await openModule(page, 'Sales');
  expect(await salesRows(page).locator('td:first-child').allInnerTexts()).toEqual(created);
});

test('SAL-081 Overview "Recent sales" shows the last 5 invoices with walk-in names', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const last5 = w.documents.filter(d => d.kind === 'sales_invoice').slice(-5).reverse();
  await home(page);
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Recent sales' }) });
  await expect(card.locator('tbody tr')).toHaveCount(5);
  expect(await card.locator('tbody tr td:first-child').allInnerTexts()).toEqual(last5.map(d => d.number));
  if (last5.some(d => d.partyName)) await expect(card).toContainText(F.walkIn);
  expect(last5.some(d => d.partyName)).toBe(true);
});

test('SAL-015 Price is prefilled from the product and editable', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  await expect(editor(page).getByLabel('Line 1 price')).toHaveValue('2400');
  await editor(page).getByLabel('Line 1 price').fill('2500');
  await expect(editor(page).getByLabel('Line 1 price')).toHaveValue('2500');
  await page.keyboard.press('Escape');
});

test('SAL-016 Product with price 0 shows an empty price with placeholder 0.00', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-FREE · ${F.freebie}` });
  await expect(editor(page).getByLabel('Line 1 price')).toHaveValue('');
  await expect(editor(page).getByLabel('Line 1 price')).toHaveAttribute('placeholder', '0.00');
  await page.keyboard.press('Escape');
});

test('SAL-025 Default tax rate from Settings is prefilled on new sales lines', async () => {
  const { page } = s;
  await newInvoice(page);
  await expect(editor(page).getByLabel('Line 1 tax')).toHaveValue('18');
  await editor(page).getByRole('button', { name: 'Add line' }).click();
  await expect(editor(page).getByLabel('Line 2 tax')).toHaveValue('18');
  await page.keyboard.press('Escape');
});

test('SAL-067 Document list filters (type, status, customer, dates, search) combine; Clear filters', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const metro = w.parties.find(p => p.name === F.metro)!;
  const expected = w.documents.filter(d => d.kind === 'sales_invoice' && d.status === 'submitted' && d.partyId === metro.id && d.date >= '2026-10-01' && d.date <= '2026-10-31' && d.number.includes('INV')).map(d => d.number).sort();
  await home(page);
  await openModule(page, 'Sales');
  const all = await salesRows(page).count();
  await page.getByLabel('Document type').selectOption('sales_invoice');
  await page.getByLabel('Document status').selectOption('submitted');
  await page.locator('.list-filters').getByLabel('Customer').selectOption(metro.id);
  await page.getByLabel('From date').fill('2026-10-01');
  await page.getByLabel('To date').fill('2026-10-31');
  await page.getByLabel('Search invoices').fill('INV');
  expect(expected.length).toBeGreaterThan(0);
  expect((await salesRows(page).locator('td:first-child').allInnerTexts()).sort()).toEqual(expected);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(salesRows(page)).toHaveCount(all);
  await expect(page.getByLabel('Document type')).toHaveValue('');
});

test('SAL-070 Details view shows chain, lines, totals, payments and returns', async () => {
  const { page } = s;
  await home(page);
  await openModule(page, 'Sales');
  await page.getByRole('button', { name: 'View invoice INV-2026-0001' }).click();
  const d = page.getByRole('dialog', { name: 'Invoice INV-2026-0001' });
  await expect(d.locator('.invoice-lines')).toContainText(F.led);
  await expect(d.locator('.invoice-lines')).toContainText('1 returned');
  await expect(d.getByText('Document chain')).toBeVisible();
  await expect(d.locator('.invoice-related')).toContainText('CN-2026-0001');
  await expect(d.locator('.invoice-related')).toContainText('REC-0001');
  await expect(d.locator('.invoice-related')).toContainText('CHQ-1004');
  for (const label of ['Subtotal', 'Tax', 'Total', 'Paid', 'Returns / credits', 'Balance due']) await expect(d.locator('.invoice-totals')).toContainText(label);
  await page.keyboard.press('Escape');
});

test('SAL-071 Details Print button opens the print view', async () => {
  const { page, context } = s;
  await home(page);
  await openModule(page, 'Sales');
  await page.getByRole('button', { name: 'View invoice INV-2026-0002' }).click();
  const popup = context.waitForEvent('page');
  await page.getByRole('dialog', { name: 'Invoice INV-2026-0002' }).getByRole('link', { name: 'Print INV-2026-0002' }).click();
  const print = await popup;
  await print.waitForLoadState();
  await expect(print.getByRole('heading', { name: 'Sales invoice' })).toBeVisible({ timeout: 30_000 });
  await expect(print.locator('.doc-title-meta')).toContainText('INV-2026-0002');
  expect(new URL(print.url()).pathname).toMatch(/^\/print\/sales_invoice\//);
  await print.close();
  await page.keyboard.press('Escape');
});

test('SAL-074 Editor on phone: bottom sheet, line table scrolls horizontally, sticky actions', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true });
  await gotoApp(phone.page);
  await newInvoice(phone.page);
  await phone.page.waitForTimeout(500);
  const box = (await editor(phone.page).boundingBox())!;
  const vp = await phone.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const lines = await editor(phone.page).locator('.editor-lines').evaluate(el => ({ overflow: getComputedStyle(el).overflowX, scrolls: el.scrollWidth > el.clientWidth }));
  const actions = await editor(phone.page).locator('.form-actions').evaluate(el => getComputedStyle(el).position);
  await phone.context.close();
  expect(Math.round(box.width)).toBe(vp.w);
  expect(Math.abs(box.y + box.height - vp.h)).toBeLessThan(2);
  expect(lines).toEqual({ overflow: 'auto', scrolls: true });
  expect(actions).toBe('sticky');
});

test('SAL-075 Three buttons: Cancel, Save draft (outline), Submit (violet)', async () => {
  const { page } = s;
  await newInvoice(page);
  const buttons = editor(page).locator('.form-actions > button');
  await expect(buttons).toHaveText(['Cancel', 'Save draft', 'Submit sales invoice']);
  const classes = await buttons.evaluateAll(bs => bs.map(b => b.className));
  expect(classes[0]).toContain('button-outline');
  expect(classes[1]).toContain('button-outline');
  expect(classes[2]).toContain('button-primary');
  expect(await buttons.nth(2).evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(107, 61, 245)');
  await page.keyboard.press('Escape');
});

test('SAL-076 Spinner shows on the pressed button only', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill(F.customer);
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  await editor(page).getByLabel('Line 1 quantity').fill('1');
  await page.route('**/api/workspace', async route => { if (route.request().method() === 'POST') await new Promise(r => setTimeout(r, 1500)); await route.continue().catch(() => undefined); });
  await editor(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(editor(page).getByRole('button', { name: 'Save draft' }).locator('.spin')).toBeVisible();
  await expect(editor(page).getByRole('button', { name: 'Submit sales invoice' }).locator('.spin')).toHaveCount(0);
  expect(await page.locator('.spin').count()).toBe(1);
  await expect(editor(page)).toHaveCount(0, { timeout: 30_000 });
  await page.unroute('**/api/workspace');
});

test('SAL-077 Placeholders Qty / 0.00 / 0 / 0', async () => {
  const { page } = s;
  await newInvoice(page);
  const ph = async (label: string) => editor(page).getByLabel(label).getAttribute('placeholder');
  expect([await ph('Line 1 quantity'), await ph('Line 1 price'), await ph('Line 1 discount'), await ph('Line 1 tax')]).toEqual(['Qty', '0.00', '0', '0']);
  await page.keyboard.press('Escape');
});

test('SAL-078 Unit hint under the quantity after a product is chosen', async () => {
  const { page } = s;
  await newInvoice(page);
  const cell = editor(page).getByLabel('Line 1 quantity').locator('xpath=..');
  await expect(cell.locator('.field-hint')).toHaveCount(0);
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-FAN · ${F.fan}` });
  await expect(cell.locator('.field-hint')).toHaveText('pcs');
  await page.keyboard.press('Escape');
});

test('SAL-079 Line total and Net/Tax/Total are formatted like Rs 4,500', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-FAN · ${F.fan}` });
  await editor(page).getByLabel('Line 1 quantity').fill('1');
  await expect(editor(page).locator('td.amount').first()).toHaveText('Rs 4,500');
  const totals = editor(page).locator('.editor-totals');
  await expect(totals.locator('tr').nth(0)).toContainText('Rs 4,500');
  await expect(totals.locator('tr').nth(1)).toContainText('Rs 810');
  await expect(totals.locator('tr').nth(2)).toContainText('Rs 5,310');
  await page.keyboard.press('Escape');
});

test('SAL-080 Escape closes the editor with unsaved changes [documented: closes immediately, no confirmation, typed data discarded]', async () => {
  const { page, context } = s;
  const before = (await readWorkspaceApi(context.request)).documents.length;
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill(F.customer);
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  let confirmed = false;
  page.once('dialog', d => { confirmed = true; void d.dismiss(); });
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveCount(0);
  expect(confirmed).toBe(false);
  expect((await readWorkspaceApi(context.request)).documents.length).toBe(before);
});

