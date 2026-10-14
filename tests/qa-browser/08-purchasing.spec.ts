import { expect, test, type Page } from '@playwright/test';
import { F, PHONE, gotoApp, home, openModule, readWorkspaceApi, richWorkspace, sharedSession, signedInPage, writeQaWorkspace, type Session, keepSignedIn } from './helpers';
import { businessToday } from '../../src/modules/erp/dates';

let s: Session;
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); });
test.beforeEach(async ({ browser }) => { if (s) await keepSignedIn(browser, s.context, s.page); });
test.afterAll(async () => { await s?.context.close(); });

const poEditor = (page: Page) => page.getByRole('dialog', { name: 'New purchase order' });
async function purchasing(page: Page) { await home(page); await openModule(page, 'Purchasing'); }
async function newPo(page: Page) {
  await purchasing(page);
  await page.getByRole('button', { name: 'New purchase order' }).first().click();
  await expect(poEditor(page)).toBeVisible();
}
const rows = (page: Page) => page.locator('section.card').first().locator('tbody tr');
const addDays = (date: string, days: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

test('PUR-013 Rate placeholder "e.g. 280" shown when empty', async () => {
  const { page } = s;
  await newPo(page);
  await expect(poEditor(page).getByLabel('Exchange rate')).toHaveValue('');
  await expect(poEditor(page).getByLabel('Exchange rate')).toHaveAttribute('placeholder', 'e.g. 280');
  await page.keyboard.press('Escape');
});

test('PUR-053 Due date defaults to date + supplier terms', async () => {
  const { page } = s;
  await newPo(page);
  await poEditor(page).getByLabel('Supplier', { exact: true }).fill(F.supplier);
  await expect(poEditor(page).getByLabel('Due date')).toHaveValue(addDays(businessToday(), 60));
  await poEditor(page).getByLabel('Supplier', { exact: true }).fill(F.localSupplier);
  await expect(poEditor(page).getByLabel('Due date')).toHaveValue(addDays(businessToday(), 30));
  await page.keyboard.press('Escape');
});

test('PUR-067 Purchasing list filters by type/status/supplier/date', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const pack = w.parties.find(p => p.name === F.localSupplier)!;
  const expected = w.documents.filter(d => d.kind === 'goods_receipt' && d.status === 'submitted' && d.partyId === pack.id && d.date >= '2026-09-01' && d.date <= '2026-09-30').map(d => d.number).sort();
  await purchasing(page);
  const all = await rows(page).count();
  await page.getByLabel('Document type').selectOption('goods_receipt');
  await page.getByLabel('Document status').selectOption('submitted');
  await page.locator('.list-filters').getByLabel('Supplier').selectOption(pack.id);
  await page.getByLabel('From date').fill('2026-09-01');
  await page.getByLabel('To date').fill('2026-09-30');
  expect(expected.length).toBeGreaterThan(0);
  expect((await rows(page).locator('td:first-child').allInnerTexts()).sort()).toEqual(expected);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows(page)).toHaveCount(all);
});

test('PUR-069 Supplier payments tab lists payments with status', async () => {
  const { page } = s;
  await purchasing(page);
  await page.getByRole('tab', { name: 'Supplier payments' }).click();
  const row = page.locator('tbody tr').filter({ hasText: F.supplier }).first();
  await expect(row).toContainText('REC-0006');
  await expect(row.locator('.badge')).toHaveText('cleared');
  await expect(row).toContainText('Rs 14,000');
});

test('PUR-070 Overdue supplier bill appears in the attention queue [defect]', async () => {
  const { page } = s;
  await home(page);
  const attention = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Needs your attention' }) });
  await expect(attention).toBeVisible();
  await expect(attention.locator('.attention-row').filter({ hasText: /bill|supplier|payable/i })).toHaveCount(1, { timeout: 3000 });
});

test('PUR-071 Receive dialog shows the remaining quantity per line', async () => {
  const { page } = s;
  await purchasing(page);
  await rows(page).filter({ hasText: 'PO-2026-0002' }).getByRole('button', { name: 'Convert PO-2026-0002' }).click();
  const dialog = page.getByRole('dialog', { name: 'Goods receipt note from PO-2026-0002' });
  const line = dialog.locator('tbody tr').filter({ hasText: F.led });
  await expect(line.locator('td.num').nth(0)).toHaveText('10');
  await expect(line.locator('td.num').nth(1)).toHaveText('4');
  await expect(line.locator('td.num').nth(2)).toHaveText('6');
  await expect(dialog.getByLabel(`${F.led} quantity this time`)).toHaveValue('6');
  await page.keyboard.press('Escape');
});

