import { expect, test, type Page } from '@playwright/test';
import { F, PHONE, gotoApp, home, openModule, readWorkspaceApi, richWorkspace, sharedSession, signedInPage, writeQaWorkspace, type Session, keepSignedIn } from './helpers';
import { D } from '../../src/modules/erp/money';

let s: Session;
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); });
test.beforeEach(async ({ browser }) => { if (s) await keepSignedIn(browser, s.context, s.page); });
test.afterAll(async () => { await s?.context.close(); });

const receiptDialog = (page: Page) => page.getByRole('dialog', { name: 'Record customer receipt' });
async function collections(page: Page) { await home(page); await openModule(page, 'Collections'); }
async function openReceipt(page: Page) {
  await collections(page);
  await page.getByRole('button', { name: 'Record receipt' }).first().click();
  await expect(receiptDialog(page)).toBeVisible();
}
const chequeCard = (page: Page) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Cheques in hand' }) });
const receiptsCard = (page: Page) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Customer receipts' }) });

test('COL-002 Typing a total spreads it across open invoices oldest first; allocations stay editable', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const metro = w.parties.find(p => p.name === F.metro)!;
  const open = w.documents.filter(d => d.kind === 'sales_invoice' && d.status === 'submitted' && d.partyId === metro.id && D(d.total).minus(d.paid).minus(d.returned).gt(0)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  expect(open.length).toBeGreaterThan(1);
  const first = D(open[0].total).minus(open[0].paid).minus(open[0].returned);
  await openReceipt(page);
  await receiptDialog(page).getByLabel('Customer').selectOption(metro.id);
  await expect(receiptDialog(page).locator('tbody tr td:first-child strong')).toHaveText(open.map(d => d.number));
  await receiptDialog(page).getByLabel('Amount to allocate oldest first').fill(first.plus(1000).toString());
  await expect(receiptDialog(page).getByLabel(`Allocate to ${open[0].number}`)).toHaveValue(first.toFixed(4));
  await expect(receiptDialog(page).getByLabel(`Allocate to ${open[1].number}`)).toHaveValue('1000.0000');
  await receiptDialog(page).getByLabel(`Allocate to ${open[1].number}`).fill('250');
  await expect(receiptDialog(page).locator('.payment-summary strong')).toHaveText(`Rs ${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 }).format(first.plus(250).toNumber())}`);
  await page.keyboard.press('Escape');
});

test('COL-031 Cheques in hand list received/deposited cheques with per-state buttons', async () => {
  const { page } = s;
  await collections(page);
  const received = chequeCard(page).locator('tbody tr').filter({ hasText: 'CHQ-1001' });
  const deposited = chequeCard(page).locator('tbody tr').filter({ hasText: 'CHQ-1002' });
  await expect(received.locator('.badge')).toHaveText('received');
  await expect(received.getByRole('button')).toHaveText(['Deposit', 'Bounced']);
  await expect(received.getByLabel('Deposit account for CHQ-1001')).toBeVisible();
  await expect(deposited.locator('.badge')).toHaveText('deposited');
  await expect(deposited.getByRole('button')).toHaveText(['Cleared', 'Bounced']);
  await expect(chequeCard(page).locator('tbody tr').filter({ hasText: /CHQ-1003|CHQ-1004/ })).toHaveCount(0);
});

test('COL-032 Attention: cheques due today/overdue are listed', async () => {
  const { page } = s;
  await home(page);
  await expect(page.locator('.attention-row').filter({ hasText: 'Cheques due for deposit or clearing' })).toContainText('2 records');
});

test('COL-054 Follow-up list per customer is newest first', async () => {
  const { page } = s;
  await collections(page);
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Recovery follow-ups' }) });
  const notes = await card.locator('tbody tr td:nth-child(3)').allInnerTexts();
  expect(notes.indexOf('Visited shop; owner away')).toBeLessThan(notes.indexOf('Called; promised payment Friday'));
  expect(notes[0]).toBe('Visited shop; owner away');
});

