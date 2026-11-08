import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { PHONE, gotoApp, home, openModule, readWorkspaceApi, sharedSession, signedInPage, type Session, keepSignedIn } from './helpers';

let s: Session;
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); });
test.beforeEach(async ({ browser }) => { if (s) await keepSignedIn(browser, s.context, s.page); });
test.afterAll(async () => { await s?.context.close(); });

async function products(page: Page) {
  await home(page);
  await openModule(page, 'Inventory');
  await page.getByRole('tab', { name: 'Products' }).click();
  await expect(page.getByRole('heading', { name: 'Products', level: 2 })).toBeVisible();
}
const productDialog = (page: Page) => page.getByRole('dialog', { name: 'New product' });

test('PRD-053 "Clear filters" resets search and status', async () => {
  const { page } = s;
  await products(page);
  const rows = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Products', level: 2 }) }).locator('tbody tr');
  const all = await rows.count();
  await page.getByLabel('Search products').fill('LED');
  await page.getByLabel('Record status').selectOption('all');
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByLabel('Search products')).toHaveValue('');
  await expect(page.getByLabel('Record status')).toHaveValue('active');
  await expect(rows).toHaveCount(all);
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
});

test('PRD-054 Products table on phone: horizontal scroll hint and bold first column', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true });
  await gotoApp(phone.page);
  await products(phone.page);
  const card = phone.page.locator('section.card').filter({ has: phone.page.getByRole('heading', { name: 'Products', level: 2 }) });
  await expect(card.locator('.table-scroll-hint')).toBeVisible();
  await expect(card.locator('.table-scroll-hint')).toHaveText('Swipe sideways to see every column.');
  const first = await card.locator('tbody tr td:first-child strong').first().evaluate(el => Number(getComputedStyle(el).fontWeight));
  const scroll = await card.locator('.table-scroll').evaluate(el => el.scrollWidth > el.clientWidth);
  await phone.context.close();
  expect(first).toBeGreaterThanOrEqual(600);
  expect(scroll).toBe(true);
});

test('PRD-076 20 MB CSV is refused without freezing the browser [documented: reading stops at the first row over 2,000, then "Import at most 2,000 rows at a time."]', async () => {
  test.setTimeout(120_000);
  const { page } = s;
  await products(page);
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const dialog = page.getByRole('dialog', { name: /Import products from CSV/ });
  await page.evaluate(() => { const w = window as unknown as { qaLongest: number }; w.qaLongest = 0; new PerformanceObserver(list => { for (const e of list.getEntries()) w.qaLongest = Math.max(w.qaLongest, e.duration); }).observe({ type: 'longtask', buffered: false }); });
  const row = 'QA-BULK-000000,Bulk imported product with a fairly long descriptive name for size,General,pcs,1000,800\n';
  const count = Math.ceil(20 * 1024 * 1024 / row.length);
  const csv = 'sku,name,category,unit,price,cost\n' + Array.from({ length: count }, (_, i) => row.replace('000000', String(i).padStart(6, '0'))).join('');
  expect(csv.length).toBeGreaterThan(20 * 1024 * 1024);
  // Chosen from disk as a user would: an in-memory buffer is base64-decoded by Playwright on the page's main
  // thread (several seconds for 20 MB) before the app even sees the file, which this case is not about.
  const file = test.info().outputPath('big.csv');
  writeFileSync(file, csv);
  const started = Date.now();
  await page.getByLabel('Choose CSV file').setInputFiles(file);
  await expect(dialog.getByRole('alert')).toHaveText('Import at most 2,000 rows at a time.', { timeout: 60_000 });
  const elapsed = Date.now() - started;
  const longest = await page.evaluate(() => (window as unknown as { qaLongest: number }).qaLongest);
  test.info().annotations.push({ type: 'measured', description: `refused after ${elapsed} ms; longest main-thread task ${Math.round(longest)} ms` });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(elapsed).toBeLessThan(30_000);
  expect(longest, `longest main-thread block ${Math.round(longest)} ms`).toBeLessThan(1000);
});

test('PRD-088 Placeholders are grey, typed values dark', async () => {
  const { page } = s;
  await products(page);
  await page.getByRole('button', { name: 'New product' }).click();
  const price = productDialog(page).getByRole('spinbutton', { name: /Selling price/ });
  await expect(price).toHaveAttribute('placeholder', /\d/);
  const placeholder = await price.evaluate(el => getComputedStyle(el, '::placeholder').color);
  await price.fill('1234');
  const value = await price.evaluate(el => getComputedStyle(el).color);
  await page.keyboard.press('Escape');
  expect(placeholder).toBe('rgb(100, 100, 100)');
  expect(value).toBe('rgb(41, 45, 52)');
});

test('PRD-090 Product dialog on phone is a bottom sheet with sticky actions', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true });
  await gotoApp(phone.page);
  await products(phone.page);
  await phone.page.getByRole('button', { name: 'New product' }).click();
  const dialog = productDialog(phone.page);
  await expect(dialog).toBeVisible();
  await phone.page.waitForTimeout(500);
  const box = (await dialog.boundingBox())!;
  const vp = await phone.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const actions = await dialog.locator('.form-actions').evaluate(el => ({ position: getComputedStyle(el).position, bottom: getComputedStyle(el).bottom }));
  await phone.context.close();
  expect(Math.round(box.width)).toBe(vp.w);
  expect(Math.abs(box.y + box.height - vp.h)).toBeLessThan(2);
  expect(actions).toEqual({ position: 'sticky', bottom: '0px' });
});

test('PRD-091 Cancel after typing saves nothing', async () => {
  const { page, context } = s;
  const before = (await readWorkspaceApi(context.request)).items.length;
  await products(page);
  await page.getByRole('button', { name: 'New product' }).click();
  await productDialog(page).getByRole('textbox', { name: 'SKU / code' }).fill('QA-CANCEL');
  await productDialog(page).getByRole('textbox', { name: 'Product name', exact: true }).fill('Cancelled product');
  await productDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(productDialog(page)).toHaveCount(0);
  expect((await readWorkspaceApi(context.request)).items.length).toBe(before);
});

test('PRD-092 Escape closes the dialog and saves nothing', async () => {
  const { page, context } = s;
  const before = (await readWorkspaceApi(context.request)).items.length;
  await products(page);
  await page.getByRole('button', { name: 'New product' }).click();
  await productDialog(page).getByRole('textbox', { name: 'SKU / code' }).fill('QA-ESCAPE');
  await page.keyboard.press('Escape');
  await expect(productDialog(page)).toHaveCount(0);
  expect((await readWorkspaceApi(context.request)).items.length).toBe(before);
});

test('PRD-093 Enter in the SKU field submits and saves', async () => {
  const { page, context } = s;
  await products(page);
  await page.getByRole('button', { name: 'New product' }).click();
  const dialog = productDialog(page);
  await dialog.getByRole('textbox', { name: 'Product name', exact: true }).fill('Enter Saved Product');
  await dialog.getByRole('spinbutton', { name: /Selling price/ }).fill('50');
  await dialog.getByRole('textbox', { name: 'SKU / code' }).fill('QA-ENTER');
  await dialog.getByRole('textbox', { name: 'SKU / code' }).press('Enter');
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  expect((await readWorkspaceApi(context.request)).items.some(i => i.sku === 'QA-ENTER')).toBe(true);
  await expect(page.locator('tbody tr').filter({ hasText: 'QA-ENTER' })).toBeVisible();
});
