import { expect, test, type Page } from '@playwright/test';
import { F, PHONE, gotoApp, home, openModule, richWorkspace, sharedSession, signedInPage, writeQaWorkspace, type Session, keepSignedIn } from './helpers';

let s: Session;
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); });
test.beforeEach(async ({ browser }) => { if (s) await keepSignedIn(browser, s.context, s.page); });
test.afterAll(async () => { await s?.context.close(); });

async function imports(page: Page) { await home(page); await openModule(page, 'Imports & costing'); }
const card = (page: Page) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Import shipments' }) });
const rows = (page: Page) => card(page).locator('tbody tr');

test('IMP-035 Shipment list columns: shipment, supplier, container/GD, ETA, status, unallocated', async () => {
  const { page } = s;
  await imports(page);
  await expect(card(page).locator('thead th')).toHaveText(['Shipment', 'Supplier', 'Container / GD', 'ETA', 'Status', 'Unallocated', 'Action']);
  const second = rows(page).filter({ hasText: 'SHP-2026-002' });
  await expect(second.locator('td')).toHaveText(['SHP-2026-002', F.localSupplier, 'TGHU7654321 · KPPI-HC-2002', '2026-09-14', 'received', 'Rs 5,000', 'Allocate']);
  await expect(rows(page).filter({ hasText: 'SHP-2026-001' }).locator('td').nth(5)).toHaveText('Rs 0');
  await expect(rows(page).filter({ hasText: 'SHP-2026-001' }).locator('td').nth(6)).toHaveText('Complete');
});

test('IMP-037 no customs/GD lookup is offered [case-corrected: withdrawn — real customs lookups are out of scope (test plan §2) and simulated lookups were removed from the product; the GD number is entered by hand]', async () => {
  const { page } = s;
  await imports(page);
  await expect(page.getByRole('button', { name: /GD lookup|customs lookup/i })).toHaveCount(0);
});

test('IMP-053 Shipment table on phone shows the scroll hint', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true });
  await gotoApp(phone.page);
  await openModule(phone.page, 'Imports & costing');
  await expect(card(phone.page).locator('.table-scroll-hint')).toBeVisible();
  const scrolls = await card(phone.page).locator('.table-scroll').evaluate(el => el.scrollWidth > el.clientWidth);
  await phone.context.close();
  expect(scrolls).toBe(true);
});

test('IMP-054 Add-cost dialog: amount empty with a placeholder [defect]', async () => {
  const { page } = s;
  await imports(page);
  // Engine-pass finding: the Imports view has no control to create a shipment or add a cost.
  const add = page.getByRole('button', { name: /add cost|new shipment|create shipment/i });
  await expect(add.first()).toBeVisible({ timeout: 3000 });
  await add.first().click();
  await expect(page.getByRole('dialog').getByLabel(/amount/i)).toHaveValue('');
});

test('IMP-055 Classification help text explains each class [defect]', async () => {
  const { page } = s;
  await imports(page);
  for (const text of [/inventory/i, /recoverable/i, /deposit/i, /expense/i]) await expect(page.locator('main')).toContainText(text, { timeout: 2000 });
});

test('IMP-056 Search finds a shipment by number or container [defect]', async () => {
  const { page } = s;
  await home(page);
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('dialog', { name: 'Search' });
  await search.getByLabel('Search the workspace').fill('TGHU7654321');
  const found = await search.getByRole('listitem').count();
  await search.getByLabel('Search the workspace').fill('SHP-2026-002');
  const byNumber = await search.getByRole('listitem').count();
  await page.keyboard.press('Escape');
  expect({ container: found, number: byNumber }).toEqual({ container: 1, number: 1 });
});

test('IMP-057 Attention queue lists shipments with unallocated costs', async () => {
  const { page } = s;
  await home(page);
  const row = page.locator('.attention-row').filter({ hasText: 'Shipment costs unallocated' });
  await expect(row).toContainText('1 records');
});

test('IMP-082 Shipment list is sorted newest first [defect]', async () => {
  const { page } = s;
  await imports(page);
  expect(await rows(page).locator('td:first-child').allInnerTexts()).toEqual(['SHP-2026-002', 'SHP-2026-001']);
});

test('IMP-083 Shipments can be filtered by status [defect]', async () => {
  const { page } = s;
  await imports(page);
  await expect(card(page).getByRole('combobox', { name: /status/i })).toBeVisible({ timeout: 3000 });
});

test('IMP-089 Status badges use a pastel colour per status', async () => {
  const { page } = s;
  await gotoApp(page);
  await imports(page);
  const badge = async (shp: string) => rows(page).filter({ hasText: shp }).locator('.badge').evaluate(el => ({ text: el.textContent, bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
  const [costed, received] = [await badge('SHP-2026-001'), await badge('SHP-2026-002')];
  expect(costed.bg).not.toBe(received.bg);
  for (const b of [costed, received]) {
    const [r, g, bl] = b.bg.match(/\d+/g)!.map(Number);
    expect(Math.min(r, g, bl), `${b.text} background is pastel`).toBeGreaterThan(200);
  }
});

test('IMP-097 Export shipments CSV if present [documented: there is no shipment CSV export]', async () => {
  const { page } = s;
  await imports(page);
  await expect(card(page).getByRole('button', { name: /export/i })).toHaveCount(0);
});

test('IMP-098 Attention item link opens Imports', async () => {
  const { page } = s;
  await gotoApp(page);
  await page.locator('.attention-row').filter({ hasText: 'Shipment costs unallocated' }).click();
  await expect(page.locator('.breadcrumb strong')).toHaveText('Imports & costing');
  await expect(page.getByRole('heading', { name: 'Import shipments' })).toBeVisible();
});

test('IMP-088 Shipment actions are reachable and operable by keyboard', async () => {
  const { page } = s;
  await imports(page);
  const allocate = rows(page).filter({ hasText: 'SHP-2026-002' }).getByRole('button', { name: 'Allocate' });
  await page.getByRole('heading', { name: 'Import shipments' }).click();
  let reached = false;
  for (let i = 0; i < 25 && !reached; i++) { await page.keyboard.press('Tab'); reached = await allocate.evaluate(el => el === document.activeElement); }
  expect(reached).toBe(true);
  await page.keyboard.press('Enter');
  await expect(rows(page).filter({ hasText: 'SHP-2026-002' })).toContainText('Complete', { timeout: 30_000 });
});

test('IMP-084 200 shipments: the list renders', async () => {
  test.setTimeout(240_000);
  const { page } = s;
  const r = richWorkspace();
  const base = r.w.shipments[0];
  for (let i = 0; i < 200; i++) r.w.shipments.push({ ...structuredClone(base), id: `bulk-shp-${i}`, number: `SHP-2026-${String(100 + i)}`, container: `BULK${String(i).padStart(7, '0')}` });
  await writeQaWorkspace(r.w);
  await gotoApp(page);
  const started = Date.now();
  await openModule(page, 'Imports & costing');
  await expect(rows(page)).toHaveCount(202);
  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: 'measured', description: `202 shipments rendered in ${elapsed} ms` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(elapsed).toBeLessThan(3000);
});
