import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { APP, F, PHONE, QA_TENANT, gotoApp, home, navItem, openModule, post, readWorkspaceApi, richWorkspace, seedRich, sharedSession, signedInPage, writeQaWorkspace, type Session, AUTH_FILE, authState } from './helpers';
import { agedBalances } from '../../src/modules/erp/reports';
import { formatMoney } from '../../src/modules/erp/money';

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

const reportLinks = (page: Page) => page.locator('.reports-menu .report-link');
const reportTitle = (page: Page) => page.locator('.report-card h2');
async function reports(page: Page, label?: string) {
  await home(page);
  await openModule(page, 'Reports');
  if (label) await chooseReport(page, label);
}
async function chooseReport(page: Page, label: string) {
  await page.locator('.reports-menu').getByRole('button', { name: label, exact: true }).click();
  await expect(reportTitle(page)).toHaveText(label);
}
const shown = (page: Page, selector: string) => page.locator(selector).evaluateAll(els => els.filter(el => getComputedStyle(el).display !== 'none' && (el as HTMLElement).offsetParent !== null).length);

test('RPT-011 Statement print is branded with company header and period', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await reports(page, 'Customer / supplier statement');
  const ali = w.parties.find(p => p.name === F.customer)!;
  await page.getByLabel('Statement party').selectOption(ali.id);
  await page.getByLabel('From date').fill('2026-09-01');
  await page.getByLabel('To date').fill('2026-10-31');
  await expect(page.locator('.report-table tbody tr').first()).toContainText('Opening balance');
  await page.emulateMedia({ media: 'print' });
  try {
    const printed = page.locator('.report-card');
    await expect(printed).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.topbar')).toBeHidden();
    await expect(page.locator('.reports-menu')).toBeHidden();
    expect(await shown(page, '.report-card .no-print')).toBe(0);
    // Company header and period.
    await expect(printed.locator('h2')).toHaveText('Customer / supplier statement');
    await expect(printed.locator('.card-heading p')).toHaveText(`${w.company.name} · 2026-09-01 to 2026-10-31`);
    // The statement must say whose statement it is once the parameter row is hidden for print.
    const text = await page.locator('body').innerText();
    const brand = { party: text.includes(F.customer), address: text.includes(w.company.address), phone: text.includes(w.company.phone), logo: await printed.locator('img, .brand-mark, .invoice-logo').count() };
    test.info().annotations.push({ type: 'actual', description: `printed statement shows ${JSON.stringify(brand)}` });
    expect(brand.party, 'customer named on the printed statement').toBe(true);
    expect(brand.address && brand.phone, 'company address and phone on the printed statement').toBe(true);
    expect(brand.logo, 'company logo / brand mark on the printed statement').toBeGreaterThan(0);
  } finally { await page.emulateMedia({ media: 'screen' }); }
});

test('RPT-046 Overview "Needs attention" rows open the right place [case-corrected: rows open the module queue, not a report]', async () => {
  const { page } = s;
  const targets: Record<string, string> = {
    'Commission awaiting approval': 'Commissions', 'Shipment costs unallocated': 'Imports & costing', 'Open customer invoices': 'Collections',
    'Cheques due for deposit or clearing': 'Collections', 'Recovery follow-ups due': 'Collections', 'Draft sales documents to submit': 'Sales',
  };
  await home(page);
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Needs your attention' }) });
  const titles = await card.locator('.attention-row strong').allInnerTexts();
  expect(titles.length).toBeGreaterThanOrEqual(5);
  for (const title of titles) {
    expect(Object.keys(targets), title).toContain(title);
    await home(page);
    await card.locator('.attention-row').filter({ hasText: title }).click();
    await expect(page.locator('.breadcrumb strong'), title).toHaveText(targets[title]);
  }
  // The commissions queue shows the entitlement awaiting approval with its Approve action.
  await home(page);
  await card.locator('.attention-row').filter({ hasText: 'Commission awaiting approval' }).click();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(1);
});

