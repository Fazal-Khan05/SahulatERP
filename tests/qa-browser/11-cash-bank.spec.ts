import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { DESKTOP, PHONE, gotoApp, home, openModule, post, readWorkspaceApi, sharedSession, signedInPage, type Session, AUTH_FILE, QA_TENANT, authState } from './helpers';
import { accountBalance } from '../../src/modules/erp/engine';

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

async function cashBank(page: Page) { await home(page); await openModule(page, 'Cash & bank'); }
const metricCards = (page: Page) => page.locator('.metric-grid > .metric-card');
const accountCard = (page: Page, name: string) => metricCards(page).filter({ has: page.locator('.metric-label', { hasText: name }) });
const accountsCard = (page: Page) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Accounts', exact: true }) });
const accountRow = (page: Page, name: string) => accountsCard(page).locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: name }) });
const activityCard = (page: Page) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: /^Activity · / }) });
const dialog = (page: Page) => page.getByRole('dialog');
const amount = (text: string) => Number(text.replace(/[^\d.-]/g, '') || '0');
const isRed = (rgb: string) => { const [r, g, b] = (rgb.match(/\d+/g) ?? ['0', '0', '0']).map(Number); return r > 150 && r > g + 60 && r > b + 60; };

test('CSH-049 Account cards show a bank or cash type icon', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await cashBank(page);
  const shown = w.bankAccounts.filter(a => !a.archived).slice(0, 3);
  expect(shown.map(a => a.type)).toEqual(expect.arrayContaining(['bank', 'cash']));
  for (const a of shown) {
    const card = accountCard(page, a.name);
    await expect(card).toHaveCount(1);
    await expect(card.locator(`.metric-icon svg.lucide-${a.type === 'bank' ? 'landmark' : 'banknote'}`)).toHaveCount(1);
    await expect(card.locator(`.metric-icon svg.lucide-${a.type === 'bank' ? 'banknote' : 'landmark'}`)).toHaveCount(0);
  }
});

test('CSH-050 Negative balance is styled red', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const petty = w.bankAccounts.find(a => a.name === 'Petty cash')!;
  expect(Number(accountBalance(w, petty.code))).toBeLessThan(0);
  await cashBank(page);
  const cardValue = accountCard(page, 'Petty cash').locator('strong');
  const tableValue = accountRow(page, 'Petty cash').locator('td').nth(4);
  await expect(cardValue).toHaveText('Rs -500');
  await expect(tableValue).toHaveText('Rs -500');
  const colours = { card: await cardValue.evaluate(el => getComputedStyle(el).color), table: await tableValue.evaluate(el => getComputedStyle(el).color) };
  test.info().annotations.push({ type: 'actual', description: `negative balance colours ${JSON.stringify(colours)}` });
  expect(isRed(colours.card), `card colour ${colours.card} is red`).toBe(true);
  expect(isRed(colours.table), `table colour ${colours.table} is red`).toBe(true);
});

test('CSH-051 Cash & bank dialogs open as bottom sheets on a phone', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  const { page } = phone;
  const boxes: Record<string, unknown> = {};
  try {
    await gotoApp(page);
    await openModule(page, 'Cash & bank');
    for (const [button, title] of [['Transfer', 'Transfer between accounts'], ['Record expense', 'Record an expense'], ['New account', 'New bank or cash account']] as const) {
      await accountsCard(page).getByRole('button', { name: button, exact: true }).click();
      const sheet = page.getByRole('dialog', { name: title });
      await expect(sheet).toBeVisible();
      await expect.poll(async () => sheet.evaluate(el => { const r = el.getBoundingClientRect(); return Math.round(r.bottom); })).toBe(PHONE.height);
      const box = await sheet.evaluate(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { left: Math.round(r.left), width: Math.round(r.width), topInset: r.top > 0, topRadius: parseFloat(cs.borderTopLeftRadius) > 0, bottomRadius: parseFloat(cs.borderBottomLeftRadius) }; });
      boxes[title] = box;
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
    }
  } finally { await phone.context.close(); }
  // Full width and anchored to the bottom edge; square bottom corners so the sheet meets the screen edge.
  for (const [title, box] of Object.entries(boxes)) expect(box, title).toEqual({ left: 0, width: PHONE.width, topInset: true, topRadius: true, bottomRadius: 0 });
});

