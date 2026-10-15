import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PHONE, gotoApp, home, openModule, readWorkspaceApi, sharedSession, signedInPage, type Session, AUTH_FILE, QA_TENANT, authState } from './helpers';
import { generalLedger } from '../../src/modules/erp/reports';

let s: Session;
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); });
test.afterAll(async () => { await s?.context.close(); });

// Another suite may sign this shared account out globally (Supabase revokes every session); re-sign in when that happens.
test.beforeEach(async ({ browser }) => {
  if (!s || (await s.context.request.get(`/api/workspace?tenant=${QA_TENANT}`)).status() === 200) return;
  await authState(browser);
  await s.context.clearCookies();
  await s.context.addCookies(JSON.parse(readFileSync(AUTH_FILE, 'utf8')).cookies);
  await gotoApp(s.page);
});

async function accounting(page: Page) { await home(page); await openModule(page, 'Accounting'); }
const journalsCard = (page: Page) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Recent posted journals' }) });
async function report(page: Page, label: string) {
  await home(page);
  await openModule(page, 'Reports');
  await page.locator('.reports-menu').getByRole('button', { name: label, exact: true }).click();
  await expect(page.locator('.report-card h2')).toHaveText(label);
}

test('ACC-053 Journal search by memo or number', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  // An older journal that is not among the latest 8 shown on Accounting.
  const target = w.journals[2];
  await accounting(page);
  await expect(journalsCard(page).locator('tbody tr')).toHaveCount(8);
  await expect(journalsCard(page)).not.toContainText(target.number);
  const searchBoxes = await page.locator('main input[type=search], main [role=searchbox]').count();
  // The workspace search (Ctrl/Cmd K) is the other place a user would look.
  await page.getByRole('button', { name: /Search anything/ }).click();
  await page.getByLabel('Search the workspace').fill(target.number);
  const byNumber = await page.locator('.search-result').count();
  await page.getByLabel('Search the workspace').fill(target.memo);
  const byMemo = await page.locator('.search-result').allInnerTexts();
  await page.keyboard.press('Escape');
  test.info().annotations.push({ type: 'actual', description: `journal ${target.number} "${target.memo}": Accounting search boxes ${searchBoxes}; workspace search by number ${byNumber} results; by memo ${JSON.stringify(byMemo)}` });
  expect(searchBoxes + byNumber, `a way to find ${target.number} by number`).toBeGreaterThan(0);
  expect(byMemo.some(t => t.includes(target.number)), `a way to find ${target.number} by memo`).toBe(true);
});

test('ACC-054 Filter journals by date range [case-corrected: the date range lives in Reports → General ledger; Accounting lists the latest 8]', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await accounting(page);
  await expect(journalsCard(page).locator('input[type=date]')).toHaveCount(0);
  await report(page, 'General ledger');
  await page.getByLabel('Ledger account').selectOption('1100');
  await page.getByLabel('From date').fill('2026-10-01');
  await page.getByLabel('To date').fill('2026-10-05');
  const expected = generalLedger(w, '1100', '2026-10-01', '2026-10-05');
  const all = generalLedger(w, '1100', '0000-01-01', '9999-12-31');
  expect(expected.rows.length).toBeGreaterThan(0);
  expect(expected.rows.length).toBeLessThan(all.rows.length);
  const body = page.locator('.report-table tbody tr');
  await expect(body).toHaveCount(expected.rows.length + 1);
  const dates = (await body.locator('td:first-child').allInnerTexts()).slice(1);
  expect(dates).toEqual(expected.rows.map(r => r.date));
  for (const d of dates) expect(d >= '2026-10-01' && d <= '2026-10-05', d).toBe(true);
  expect(await body.locator('td:nth-child(2)').allInnerTexts()).toEqual(['', ...expected.rows.map(r => r.journal)]);
  await expect(page.locator('.report-card .card-heading p')).toContainText('2026-10-01 to 2026-10-05');
  // Narrowing again updates immediately.
  await page.getByLabel('To date').fill('2026-10-01');
  await expect(body).toHaveCount(generalLedger(w, '1100', '2026-10-01', '2026-10-01').rows.length + 1);
});

test('ACC-090 Journals are readable on a phone [case-corrected: no separate journal detail screen; the Recent posted journals table is the journal view]', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true, isMobile: true });
  const { page } = phone;
  try {
    await gotoApp(page);
    await openModule(page, 'Accounting');
    const card = journalsCard(page);
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('thead th')).toHaveText(['Journal', 'Date', 'Source', 'Memo', 'Debits']);
    const m = await card.locator('.table-scroll').evaluate(el => ({ overflow: getComputedStyle(el).overflowX, scrolls: el.scrollWidth > el.clientWidth, focusable: el.tabIndex === 0, fits: el.getBoundingClientRect().right <= innerWidth + 1 }));
    expect(m).toEqual({ overflow: 'auto', scrolls: true, focusable: true, fits: true });
    await expect(card.locator('.table-scroll-hint')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const cells = await card.locator('tbody tr').first().locator('td').evaluateAll(tds => tds.map(td => ({ size: parseFloat(getComputedStyle(td).fontSize), clipped: td.scrollWidth > td.clientWidth + 1, text: td.textContent ?? '' })));
    for (const c of cells) { expect(c.size).toBeGreaterThanOrEqual(12); expect(c.clipped, c.text).toBe(false); expect(c.text.trim()).not.toBe(''); }
    // The amount column stays in view (sticky last column) while the table scrolls.
    const debit = card.locator('tbody tr').first().locator('td').last();
    await card.locator('.table-scroll').evaluate(el => { el.scrollLeft = 0; });
    const box = await debit.boundingBox();
    expect(box && box.x + box.width <= PHONE.width + 1 && box.x >= 0).toBe(true);
  } finally { await phone.context.close(); }
});

test('ACC-091 Debit / credit columns are right-aligned with tabular numerals [defect]', async () => {
  const { page } = s;
  const measure = (selector: string) => page.locator(selector).evaluateAll(els => els.map(el => ({ align: getComputedStyle(el).textAlign, nums: getComputedStyle(el).fontVariantNumeric })));
  const results: Record<string, { align: string; nums: string }[]> = {};
  for (const label of ['Trial balance', 'General ledger']) {
    await report(page, label);
    results[`${label} money cells`] = await measure('.report-table td.num, .report-table th.num');
    expect(results[`${label} money cells`].length).toBeGreaterThan(4);
  }
  await accounting(page);
  const tb = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Trial balance' }) });
  results['Accounting trial balance "Net balance"'] = await tb.locator('tbody tr td:nth-child(3)').evaluateAll(els => els.map(el => ({ align: getComputedStyle(el).textAlign, nums: getComputedStyle(el).fontVariantNumeric })));
  results['Accounting journals "Debits"'] = await journalsCard(page).locator('tbody tr td:nth-child(5)').evaluateAll(els => els.map(el => ({ align: getComputedStyle(el).textAlign, nums: getComputedStyle(el).fontVariantNumeric })));
  const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, [...new Set(v.map(x => `${x.align} · ${x.nums}`))]]));
  test.info().annotations.push({ type: 'actual', description: JSON.stringify(summary) });
  for (const [where, cells] of Object.entries(results)) for (const c of cells) {
    expect(c.nums, where).toBe('tabular-nums');
    expect(c.align, `${where} aligned right`).toBe('right');
  }
});