test('RPT-047 Report tables scroll horizontally on a phone with totals visible', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true, isMobile: true });
  const { page } = phone;
  try {
    await gotoApp(page);
    await openModule(page, 'Reports');
    await expect(reportTitle(page)).toHaveText('Aged receivables');
    const scroller = page.locator('.report-card .table-scroll');
    await scroller.scrollIntoViewIfNeeded();
    expect(await scroller.evaluate(el => ({ overflow: getComputedStyle(el).overflowX, scrolls: el.scrollWidth > el.clientWidth }))).toEqual({ overflow: 'auto', scrolls: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const foot = page.locator('.report-table tfoot td');
    await expect(foot.first()).toHaveText('Total');
    const total = foot.last();
    const box = async () => { const b = (await total.boundingBox())!; return { inside: b.x >= 0 && b.x + b.width <= PHONE.width + 1, text: await total.innerText() }; };
    expect(await box()).toEqual({ inside: true, text: expect.stringMatching(/^Rs /) });
    await scroller.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    expect((await box()).inside).toBe(true);
    await expect(foot.first()).toBeVisible();
    test.info().annotations.push({ type: 'actual', description: `swipe hint under report tables: ${await page.locator('.report-card .table-scroll-hint').count()} (other tables show one)` });
  } finally { await phone.context.close(); }
});

test('RPT-048 Printing a report uses clean print CSS', async ({ browser }) => {
  const a4 = await signedInPage(browser, { viewport: { width: 794, height: 1123 } });
  const { page, errors } = a4;
  try {
    await gotoApp(page);
    await openModule(page, 'Reports');
    await chooseReport(page, 'Trial balance');
    await page.emulateMedia({ media: 'print' });
    for (const hidden of ['.sidebar', '.topbar', '.reports-menu', '.report-card .list-filters', '.report-card .no-print', '.table-scroll-hint']) expect(await shown(page, hidden), hidden).toBe(0);
    await expect(page.locator('.report-table')).toBeVisible();
    await expect(page.locator('.report-table tfoot td').nth(1)).toHaveText('Total');
    const layout = await page.evaluate(() => {
      const card = document.querySelector('.report-card')!; const cs = getComputedStyle(card); const table = document.querySelector('.report-table')!.getBoundingClientRect();
      const cell = getComputedStyle(document.querySelector('.report-table td')!);
      return { border: cs.borderTopStyle === 'none' || parseFloat(cs.borderTopWidth) === 0, shadow: cs.boxShadow, fits: table.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth, cellFont: cell.fontSize, bodyBg: getComputedStyle(document.body).backgroundColor, mainLeft: Math.round(document.querySelector('.main-shell')!.getBoundingClientRect().left) };
    });
    expect(layout).toEqual({ border: true, shadow: 'none', fits: true, cellFont: '12.6667px', bodyBg: 'rgb(255, 255, 255)', mainLeft: 0 });
    expect(errors).toEqual([]);
  } finally { await a4.context.close(); }
});

test('RPT-049 Hiding Reports removes the sidebar entry; Overview unaffected', async () => {
  const { page, errors } = s;
  await writeQaWorkspace(richWorkspace({ hide: ['reports'] }).w);
  try {
    await gotoApp(page);
    await expect(navItem(page, 'Reports')).toHaveCount(0);
    await expect(navItem(page, 'Overview')).toHaveCount(1);
    await expect(page.locator('.breadcrumb strong')).toHaveText('Overview');
    await expect(page.locator('.metric-grid .metric-card')).toHaveCount(4);
    await expect(page.getByRole('heading', { name: 'Needs your attention' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent sales' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sales & collections' })).toBeVisible();
    expect(errors.filter(e => e.startsWith('pageerror'))).toEqual([]);
  } finally {
    await seedRich();
    await gotoApp(page);
  }
  await expect(navItem(page, 'Reports')).toHaveCount(1);
});

test('RPT-066 Report parameters while switching tabs [documented: shared parameters persist across reports; leaving Reports resets them; no crash]', async () => {
  const { page, errors } = s;
  await reports(page, 'Aged receivables');
  await page.getByLabel('As at date').fill('2026-09-30');
  await expect(page.locator('.report-card .card-heading p')).toContainText('as at 2026-09-30');
  await chooseReport(page, 'Sales analysis');
  await page.getByLabel('From date').fill('2026-10-01');
  await page.getByLabel('Group by').selectOption('item');
  await chooseReport(page, 'Trial balance');
  await expect(page.getByLabel('As at date')).toHaveValue('2026-09-30');
  await chooseReport(page, 'Sales analysis');
  await expect(page.getByLabel('From date')).toHaveValue('2026-10-01');
  await expect(page.getByLabel('Group by')).toHaveValue('item');
  await chooseReport(page, 'Aged receivables');
  await expect(page.getByLabel('As at date')).toHaveValue('2026-09-30');
  // Leaving the module resets to the first report with today's date.
  await openModule(page, 'Sales');
  await openModule(page, 'Reports');
  await expect(reportTitle(page)).toHaveText('Aged receivables');
  await expect(page.getByLabel('As at date')).not.toHaveValue('2026-09-30');
  expect(errors.filter(e => e.startsWith('pageerror'))).toEqual([]);
});

