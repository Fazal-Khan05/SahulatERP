import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { toggleModules } from '../../src/modules/erp/modules';
import { F, PHONE, freshBuilder, gotoApp, home, openModule, readWorkspaceApi, richWorkspace, sharedSession, signedInPage, writeQaWorkspace, type Session, AUTH_FILE, QA_TENANT, authState } from './helpers';

/** The rich company plus one payroll run in every status: 06 paid, 07 approved, 08 reviewed, 09 draft. */
function payrollWorkspace() {
  const r = richWorkspace(); const b = r.b;
  const paid = b.run('create_payroll', { month: '2026-06', date: '2026-06-30' });
  for (const status of ['reviewed', 'approved', 'paid']) b.run('update_payroll', { id: paid, status });
  const approved = b.run('create_payroll', { month: '2026-07', date: '2026-07-31' });
  for (const status of ['reviewed', 'approved']) b.run('update_payroll', { id: approved, status });
  const reviewed = b.run('create_payroll', { month: '2026-08', date: '2026-08-31' });
  b.run('update_payroll', { id: reviewed, status: 'reviewed' });
  return b.w;
}

let s: Session;
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser, {}, payrollWorkspace()); });
test.afterAll(async () => { await s?.context.close(); });

// Another suite may sign this shared account out globally (Supabase revokes every session); re-sign in when that happens.
test.beforeEach(async ({ browser }) => {
  if (!s || (await s.context.request.get(`/api/workspace?tenant=${QA_TENANT}`)).status() === 200) return;
  await authState(browser);
  await s.context.clearCookies();
  await s.context.addCookies(JSON.parse(readFileSync(AUTH_FILE, 'utf8')).cookies);
  await gotoApp(s.page);
});

async function payroll(page: Page) { await home(page); await openModule(page, 'Payroll'); }
const runsCard = (page: Page) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Payroll runs' }) });
const runRow = (page: Page, number: string) => runsCard(page).locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: number }) });

test('PAY-064 Payroll status badges use distinct colours [defect]', async () => {
  const { page } = s;
  await payroll(page);
  const badges = await runsCard(page).locator('tbody tr td:nth-child(5) .badge').evaluateAll(els => els.map(b => ({ text: b.textContent ?? '', colour: `${getComputedStyle(b).backgroundColor} / ${getComputedStyle(b).color}` })));
  const byStatus = Object.fromEntries(badges.map(b => [b.text, b.colour]));
  test.info().annotations.push({ type: 'actual', description: JSON.stringify(byStatus) });
  expect(Object.keys(byStatus).sort()).toEqual(['approved', 'draft', 'paid', 'reviewed']);
  expect(new Set(Object.values(byStatus)).size, 'four statuses, four colours').toBe(4);
});

test('PAY-063 Payroll lines table is readable on a phone (scrolls)', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true, isMobile: true });
  const { page } = phone;
  try {
    await gotoApp(page);
    await openModule(page, 'Payroll');
    // What exists today: the runs table scrolls sideways with a hint and the page itself does not.
    const runs = runsCard(page).locator('.table-scroll');
    expect(await runs.evaluate(el => ({ overflow: getComputedStyle(el).overflowX, scrolls: el.scrollWidth > el.clientWidth }))).toEqual({ overflow: 'auto', scrolls: true });
    await expect(runsCard(page).locator('.table-scroll-hint')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // A run opens its per-employee lines (basic, allowance, commission, EOBI, tax, net).
    await runRow(page, 'PAY-2026-09').locator('td:first-child').tap();
    const lines = page.locator('table').filter({ has: page.locator('th', { hasText: /^(Basic|Net pay|Net)$/ }) }).filter({ hasText: F.salesperson });
    await expect(lines, 'a payroll lines table with one row per employee').toHaveCount(1, { timeout: 5000 });
    await expect(lines.locator('thead th')).toHaveText(['Employee', 'Basic', 'Allowance', 'Commission', 'Recovery', 'Employee EOBI', 'Income tax', 'Deductions', 'Net pay']);
    // The lines table scrolls sideways inside its card; the page does not.
    const region = page.locator('.table-scroll').filter({ has: lines });
    expect(await region.evaluate(el => ({ overflow: getComputedStyle(el).overflowX, scrolls: el.scrollWidth > el.clientWidth }))).toEqual({ overflow: 'auto', scrolls: true });
    await expect(region).toHaveAttribute('tabindex', '0');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await phone.context.close(); }
});