test('COL-055 Follow-up dialog closes on success', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await collections(page);
  await page.getByRole('button', { name: 'Log follow-up' }).click();
  const dialog = page.getByRole('dialog', { name: 'Log recovery follow-up' });
  await dialog.locator('select[name=partyId]').selectOption(w.parties.find(p => p.name === F.metro)!.id);
  await dialog.locator('textarea[name=note]').fill('QA: asked for cheque on Monday');
  await dialog.getByRole('button', { name: 'Save follow-up' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Recovery follow-ups' }) }).locator('tbody tr').first()).toContainText('QA: asked for cheque on Monday');
});

test('COL-065 Receipt dialog on phone: bottom sheet; allocations table scrolls', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true });
  const w = await readWorkspaceApi(phone.context.request);
  await gotoApp(phone.page);
  await openModule(phone.page, 'Collections');
  await phone.page.getByRole('button', { name: 'Record receipt' }).first().click();
  await receiptDialog(phone.page).getByLabel('Customer').selectOption(w.parties.find(p => p.name === F.metro)!.id);
  await phone.page.waitForTimeout(500);
  const box = (await receiptDialog(phone.page).boundingBox())!;
  const vp = await phone.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const table = await receiptDialog(phone.page).locator('.editor-lines').evaluate(el => ({ overflow: getComputedStyle(el).overflowX, right: el.getBoundingClientRect().right }));
  await phone.context.close();
  expect(Math.round(box.width)).toBe(vp.w);
  expect(Math.abs(box.y + box.height - vp.h)).toBeLessThan(2);
  expect(table.overflow).toBe('auto');
  expect(table.right).toBeLessThanOrEqual(vp.w);
});

test('COL-066 Cheque fields are shown only for the cheque method', async () => {
  const { page } = s;
  await openReceipt(page);
  for (const method of ['bank', 'cash']) {
    await receiptDialog(page).getByLabel('Payment method').selectOption(method);
    await expect(receiptDialog(page).getByLabel('Cheque number')).toHaveCount(0);
    await expect(receiptDialog(page).getByLabel('Cheque date')).toHaveCount(0);
  }
  await receiptDialog(page).getByLabel('Payment method').selectOption('cheque');
  await expect(receiptDialog(page).getByLabel('Cheque number')).toBeVisible();
  await expect(receiptDialog(page).getByLabel('Cheque date')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('COL-067 Account select lists bank and cash accounts, not archived ones', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await openReceipt(page);
  const options = await receiptDialog(page).getByLabel('Into account').locator('option').allInnerTexts();
  await page.keyboard.press('Escape');
  expect(options).toEqual(w.bankAccounts.filter(a => !a.archived).map(a => a.name));
  expect(options).not.toContain('Closed MCB account');
  expect(w.bankAccounts.some(a => a.archived)).toBe(true);
  expect(new Set(w.bankAccounts.filter(a => !a.archived).map(a => a.type))).toEqual(new Set(['bank', 'cash']));
});

test('COL-068 Amount field is empty with a placeholder', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await openReceipt(page);
  await receiptDialog(page).getByLabel('Customer').selectOption(w.parties.find(p => p.name === F.metro)!.id);
  const amount = receiptDialog(page).getByLabel('Amount to allocate oldest first');
  await expect(amount).toHaveValue('');
  await expect(amount).toHaveAttribute('placeholder', 'Type the amount, then allocate');
  await page.keyboard.press('Escape');
});

test('COL-070 Cheque register is also visible in Cash & bank with the same data', async () => {
  const { page } = s;
  await collections(page);
  const read = async () => (await chequeCard(page).locator('tbody tr').evaluateAll(trs => trs.map(tr => [tr.querySelector('td strong')?.textContent, tr.children[1].textContent, tr.children[2].textContent, tr.children[3].textContent, tr.querySelector('.badge')?.textContent]))).map(r => r.join('|')).sort();
  const inCollections = await read();
  await openModule(page, 'Cash & bank');
  const inCashBank = await read();
  expect(inCollections.length).toBe(2);
  expect(inCashBank).toEqual(inCollections);
});

test('COL-075 Customer receipts list filters by method/status', async () => {
  const { page } = s;
  await collections(page);
  await expect(receiptsCard(page).getByRole('combobox', { name: /method|status/i }).first()).toBeVisible({ timeout: 3000 });
  const method = (row: string[]) => row[3];
  const read = () => receiptsCard(page).locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent ?? '')));
  const all = await read();
  await receiptsCard(page).getByLabel('Receipt method').selectOption('cheque');
  const cheques = await read();
  expect(cheques.length).toBeGreaterThan(0);
  expect(cheques.length).toBeLessThan(all.length);
  expect(cheques.every(r => method(r).startsWith('CHQ-'))).toBe(true);
  await receiptsCard(page).getByLabel('Receipt status').selectOption('bounced');
  expect((await read()).map(r => r[3])).toEqual(['CHQ-1004']);
  await receiptsCard(page).getByRole('button', { name: 'Clear filters' }).click();
  expect(await read()).toEqual(all);
});

test('COL-076 Search finds a receipt by cheque number', async () => {
  const { page } = s;
  await home(page);
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('dialog', { name: 'Search' });
  await search.getByLabel('Search the workspace').fill('CHQ-1002');
  const count = await search.getByRole('listitem').count();
  await page.keyboard.press('Escape');
  expect(count, 'search results for cheque CHQ-1002').toBeGreaterThan(0);
});