test('RPT-067 Reports are keyboard accessible', async () => {
  const { page } = s;
  await reports(page);
  await reportLinks(page).first().focus();
  const order: string[] = [];
  for (let i = 0; i < 20; i++) {
    const label = await page.evaluate(() => document.activeElement?.textContent ?? '');
    order.push(label);
    if (label === 'Trial balance') break;
    await page.keyboard.press('Tab');
  }
  const link = page.locator('.reports-menu').getByRole('button', { name: 'Trial balance', exact: true });
  await expect(link).toBeFocused();
  const ring = await link.evaluate(el => ({ style: getComputedStyle(el).outlineStyle, width: parseFloat(getComputedStyle(el).outlineWidth) }));
  expect(ring.style).not.toBe('none');
  expect(ring.width).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  await expect(reportTitle(page)).toHaveText('Trial balance');
  await expect(link).toHaveClass(/active/);
  // From the menu, Tab reaches the actions and the parameters, which respond to the keyboard.
  const stops: string[] = [];
  for (let i = 0; i < 12 && !stops.includes('INPUT:As at date'); i++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => { const a = document.activeElement as HTMLElement; return `${a.tagName}:${a.getAttribute('aria-label') ?? a.textContent?.trim()}`; }));
  }
  test.info().annotations.push({ type: 'actual', description: `tab stops after the menu: ${stops.join(' → ')}` });
  expect(stops).toEqual(expect.arrayContaining(['BUTTON:Export CSV', 'BUTTON:Print', 'INPUT:As at date']));
  await page.keyboard.type('30092026');
  await expect(page.getByLabel('As at date')).toHaveValue('2026-09-30');
  await expect(page.locator('.report-card .card-heading p')).toContainText('as at 2026-09-30');
  // Space activates a report link too.
  await page.locator('.reports-menu').getByRole('button', { name: 'Balance sheet', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(reportTitle(page)).toHaveText('Balance sheet');
});

test('RPT-077 Report numbers use tabular numerals, right-aligned', async () => {
  const { page } = s;
  for (const label of ['Aged receivables', 'Sales analysis', 'Profit & loss', 'Trial balance']) {
    await reports(page, label);
    const cells = await page.locator('.report-table td.num, .report-table th.num').evaluateAll(els => els.map(el => ({ nums: getComputedStyle(el).fontVariantNumeric, align: getComputedStyle(el).textAlign, wrap: getComputedStyle(el).whiteSpace, text: el.textContent ?? '' })));
    expect(cells.length, label).toBeGreaterThan(3);
    for (const c of cells) expect({ nums: c.nums, align: c.align, wrap: c.wrap }, `${label}: ${c.text}`).toEqual({ nums: 'tabular-nums', align: 'right', wrap: 'nowrap' });
    // Formatted amounts are PKR with thousands separators.
    const amounts = cells.map(c => c.text).filter(t => t.startsWith('Rs '));
    expect(amounts.length, label).toBeGreaterThan(0);
    for (const a of amounts) expect(a, label).toMatch(/^Rs -?\d{1,3}(,\d{3})*(\.\d{1,2})?$/);
  }
});

test('RPT-079 Totals row is bold [documented: bold with a heavy top border; not sticky]', async () => {
  const { page } = s;
  await reports(page, 'Trial balance');
  const foot = page.locator('.report-table tfoot td');
  await expect(foot.nth(1)).toHaveText('Total');
  const st = await foot.evaluateAll(els => els.map(el => { const cs = getComputedStyle(el); return { weight: cs.fontWeight, border: `${cs.borderTopWidth} ${cs.borderTopStyle}`, position: getComputedStyle(el.parentElement!).position === 'sticky' || cs.position === 'sticky' }; }));
  for (const c of st) expect(c).toEqual({ weight: '700', border: '2px solid', position: false });
  const body = await page.locator('.report-table tbody td').first().evaluate(el => getComputedStyle(el).fontWeight);
  expect(Number(body)).toBeLessThan(700);
});

