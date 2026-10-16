import { expect, test, type Page } from '@playwright/test';
import { F, PHONE, gotoApp, home, openModule, post, readWorkspaceApi, richWorkspace, sharedSession, signedInPage, writeQaWorkspace, type Session, keepSignedIn } from './helpers';
import { stock } from '../../src/modules/erp/engine';
import { D } from '../../src/modules/erp/money';

let s: Session;
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); });
test.beforeEach(async ({ browser }) => { if (s) await keepSignedIn(browser, s.context, s.page); });
test.afterAll(async () => { await s?.context.close(); });

async function stockTab(page: Page) {
  await home(page);
  await openModule(page, 'Inventory');
  await expect(page.getByRole('tab', { name: 'Stock', selected: true })).toBeVisible();
}
const stockRows = (page: Page) => page.locator('section.card').first().locator('tbody tr');
const skus = async (page: Page) => (await stockRows(page).locator('td:first-child').allInnerTexts()).filter(t => t.trim()).sort();

test('INV-056 Document warehouse select is hidden with a single warehouse', async () => {
  const { page } = s;
  await home(page);
  await openModule(page, 'Sales');
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New sales invoice' });
  await expect(dialog.getByLabel('Customer', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Warehouse')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('INV-041 Stock level filter In stock / Low / Out shows the right sets', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const expected = (pred: (q: ReturnType<typeof D>, reorder: number) => boolean) => w.items.filter(i => pred(D(stock(w, i.id).quantity), i.reorderLevel)).map(i => i.sku).sort();
  await stockTab(page);
  await page.getByLabel('Stock level').selectOption('in');
  expect(await skus(page)).toEqual(expected(q => q.gt(0)));
  await page.getByLabel('Stock level').selectOption('low');
  expect(await skus(page)).toEqual(expected((q, r) => q.gt(0) && q.lte(r)));
  await page.getByLabel('Stock level').selectOption('out');
  const out = expected(q => q.isZero());
  if (out.length) expect(await skus(page)).toEqual(out); else await expect(page.getByText('No products match these filters.')).toBeVisible();
  expect(expected((q, r) => q.gt(0) && q.lte(r)).length).toBeGreaterThan(0);
});

test('INV-042 Category filter narrows the Stock list', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await stockTab(page);
  await page.getByLabel('Category').selectOption('Home');
  expect(await skus(page)).toEqual(w.items.filter(i => i.category === 'Home').map(i => i.sku).sort());
});

test('INV-043 Stock search by SKU', async () => {
  const { page } = s;
  await stockTab(page);
  await page.getByLabel('Search inventory').fill('QA-FAN');
  expect(await skus(page)).toEqual(['QA-FAN']);
  await page.getByLabel('Search inventory').fill('qa-fan');
  expect(await skus(page)).toEqual(['QA-FAN']);
});

test('INV-061 Item details on phone: sections stack, history scrolls', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true });
  await gotoApp(phone.page);
  await openModule(phone.page, 'Inventory');
  await phone.page.getByRole('button', { name: `View ${F.led}` }).click();
  const dialog = phone.page.getByRole('dialog', { name: F.led });
  await expect(dialog).toBeVisible();
  const layout = await dialog.evaluate(el => ({
    metrics: getComputedStyle(el.querySelector('.item-details-metrics')!).gridTemplateColumns.split(' ').length,
    heading: getComputedStyle(el.querySelector('.item-details-heading')!).display,
    history: (() => { const t = [...el.querySelectorAll('.item-details-section')].at(-1)!.querySelector('.table-scroll')!; return { overflow: getComputedStyle(t).overflowX, fits: t.getBoundingClientRect().right <= innerWidth + 1 }; })(),
    dialogScroll: getComputedStyle(el).overflowY,
  }));
  await phone.context.close();
  expect(layout).toEqual({ metrics: 2, heading: 'block', history: { overflow: 'auto', fits: true }, dialogScroll: 'auto' });
});