test('COL-085 The bell count matches the attention items (incl. "Cheques due")', async () => {
  const { page } = s;
  await home(page);
  const counts = await page.locator('.attention-row small').allInnerTexts();
  const total = counts.reduce((n, t) => n + Number(t.replace(/\D/g, '')), 0);
  await expect(page.locator('.bell-count')).toHaveText(String(total > 99 ? '99+' : total));
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByRole('menuitem').filter({ hasText: 'Cheques due for deposit or clearing' })).toContainText('2 · Collections');
  await page.keyboard.press('Escape');
});

test('COL-090 The Collections receipt dialog does not offer suppliers (Purchasing → Supplier payments)', async () => {
  const { page } = s;
  await openReceipt(page);
  const options = await receiptDialog(page).getByLabel('Customer').locator('option').allInnerTexts();
  await page.keyboard.press('Escape');
  for (const supplier of [F.supplier, F.localSupplier]) expect(options).not.toContain(supplier);
});

test('COL-093 Status badge colours: received amber, deposited info, cleared green, bounced red', async () => {
  const { page } = s;
  await collections(page);
  const colour = (cheque: string) => receiptsCard(page).locator('tbody tr').filter({ hasText: cheque }).locator('.badge').evaluate(el => [el.textContent, getComputedStyle(el).backgroundColor]);
  expect(await colour('CHQ-1001')).toEqual(['received', 'rgb(255, 244, 220)']);
  expect(await colour('CHQ-1002')).toEqual(['deposited', 'rgb(227, 248, 254)']);
  expect(await colour('CHQ-1003')).toEqual(['cleared', 'rgb(229, 246, 236)']);
  expect(await colour('CHQ-1004')).toEqual(['bounced', 'rgb(254, 233, 231)']);
});

test('COL-094 Receipt row actions show only valid transitions [documented: received → Deposit/Bounced, deposited → Cleared/Bounced; cleared and bounced cheques leave "Cheques in hand" and keep only Print, so a cleared cheque cannot be bounced from the UI]', async () => {
  const { page } = s;
  await collections(page);
  await expect(chequeCard(page).locator('tbody tr').filter({ hasText: 'CHQ-1001' }).getByRole('button')).toHaveText(['Deposit', 'Bounced']);
  await expect(chequeCard(page).locator('tbody tr').filter({ hasText: 'CHQ-1002' }).getByRole('button')).toHaveText(['Cleared', 'Bounced']);
  for (const done of ['CHQ-1003', 'CHQ-1004']) {
    const row = receiptsCard(page).locator('tbody tr').filter({ hasText: done });
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(row.getByRole('link')).toHaveText(['Print']);
  }
});

test('COL-084 5,000 receipts: Collections list and aging render in under 2 s [case-corrected: the receipts table draws the newest 100 with "Show 100 more"; the filters reach the rest]', async () => {
  test.setTimeout(240_000);
  const { page } = s;
  const r = richWorkspace();
  const template = r.w.receipts.find(x => x.id === r.ids.bankRcpt)!;
  for (let i = 0; i < 5000; i++) r.w.receipts.push({ ...structuredClone(template), id: `bulk-rcpt-${i}`, number: `REC-${String(10000 + i)}`, amount: '1.0000', allocations: [] });
  await writeQaWorkspace(r.w);
  await gotoApp(page);
  const total = r.w.receipts.filter(x => r.w.parties.find(p => p.id === x.partyId)?.type !== 'supplier').length;
  let started = Date.now();
  await openModule(page, 'Collections');
  await expect(receiptsCard(page).locator('tbody tr')).toHaveCount(100);
  const list = Date.now() - started;
  await expect(receiptsCard(page).locator('tbody tr').first().locator('td').first()).toHaveText('REC-14999');
  await expect(receiptsCard(page)).toContainText(`Showing 100 of ${total.toLocaleString('en-PK')} receipts`);
  started = Date.now();
  await receiptsCard(page).getByRole('button', { name: 'Show 100 more' }).click();
  await expect(receiptsCard(page).locator('tbody tr')).toHaveCount(200);
  const more = Date.now() - started;
  await receiptsCard(page).getByLabel('Receipt status').selectOption('bounced');
  await expect(receiptsCard(page).locator('tbody tr')).toHaveCount(1);
  started = Date.now();
  await openModule(page, 'Reports');
  await page.getByRole('button', { name: 'Aged receivables' }).click();
  await expect(page.locator('tfoot')).toContainText('Total');
  const aging = Date.now() - started;
  test.info().annotations.push({ type: 'measured', description: `Collections list ${list} ms, next 100 rows ${more} ms, aged receivables ${aging} ms with 5,000+ receipts` });
  expect(Math.max(list, more, aging)).toBeLessThan(2000);
});