test('PUR-075 Warehouse select is hidden on a PO when there is only one warehouse', async () => {
  const { page } = s;
  await newPo(page);
  await expect(poEditor(page).getByLabel('Supplier', { exact: true })).toBeVisible();
  await expect(poEditor(page).getByLabel('Warehouse')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('PUR-084 Payment dialog lists open bills oldest first; a typed total spreads oldest first', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await purchasing(page);
  await page.getByRole('tab', { name: 'Supplier payments' }).click();
  await page.getByRole('button', { name: 'Record payment' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record supplier payment' });
  await dialog.getByLabel('Supplier').selectOption(w.parties.find(p => p.name === F.localSupplier)!.id);
  await expect(dialog.locator('tbody tr td:first-child strong')).toHaveText(['BILL-2026-0002', 'BILL-2026-0003']);
  await dialog.getByLabel('Amount to allocate oldest first').fill('28000');
  await expect(dialog.getByLabel('Allocate to BILL-2026-0002')).toHaveValue('27500.0000');
  await expect(dialog.getByLabel('Allocate to BILL-2026-0003')).toHaveValue('500.0000');
  await page.keyboard.press('Escape');
});

test('PUR-085 "PKR actually paid" is shown only for non-PKR bills [defect]', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await purchasing(page);
  await page.getByRole('tab', { name: 'Supplier payments' }).click();
  await page.getByRole('button', { name: 'Record payment' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record supplier payment' });
  await dialog.getByLabel('Supplier').selectOption(w.parties.find(p => p.name === F.supplier)!.id);
  await expect(dialog.getByLabel('PKR paid')).toBeVisible();
  await dialog.getByLabel('Supplier').selectOption(w.parties.find(p => p.name === F.localSupplier)!.id);
  const shownForPkr = await dialog.getByLabel('PKR paid').isVisible();
  await page.keyboard.press('Escape');
  expect(shownForPkr, '"PKR actually paid" shown for a supplier whose bills are all in PKR').toBe(false);
});

test('PUR-086 Purchase editor is usable on a phone', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true });
  const page = phone.page;
  await gotoApp(page);
  await openModule(page, 'Purchasing');
  await page.getByRole('button', { name: 'New purchase order' }).first().click();
  const ed = poEditor(page);
  await ed.getByLabel('Supplier', { exact: true }).fill(F.supplier);
  await ed.getByLabel('Exchange rate').fill('281');
  await ed.getByLabel('Line 1 product').selectOption({ label: `QA-KET · ${F.kettle}` });
  await ed.getByLabel('Line 1 price').fill('2');
  await ed.getByLabel('Line 1 quantity').fill('5');
  await expect(ed.locator('.editor-totals')).toContainText('2,810');
  const box = (await ed.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  await ed.getByRole('button', { name: 'Save draft' }).click();
  await expect(ed).toHaveCount(0, { timeout: 30_000 });
  await expect(rows(page).first()).toContainText(F.supplier);
  await expect(rows(page).first()).toContainText('draft');
  await phone.context.close();
});

test('PUR-097 500 POs in the list: filters respond in under 1 s', async () => {
  test.setTimeout(240_000);
  const { page } = s;
  const r = richWorkspace();
  const po = r.w.documents.find(d => d.id === r.ids.po2)!;
  for (let i = 0; i < 500; i++) r.w.documents.push({ ...structuredClone(po), id: `bulk-po-${i}`, number: `PO-2026-${String(1000 + i)}`, status: i % 2 ? 'submitted' : 'draft', date: `2026-0${1 + (i % 9)}-15` });
  await writeQaWorkspace(r.w);
  await gotoApp(page);
  await openModule(page, 'Purchasing');
  const timings: number[] = [];
  for (const [label, action] of [
    ['status', () => page.getByLabel('Document status').selectOption('draft')],
    ['type', () => page.getByLabel('Document type').selectOption('purchase_order')],
    ['search', () => page.getByLabel('Search purchase documents').fill('PO-2026-1499')],
  ] as const) {
    const started = Date.now();
    await action();
    await expect(page.locator('section.card').first().locator('.card-heading p')).not.toHaveText(/^(\d+) of \1 documents$/);
    timings.push(Date.now() - started);
    void label;
  }
  await expect(page.getByText('No purchase documents match these filters.')).toBeVisible();
  await page.getByLabel('Document status').selectOption('submitted');
  await expect(rows(page)).toHaveCount(1);
  test.info().annotations.push({ type: 'measured', description: `filter response ${timings.join(' / ')} ms with 500+ POs` });
  expect(Math.max(...timings)).toBeLessThan(1000);
});