test('RPT-088 Empty-state text is helpful, without jargon', async () => {
  const { page } = s;
  await reports(page, 'Stock movements');
  await page.getByLabel('From date').fill('2020-01-01');
  await page.getByLabel('To date').fill('2020-01-31');
  const empty = page.locator('.report-table .empty-state');
  await expect(empty).toHaveText('Nothing to report for these parameters.');
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  await chooseReport(page, 'Customer / supplier statement');
  await expect(page.locator('.report-table thead th')).toHaveText(['Choose a customer or supplier']);
  await expect(empty).toHaveText('Nothing to report for these parameters.');
  for (const text of await page.locator('.report-card').allInnerTexts()) expect(text).not.toMatch(/\b(null|undefined|NaN|ledger code|projection|snapshot|tenant)\b/i);
});

test('RPT-089 Report selector is usable on a phone', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true, isMobile: true });
  const { page } = phone;
  try {
    await gotoApp(page);
    await openModule(page, 'Reports');
    const links = reportLinks(page);
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(10);
    const boxes = await links.evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { label: el.textContent, left: r.left, right: r.right, height: r.height }; }));
    for (const b of boxes) { expect(b.left, b.label!).toBeGreaterThanOrEqual(0); expect(b.right, b.label!).toBeLessThanOrEqual(PHONE.width); expect(b.height, `${b.label} tap height`).toBeGreaterThanOrEqual(24); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.reports-menu').getByRole('button', { name: 'Stock valuation', exact: true }).tap();
    await expect(reportTitle(page)).toHaveText('Stock valuation');
    await page.locator('.reports-menu').getByRole('button', { name: 'Balance sheet', exact: true }).tap();
    await expect(reportTitle(page)).toHaveText('Balance sheet');
    await expect(page.locator('.reports-menu .report-link.active')).toHaveText('Balance sheet');
  } finally { await phone.context.close(); }
});

test('RPT-090 Deep link to a report [documented: reports are not routed — /reports and ?report= open the app at Overview]', async () => {
  const { page } = s;
  for (const path of [`/reports?tenant=${QA_TENANT}`, `${APP}&report=trial_balance`]) {
    await gotoApp(page, path);
    await expect(page.locator('.breadcrumb strong'), path).toHaveText('Overview');
  }
  await openModule(page, 'Reports');
  await expect(reportTitle(page)).toHaveText('Aged receivables');
});

test('RPT-097 Reports reflect a command made in another tab on next load [documented: the open tab does not refresh by itself]', async () => {
  const { page, context } = s;
  await reports(page, 'Aged receivables');
  const footTotal = page.locator('.report-table tfoot td').last();
  const before = await footTotal.innerText();
  // Another tab of the same session records a new invoice.
  const other = await context.newPage();
  await gotoApp(other);
  const w = await readWorkspaceApi(other.request);
  const metro = w.parties.find(p => p.name === F.metro)!; const led = w.items.find(i => i.sku === 'QA-LED')!;
  const created = await post(other.request, 'create_document', { kind: 'sales_invoice', partyId: metro.id, warehouseId: w.warehouses[0].id, date: '2026-10-12', dueDate: '2026-10-30', currency: 'PKR', fxRate: '1', notes: '', lines: [{ itemId: led.id, quantity: '1', price: '7000', discount: '0', taxRate: '0', employeeId: '', splits: [] }] });
  expect(created.status).toBe(200);
  expect((await post(other.request, 'submit_document', { id: created.body.recordId })).status).toBe(200);
  await other.close();
  const after = await readWorkspaceApi(context.request);
  const expected = formatMoney(agedBalances(after, 'customer', (await page.getByLabel('As at date').inputValue())).totals.total);
  expect(expected).not.toBe(before);
  await page.waitForTimeout(1500);
  await expect(footTotal).toHaveText(before);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('button.nav-item').first()).toBeEnabled({ timeout: 60_000 });
  await openModule(page, 'Reports');
  await expect(page.locator('.report-table tfoot td').last()).toHaveText(expected);
});