test('CSH-052 Transfer dialog closes on success', async () => {
  const { page, context } = s;
  const before = await readWorkspaceApi(context.request);
  const bank = before.bankAccounts.find(a => a.id === 'main-bank')!; const cash = before.bankAccounts.find(a => a.id === 'cash')!;
  await cashBank(page);
  await accountsCard(page).getByRole('button', { name: 'Transfer', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Transfer between accounts' });
  await d.getByLabel('From account').selectOption(bank.id);
  await d.getByLabel('To account').selectOption(cash.id);
  await d.getByLabel('Transfer amount').fill('1250');
  await d.getByPlaceholder('Cash float, bank deposit…').fill('QA float CSH-052');
  await d.getByRole('button', { name: 'Transfer', exact: true }).click();
  await expect(d).toHaveCount(0, { timeout: 30_000 });
  const after = await readWorkspaceApi(context.request);
  expect(Number(accountBalance(after, cash.code)) - Number(accountBalance(before, cash.code))).toBe(1250);
  expect(Number(accountBalance(after, bank.code)) - Number(accountBalance(before, bank.code))).toBe(-1250);
});

test('CSH-053 Expense dialog closes on success', async () => {
  const { page, context } = s;
  const before = await readWorkspaceApi(context.request);
  const cash = before.bankAccounts.find(a => a.id === 'cash')!;
  await cashBank(page);
  await accountsCard(page).getByRole('button', { name: 'Record expense' }).click();
  const d = page.getByRole('dialog', { name: 'Record an expense' });
  await d.getByLabel('Paid from account').selectOption(cash.id);
  await d.getByLabel('Expense amount').fill('275');
  await d.getByLabel('Expense memo').fill('QA fuel CSH-053');
  await d.getByRole('button', { name: 'Record expense' }).click();
  await expect(d).toHaveCount(0, { timeout: 30_000 });
  const after = await readWorkspaceApi(context.request);
  expect(Number(accountBalance(after, cash.code)) - Number(accountBalance(before, cash.code))).toBe(-275);
  await expect(activityCard(page)).toBeVisible();
});

test('CSH-066 Account details text shows on the card [documented: bank cards show details; cash cards show "Cash"]', async () => {
  const { page } = s;
  await cashBank(page);
  await expect(accountCard(page, 'Main bank account').locator('small')).toHaveText('HBL · Saddar branch · 0012-3456789');
  // Edit the details through the form; the card follows.
  await accountRow(page, 'Main bank account').getByRole('button', { name: 'Edit Main bank account' }).click();
  const d = page.getByRole('dialog', { name: 'Edit Main bank account' });
  await d.getByLabel('Bank / branch / account no.').fill('Meezan · Clifton branch · 0101-7654321');
  await d.getByRole('button', { name: 'Save changes' }).click();
  await expect(d).toHaveCount(0, { timeout: 30_000 });
  await expect(accountCard(page, 'Main bank account').locator('small')).toHaveText('Meezan · Clifton branch · 0101-7654321');
  await expect(accountRow(page, 'Main bank account').locator('td').nth(2)).toHaveText('Meezan · Clifton branch · 0101-7654321');
  // Cash accounts: the card shows the type, not the details.
  await expect(accountCard(page, 'Cash in hand').locator('small')).toHaveText('Cash');
});

test('CSH-077 Activity shows In / Out columns with a running balance', async () => {
  const { page } = s;
  await cashBank(page);
  await accountRow(page, 'Cash in hand').getByRole('button', { name: 'Activity' }).click();
  await expect(activityCard(page).getByRole('heading')).toHaveText('Activity · Cash in hand');
  await expect(activityCard(page).locator('thead th')).toHaveText(['Date', 'Journal', 'Description', 'In', 'Out', 'Balance']);
  const rows = await activityCard(page).locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent ?? '')));
  expect(rows.length).toBeGreaterThanOrEqual(2);
  // Newest first: each balance = the next (older) row's balance + in − out; the oldest row starts from zero.
  for (let i = 0; i < rows.length; i++) {
    const older = i + 1 < rows.length ? amount(rows[i + 1][5]) : 0;
    expect(amount(rows[i][5]), `row ${i + 1} running balance`).toBeCloseTo(older + amount(rows[i][3]) - amount(rows[i][4]), 2);
    expect(rows[i][3] === '' || rows[i][4] === '', `row ${i + 1} has either In or Out`).toBe(true);
  }
  const heading = await activityCard(page).locator('.card-heading p').innerText();
  expect(heading).toContain(`Balance ${rows[0][5]}`);
});