test('PAY-088 Transition button is disabled while a command is busy', async () => {
  const { page, context } = s;
  await payroll(page);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  await page.route('**/api/workspace', async route => { if (route.request().method() === 'POST') await gate; await route.continue(); });
  try {
    const row = runRow(page, 'PAY-2026-09');
    const button = row.getByRole('button', { name: 'reviewed' });
    await button.click();
    await expect(button).toBeDisabled();
    await expect(runRow(page, 'PAY-2026-08').getByRole('button', { name: 'approved' })).toBeDisabled();
    await expect(runsCard(page).getByRole('button', { name: 'Create payroll' })).toBeDisabled();
    release();
    await expect(row.locator('.badge')).toHaveText('reviewed', { timeout: 30_000 });
    await expect(row.getByRole('button', { name: 'approved' })).toBeEnabled();
  } finally { release(); await page.unroute('**/api/workspace'); }
  const w = await readWorkspaceApi(context.request);
  expect(w.payrolls.find(p => p.number === 'PAY-2026-09')!.status).toBe('reviewed');
});

test('PAY-089 Line commission tooltip lists invoices [documented: not present — no tooltip; a run opens its per-employee amounts (PAY-063), not the invoices behind the commission]', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const run = w.payrolls.find(p => p.number === 'PAY-2026-09')!;
  const invoiceNumbers = run.lines.flatMap(l => l.commissionIds).map(id => w.documents.find(d => d.id === w.commissions.find(c => c.id === id)!.invoiceId)!.number);
  expect(invoiceNumbers.length).toBeGreaterThan(0);
  await payroll(page);
  const row = runRow(page, 'PAY-2026-09');
  await row.hover();
  const titled = await runsCard(page).evaluate(el => [...el.querySelectorAll('[title],[aria-describedby],[data-tooltip]')].map(x => x.getAttribute('title') ?? x.getAttribute('data-tooltip') ?? 'described'));
  expect(titled).toEqual([]);
  for (const n of invoiceNumbers) await expect(runsCard(page)).not.toContainText(n);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('PAY-096 Payroll transition buttons are keyboard focusable and operable', async () => {
  const { page, context } = s;
  await payroll(page);
  const row = runRow(page, 'PAY-2026-08');
  const approve = row.getByRole('button', { name: 'approved' });
  await runsCard(page).getByRole('button', { name: 'Create payroll' }).focus();
  // Tab from Create payroll reaches the transition buttons in table order.
  const order: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName}:${a.textContent?.trim()}:${a.closest('tr')?.querySelector('td')?.textContent ?? ''}` : ''; });
    order.push(label);
    if (label === 'BUTTON:approved:PAY-2026-08') break;
  }
  test.info().annotations.push({ type: 'actual', description: `tab order ${order.join(' → ')}` });
  await expect(approve).toBeFocused();
  const ring = await approve.evaluate(el => { const cs = getComputedStyle(el); return { outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== 'none' }; });
  expect(ring.outline || ring.shadow, 'visible focus indicator').toBe(true);
  await page.keyboard.press('Enter');
  await expect(row.locator('.badge')).toHaveText('approved', { timeout: 30_000 });
  const pay = row.getByRole('button', { name: 'paid' });
  await pay.focus();
  await page.keyboard.press('Space');
  await expect(row.locator('.badge')).toHaveText('paid', { timeout: 30_000 });
  await expect(row.locator('td').last()).toHaveText('Complete');
  const w = await readWorkspaceApi(context.request);
  expect(w.payrolls.find(p => p.number === 'PAY-2026-08')!.status).toBe('paid');
});

test('PAY-062 Settings → Payroll is visible while Payroll is on', async () => {
  const { page, context } = s;
  // A real (non-demo) company: payroll settings start blank, so the engine asks for Settings → Payroll.
  const b = freshBuilder();
  b.run('save_employee', { name: F.salesperson, role: 'Order Booker', territory: 'Karachi', salary: '45000', allowance: '0', deduction: '0', attendance: 30, active: true });
  await writeQaWorkspace(b.w);
  try {
    await gotoApp(page);
    await openModule(page, 'Payroll');
    await runsCard(page).getByRole('button', { name: 'Create payroll' }).click();
    await expect(page.locator('.error-note[role=alert]')).toContainText('Settings → Payroll');
    await openModule(page, 'Settings');
    const tabs = await page.getByRole('tab').allInnerTexts();
    test.info().annotations.push({ type: 'actual', description: `Settings tabs with Payroll on: ${tabs.join(', ')}` });
    await expect(page.getByRole('tab', { name: 'Payroll' }), 'Settings has a Payroll section while Payroll is on').toBeVisible({ timeout: 5000 });
    await page.getByRole('tab', { name: 'Payroll' }).click();
    await expect(page.getByLabel(/EOBI/).first()).toBeVisible();
    // Entering the rates there lets the first payroll run go through.
    await page.getByLabel('Employer EOBI (%)').fill('5');
    await page.getByLabel('Employee EOBI (%)').fill('1');
    await page.getByLabel('EOBI wage base (PKR)').fill('37000');
    await page.getByLabel('Income-tax rate (%)').fill('5');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Payroll and tax settings saved.')).toBeVisible({ timeout: 30_000 });
    expect((await readWorkspaceApi(context.request)).settings).toMatchObject({ employerEobi: '5', employeeEobi: '1', eobiBase: '37000', incomeTaxRate: '5' });
    await openModule(page, 'Payroll');
    await runsCard(page).getByRole('button', { name: 'Create payroll' }).click();
    await expect(runsCard(page).locator('tbody tr').filter({ hasText: 'PAY-' })).toHaveCount(1, { timeout: 30_000 });
    expect((await readWorkspaceApi(context.request)).payrolls).toHaveLength(1);
    // With Payroll off the tab keeps only the tax settings.
    await writeQaWorkspace(freshBuilder(toggleModules.filter(m => m !== 'payroll')).w);
    await gotoApp(page);
    await openModule(page, 'Settings');
    await expect(page.getByRole('tab', { name: 'Payroll' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Tax & numbering' }).click();
    await expect(page.getByLabel('Default sales-tax rate (%)')).toBeVisible();
    await expect(page.getByLabel(/EOBI/)).toHaveCount(0);
  } finally {
    await writeQaWorkspace(payrollWorkspace());
  }
});

test('PAY-025 A stale run is cancelled from Payroll (after a confirmation) and its month created again', async () => {
  const { page, context } = s;
  await writeQaWorkspace(payrollWorkspace());
  await gotoApp(page);
  await payroll(page);
  try {
    const row = runRow(page, 'PAY-2026-09');
    // Approved and paid runs cannot be cancelled; draft and reviewed ones can.
    await expect(runRow(page, 'PAY-2026-07').getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
    await expect(runRow(page, 'PAY-2026-08').getByRole('button', { name: 'Cancel run' })).toBeVisible();
    await row.getByRole('button', { name: 'Cancel run' }).click();
    const confirm = page.getByRole('dialog', { name: 'Cancel PAY-2026-09?' });
    await expect(confirm).toContainText('commissions it holds are released');
    await confirm.getByRole('button', { name: 'Keep run' }).click();
    await expect(row.locator('.badge')).toHaveText('draft');
    await row.getByRole('button', { name: 'Cancel run' }).click();
    await confirm.getByRole('button', { name: 'Cancel run' }).click();
    await expect(confirm).toHaveCount(0, { timeout: 30_000 });
    await expect(row.locator('.badge')).toHaveText('cancelled');
    await expect(row.locator('td').last()).toHaveText('Cancelled');
    // The month can be created again: it recalculates in place.
    await runsCard(page).getByLabel('Payroll month').fill('2026-09');
    await runsCard(page).getByRole('button', { name: 'Create payroll' }).click();
    await expect(row.locator('.badge')).toHaveText('draft', { timeout: 30_000 });
    const runs = (await readWorkspaceApi(context.request)).payrolls.filter(p => p.month === '2026-09');
    expect(runs.map(p => [p.status, p.date])).toEqual([['draft', '2026-09-30']]);
  } finally {
    await writeQaWorkspace(payrollWorkspace());
    await gotoApp(page);
  }
});