test('INV-062 Set-quantity dialog closes on success', async () => {
  const { page } = s;
  await stockTab(page);
  await page.getByRole('button', { name: `Edit ${F.fan}` }).click();
  const dialog = page.getByRole('dialog', { name: `Edit ${F.fan}` });
  await dialog.getByLabel('New quantity').fill('25');
  await dialog.getByLabel('Unit cost for added stock').fill('2750');
  await dialog.getByPlaceholder('Explain the counted difference').fill('QA count');
  await dialog.getByRole('button', { name: 'Save quantity' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(stockRows(page).filter({ hasText: 'QA-FAN' })).toContainText('25 pcs');
});

test('INV-063 Set-quantity dialog shows the current quantity and value', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const led = w.items.find(i => i.sku === 'QA-LED')!;
  const level = stock(w, led.id);
  await stockTab(page);
  await page.getByRole('button', { name: `Edit ${F.led}` }).click();
  const dialog = page.getByRole('dialog', { name: `Edit ${F.led}` });
  await expect(dialog.getByLabel('Current quantity')).toHaveValue(`${D(level.quantity).toString()} pcs`);
  const value = `Rs ${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 }).format(Number(level.value))}`;
  const shown = (await dialog.innerText()).includes(value);
  await page.keyboard.press('Escape');
  expect(shown, `stock value ${value} shown in the edit form`).toBe(true);
});

test('INV-051 Branch picker appears in the header only with two or more branches', async () => {
  const { page } = s;
  await stockTab(page);
  await expect(page.getByRole('button', { name: /Branch filter/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Warehouses' }).click();
  await page.getByLabel('New branch name').fill('Hyderabad');
  await page.getByRole('button', { name: 'Add branch' }).click();
  await expect(page.locator('.branch-list')).toContainText('Hyderabad');
  await expect(page.getByRole('button', { name: /Branch filter/ })).toBeVisible();
});

test('INV-052 Branch picker filters documents and stock', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const branchId = (await post(context.request, 'save_branch', { name: 'Lahore Branch' })).body.recordId!;
  const warehouseId = (await post(context.request, 'save_warehouse', { name: 'Lahore Store', branchId })).body.recordId!;
  const led = w.items.find(i => i.sku === 'QA-LED')!.id;
  const ali = w.parties.find(p => p.name === F.customer)!.id;
  expect((await post(context.request, 'bulk_stock_increase', { warehouseId, date: '2026-10-10', purpose: 'opening_stock', reason: 'QA Lahore', lines: [{ itemId: led, quantity: '7', cost: '1450' }] })).status).toBe(200);
  const doc = await post(context.request, 'create_document', { kind: 'sales_invoice', partyId: ali, warehouseId, date: '2026-10-10', dueDate: '2026-11-09', lines: [{ itemId: led, quantity: '2', price: '2400', discount: '0', taxRate: '0', employeeId: '', splits: [] }] });
  await post(context.request, 'submit_document', { id: doc.body.recordId });
  const number = (await readWorkspaceApi(context.request)).documents.find(d => d.id === doc.body.recordId)!.number;
  await gotoApp(page);
  await page.getByRole('button', { name: /Branch filter/ }).click();
  await page.getByRole('menuitem', { name: 'Lahore Branch' }).click();
  await openModule(page, 'Sales');
  await expect(page.locator('section.card').first().locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('section.card').first().locator('tbody tr')).toContainText(number);
  await openModule(page, 'Inventory');
  await expect(stockRows(page).filter({ hasText: 'QA-LED' })).toContainText('5 pcs');
  await page.getByRole('button', { name: /Branch filter/ }).click();
  await page.getByRole('menuitem', { name: 'All branches' }).click();
  await expect(stockRows(page).filter({ hasText: 'QA-LED' })).not.toContainText(/^5 pcs$/);
});

test('INV-087 50,000 movements for one item: item details stay responsive (newest 20 shown)', async () => {
  test.setTimeout(240_000);
  const { page } = s;
  const r = richWorkspace();
  const led = r.ids.led;
  const wh = r.w.warehouses[0].id;
  for (let i = 0; i < 25_000; i++) {
    r.w.stockMoves.push({ id: `bulk-in-${i}`, itemId: led, warehouseId: wh, date: '2026-10-09', quantity: '1.0000', value: '1450.0000', sourceId: `bulk-${i}`, type: 'count_correction' });
    r.w.stockMoves.push({ id: `bulk-out-${i}`, itemId: led, warehouseId: wh, date: '2026-10-09', quantity: '-1.0000', value: '-1450.0000', sourceId: `bulk-${i}-out`, type: 'count_correction' });
  }
  await writeQaWorkspace(r.w);
  await gotoApp(page);
  await openModule(page, 'Inventory');
  const started = Date.now();
  await page.getByRole('button', { name: `View ${F.led}` }).click();
  const dialog = page.getByRole('dialog', { name: F.led });
  await expect(dialog).toBeVisible();
  const elapsed = Date.now() - started;
  await expect(dialog.locator('.item-details-section').last().locator('tbody tr')).toHaveCount(20);
  test.info().annotations.push({ type: 'measured', description: `item details opened in ${elapsed} ms with 50,000 movements` });
  await page.keyboard.press('Escape');
  expect(elapsed).toBeLessThan(2000);
});

test('INV-095 50 warehouses: selects remain usable', async () => {
  test.setTimeout(180_000);
  const { page } = s;
  const r = richWorkspace();
  for (let i = 1; i <= 50; i++) r.w.warehouses.push({ id: `wh-${i}`, name: `Godown ${String(i).padStart(2, '0')}`, branchId: r.w.branches[0].id });
  await writeQaWorkspace(r.w);
  await gotoApp(page);
  await openModule(page, 'Inventory');
  const filter = page.getByLabel('Warehouse filter');
  await expect(filter.locator('option')).toHaveCount(52);
  await filter.selectOption({ label: 'Godown 50' });
  await expect(page.getByRole('heading', { name: 'Stock in Godown 50' })).toBeVisible();
  await openModule(page, 'Sales');
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  const select = page.getByRole('dialog', { name: 'New sales invoice' }).getByLabel('Warehouse');
  await select.selectOption({ label: 'Godown 37' });
  await expect(select).toHaveValue('wh-37');
  await page.keyboard.press('Escape');
});