test('CSH-078 Long memo stays readable in the activity [documented: the memo wraps in full; no truncation or tooltip]', async () => {
  const { page } = s;
  await cashBank(page);
  await accountRow(page, 'Cash in hand').getByRole('button', { name: 'Activity' }).click();
  const cell = activityCard(page).locator('tbody tr td:nth-child(3)').filter({ hasText: 'Courier to Lahore' });
  await expect(cell).toHaveCount(1);
  await expect(cell).toContainText('a long description that should truncate');
  const m = await cell.evaluate(el => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { clipped: el.scrollWidth > el.clientWidth + 1, ellipsis: cs.textOverflow === 'ellipsis', title: el.getAttribute('title'), lines: Math.round(r.height / parseFloat(cs.lineHeight || '20')), fontSize: parseFloat(cs.fontSize) }; });
  test.info().annotations.push({ type: 'actual', description: JSON.stringify(m) });
  expect(m.clipped).toBe(false);
  expect(m.ellipsis).toBe(false);
  expect(m.title).toBeNull();
  expect(m.fontSize).toBeGreaterThanOrEqual(12);
  expect(await noPageScroll(page)).toBe(true);
});
const noPageScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('CSH-083 Enter submits the transfer form', async () => {
  const { page, context } = s;
  const before = await readWorkspaceApi(context.request);
  await cashBank(page);
  await accountsCard(page).getByRole('button', { name: 'Transfer', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Transfer between accounts' });
  await d.getByLabel('Transfer amount').fill('300');
  await d.getByPlaceholder('Cash float, bank deposit…').fill('QA keyboard CSH-083');
  await d.getByLabel('Transfer amount').press('Enter');
  await expect(d).toHaveCount(0, { timeout: 30_000 });
  const after = await readWorkspaceApi(context.request);
  expect(after.journals.length).toBe(before.journals.length + 1);
  expect(after.journals.at(-1)!.lines.some(l => Number(l.debit) === 300)).toBe(true);
});

test('CSH-084 Escape closes the cash & bank dialogs', async () => {
  const { page } = s;
  await cashBank(page);
  for (const [button, title] of [['Transfer', 'Transfer between accounts'], ['Record expense', 'Record an expense'], ['New account', 'New bank or cash account']] as const) {
    await accountsCard(page).getByRole('button', { name: button, exact: true }).click();
    await expect(page.getByRole('dialog', { name: title })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  }
  await accountRow(page, 'Cash in hand').getByRole('button', { name: 'Edit Cash in hand' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Cash in hand' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});

test('CSH-094 Tapping an account on a phone opens its activity [case-corrected: summary cards are not tappable; the account name in the Accounts list opens the activity]', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true, isMobile: true });
  const { page } = phone;
  try {
    await gotoApp(page);
    await openModule(page, 'Cash & bank');
    await expect(activityCard(page).getByRole('heading')).toHaveText('Activity · Main bank account');
    // The summary card is display-only.
    await accountCard(page, 'Petty cash').tap();
    await expect(activityCard(page).getByRole('heading')).toHaveText('Activity · Main bank account');
    expect(await accountCard(page, 'Petty cash').evaluate(el => el.closest('button,a,[role=button]') === null && el.querySelector('button,a') === null)).toBe(true);
    // The account name in the list opens its activity.
    await accountRow(page, 'Petty cash').getByRole('button', { name: 'Petty cash', exact: true }).tap();
    await expect(activityCard(page).getByRole('heading')).toHaveText('Activity · Petty cash');
    await expect(activityCard(page)).toContainText('Tea and snacks');
    await expect(accountRow(page, 'Petty cash')).toHaveClass(/row-selected/);
  } finally { await phone.context.close(); }
});

test('CSH-095 Card hover lift only with a mouse [defect]', async ({ browser }) => {
  // Touch: no hover styles at all (no sticky hover after a tap).
  let touched: { transform: string; shadow: string } | undefined;
  const touch = await signedInPage(browser, { viewport: PHONE, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  try {
    await gotoApp(touch.page);
    await openModule(touch.page, 'Cash & bank');
    const media = await touch.page.evaluate(() => ({ fine: matchMedia('(hover: hover) and (pointer: fine)').matches, none: matchMedia('(hover: none)').matches }));
    expect(media).toEqual({ fine: false, none: true });
    const tc = accountCard(touch.page, 'Main bank account');
    await tc.tap();
    await tc.hover();
    touched = await tc.evaluate(el => ({ transform: getComputedStyle(el).transform, shadow: getComputedStyle(el).boxShadow }));
  } finally { await touch.context.close(); }
  // Mouse: the card should lift by 1px on hover (globals.css hover:hover rule).
  const { page } = s;
  await cashBank(page);
  const card = accountCard(page, 'Main bank account');
  await page.waitForTimeout(1000); // entrance cascade finished
  await card.hover();
  const hovered = await card.evaluate(el => ({ transform: getComputedStyle(el).transform, shadow: getComputedStyle(el).boxShadow, animation: getComputedStyle(el).animationName, fill: getComputedStyle(el).animationFillMode }));
  await page.mouse.move(5, 5);
  test.info().annotations.push({ type: 'actual', description: `touch after tap: ${JSON.stringify(touched)}; mouse hover: ${JSON.stringify(hovered)}` });
  expect(touched, 'no sticky hover styles after a tap on touch').toEqual({ transform: 'none', shadow: 'none' });
  expect(hovered.shadow).not.toBe('none');
  expect(hovered.transform, 'mouse hover lifts the card').toBe('matrix(1, 0, 0, 1, 0, -1)');
});

test('CSH-085 Account selects use one consistent order [documented: creation order everywhere, not bank-first or alphabetical]', async () => {
  const { page, context } = s;
  expect((await post(context.request, 'save_bank_account', { name: 'Allied current', type: 'bank', details: 'ABL · Tariq Road' })).status).toBe(200);
  const w = await readWorkspaceApi(context.request);
  const active = w.bankAccounts.filter(a => !a.archived);
  const creation = active.map(a => a.name);
  await gotoApp(page);
  await openModule(page, 'Cash & bank');
  const optionNames = async (label: string) => (await page.getByRole('dialog').getByLabel(label).locator('option').allInnerTexts()).map(t => t.split(' · ')[0]);
  const table = (await accountsCard(page).locator('tbody tr td:first-child').allInnerTexts()).filter(t => !t.includes('legacy'));
  await accountsCard(page).getByRole('button', { name: 'Transfer', exact: true }).click();
  const from = await optionNames('From account'); const to = await optionNames('To account');
  await page.keyboard.press('Escape');
  await accountsCard(page).getByRole('button', { name: 'Record expense' }).click();
  const paidFrom = await optionNames('Paid from account');
  await page.keyboard.press('Escape');
  const bankFirst = [...active.filter(a => a.type === 'bank'), ...active.filter(a => a.type === 'cash')].map(a => a.name);
  const alphabetical = [...creation].sort((a, b) => a.localeCompare(b));
  test.info().annotations.push({ type: 'actual', description: `order ${creation.join(' | ')}` });
  expect({ table, from, to, paidFrom }).toEqual({ table: creation, from: creation, to: creation, paidFrom: creation });
  expect(creation).not.toEqual(bankFirst);
  expect(creation).not.toEqual(alphabetical);
  expect(page.viewportSize()).toEqual(DESKTOP);
});
