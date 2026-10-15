import { expect, test, type Page } from '@playwright/test';
import { F, PHONE, gotoApp, home, openModule, readWorkspaceApi, richWorkspace, sharedSession, signedInPage, writeQaWorkspace, type Session, keepSignedIn } from './helpers';

let s: Session;
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); });
test.beforeEach(async ({ browser }) => { if (s) await keepSignedIn(browser, s.context, s.page); });
test.afterAll(async () => { await s?.context.close(); });

const editor = (page: Page) => page.getByRole('dialog', { name: 'New sales invoice' });
const confirm = (page: Page) => page.getByRole('dialog', { name: 'Save customer?' });
async function newInvoice(page: Page) {
  await home(page);
  await openModule(page, 'Sales');
  await page.getByRole('button', { name: 'New invoice' }).first().click();
  await expect(editor(page)).toBeVisible();
}
async function closeAll(page: Page) { for (let i = 0; i < 3 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape'); }
const hint = (page: Page) => editor(page).locator('label').filter({ hasText: 'Customer' }).first().locator('.field-hint');

test('PTY-031 Typing an existing name exactly matches it; hint shows city/phone/terms; no prompt', async () => {
  const { page, context } = s;
  const before = (await readWorkspaceApi(context.request)).parties.length;
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill(F.customer);
  await expect(hint(page)).toHaveText('Lahore · +92 300 1111111 · 30-day terms');
  await expect(editor(page).getByText(/New customer\./)).toHaveCount(0);
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  await editor(page).getByLabel('Line 1 quantity').fill('1');
  await editor(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(editor(page)).toHaveCount(0, { timeout: 30_000 });
  expect(await confirm(page).count()).toBe(0);
  expect((await readWorkspaceApi(context.request)).parties.length).toBe(before);
});

test('PTY-032 Typing an existing name in a different case matches it', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill(F.customer.toUpperCase());
  await expect(hint(page)).toHaveText('Lahore · +92 300 1111111 · 30-day terms');
  await expect(editor(page).getByText(/New customer\./)).toHaveCount(0);
  await closeAll(page);
});

test('PTY-033 Typing a new name then Submit opens "Save customer?" with No/Yes', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill('Brand New Buyer');
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  await editor(page).getByLabel('Line 1 quantity').fill('1');
  await editor(page).getByRole('button', { name: 'Submit sales invoice' }).click();
  await expect(confirm(page)).toBeVisible();
  await expect(confirm(page).getByRole('button', { name: 'No, don’t save' })).toBeVisible();
  await expect(confirm(page).getByRole('button', { name: 'Yes, save customer' })).toBeVisible();
  await closeAll(page);
});

test('PTY-041 Changing the name after answering asks again for the new name', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill('Prompt Buyer A');
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  await editor(page).getByLabel('Line 1 quantity').fill('100000');
  await editor(page).getByRole('button', { name: 'Submit sales invoice' }).click();
  await confirm(page).getByRole('button', { name: 'No, don’t save' }).click();
  // Not enough stock: the draft is kept and the editor stays open with the reason.
  await expect(editor(page).getByRole('alert')).toContainText('Saved as a draft but not submitted', { timeout: 30_000 });
  await editor(page).getByLabel('Customer', { exact: true }).fill('Prompt Buyer B');
  await editor(page).getByRole('button', { name: 'Submit sales invoice' }).click();
  await expect(confirm(page)).toBeVisible();
  await expect(confirm(page)).toContainText('Prompt Buyer B');
  await closeAll(page);
});

test('PTY-048 Typed name with extra inner spaces is not matched and prompts', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill('Ali  Traders');
  await expect(editor(page).getByText(/New customer\. You can choose whether to save them/)).toBeVisible();
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  await editor(page).getByLabel('Line 1 quantity').fill('1');
  await editor(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(confirm(page)).toBeVisible();
  await closeAll(page);
});

test('PTY-053 Closing the Save dialog (X) returns to the editor with nothing saved', async () => {
  const { page, context } = s;
  const before = await readWorkspaceApi(context.request);
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill('Closed Dialog Buyer');
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  await editor(page).getByLabel('Line 1 quantity').fill('1');
  await editor(page).getByRole('button', { name: 'Save draft' }).click();
  await confirm(page).getByRole('button', { name: 'Close dialog' }).click();
  await expect(confirm(page)).toHaveCount(0);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByLabel('Customer', { exact: true })).toHaveValue('Closed Dialog Buyer');
  const after = await readWorkspaceApi(context.request);
  expect([after.parties.length, after.documents.length]).toEqual([before.parties.length, before.documents.length]);
  await closeAll(page);
});

test('PTY-054 Dialog copy mentions the typed name and the walk-in account', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill('Copy Check Buyer');
  await editor(page).getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  await editor(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(confirm(page)).toContainText('“Copy Check Buyer” is not in your customer list');
  await expect(confirm(page)).toContainText('Walk-in customer');
  await closeAll(page);
});

test('PTY-056 City and phone fields appear only for new names', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill(F.customer);
  await expect(editor(page).getByLabel('New customer city')).toHaveCount(0);
  await expect(editor(page).getByLabel('New customer phone')).toHaveCount(0);
  await editor(page).getByLabel('Customer', { exact: true }).fill('Someone Brand New');
  await expect(editor(page).getByLabel('New customer city')).toBeVisible();
  await expect(editor(page).getByLabel('New customer phone')).toBeVisible();
  await closeAll(page);
});

test('PTY-074 Customers table phone column scrolls into view at phone width', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true });
  await gotoApp(phone.page);
  await openModule(phone.page, 'Sales');
  await phone.page.getByRole('tab', { name: 'Customers' }).click();
  const card = phone.page.locator('section.card').filter({ has: phone.page.getByRole('heading', { name: 'Customers', level: 2 }) });
  const scroller = card.locator('.table-scroll');
  expect(await scroller.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  const cell = card.locator('tbody tr').filter({ hasText: F.customer }).first().locator('td').nth(2);
  await cell.scrollIntoViewIfNeeded();
  await expect(cell).toHaveText('+92 300 1111111');
  await expect(cell).toBeInViewport();
  await phone.context.close();
});

test('PTY-075 Receipt dialog lists only customers', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await home(page);
  await openModule(page, 'Collections');
  await page.getByRole('button', { name: 'Record receipt' }).first().click();
  const options = await page.getByRole('dialog', { name: 'Record customer receipt' }).getByLabel('Customer').locator('option').allInnerTexts();
  expect(options.slice(1).sort()).toEqual(w.parties.filter(p => p.type === 'customer' && !p.archived).map(p => p.name).sort());
  await closeAll(page);
});

test('PTY-076 Payment dialog lists only suppliers', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await home(page);
  await openModule(page, 'Purchasing');
  await page.getByRole('tab', { name: 'Supplier payments' }).click();
  await page.getByRole('button', { name: 'Record payment' }).click();
  const options = await page.getByRole('dialog', { name: 'Record supplier payment' }).getByLabel('Supplier').locator('option').allInnerTexts();
  expect(options.slice(1).sort()).toEqual(w.parties.filter(p => p.type === 'supplier' && !p.archived).map(p => p.name).sort());
  await closeAll(page);
});

test('PTY-077 Follow-up dialog lists customers only', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await home(page);
  await openModule(page, 'Collections');
  await page.getByRole('button', { name: 'Log follow-up' }).click();
  const options = await page.getByRole('dialog', { name: 'Log recovery follow-up' }).locator('select[name=partyId] option').allInnerTexts();
  expect(options.slice(1).sort()).toEqual(w.parties.filter(p => p.type === 'customer' && !p.archived).map(p => p.name).sort());
  await closeAll(page);
});

test('PTY-088 With "Ali Traders" and "Ali Traders Ltd", typing "Ali Traders" matches the exact one', async () => {
  const { page } = s;
  await newInvoice(page);
  await editor(page).getByLabel('Customer', { exact: true }).fill('Ali Traders');
  await expect(hint(page)).toHaveText('Lahore · +92 300 1111111 · 30-day terms');
  await editor(page).getByLabel('Customer', { exact: true }).fill('Ali Traders Ltd');
  await expect(hint(page)).toHaveText('Karachi · +92 321 2222222 · 45-day terms');
  await closeAll(page);
});

test('PTY-089 Datalist suggestions show city · phone', async () => {
  const { page } = s;
  await newInvoice(page);
  const option = editor(page).locator('datalist option[value="Ali Traders"]');
  await expect(option).toHaveText('Lahore · +92 300 1111111');
  await expect(editor(page).locator('datalist option[value="Ali Traders Ltd"]')).toHaveText('Karachi · +92 321 2222222');
  expect(await editor(page).getByLabel('Customer', { exact: true }).getAttribute('list')).toBe(await editor(page).locator('datalist').getAttribute('id'));
  await closeAll(page);
});

test('PTY-090 [manual] Suggestions on iOS Safari: datalist works or free text still saves', async () => {
  test.skip(true, 'Needs iOS Safari on real hardware; Chromium only in this run.');
});

test('PTY-098 10,000 customers: the suggestion datalist stays usable (capped at 50, filtered by the typed text)', async () => {
  test.setTimeout(240_000);
  const { page } = s;
  const r = richWorkspace();
  for (let i = 0; i < 10_000; i++) r.w.parties.push({ id: `bulk-c-${i}`, name: `Bulk Customer ${String(i).padStart(5, '0')}`, type: 'customer', city: 'Karachi', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Retailer', phone: `+92 300 ${String(i).padStart(7, '0')}` });
  await writeQaWorkspace(r.w);
  await gotoApp(page);
  await newInvoice(page);
  await expect(editor(page).locator('datalist option')).toHaveCount(50);
  const input = editor(page).getByLabel('Customer', { exact: true });
  await input.click();
  const started = Date.now();
  await page.keyboard.type('Bulk Customer 09876');
  const perKey = (Date.now() - started) / 'Bulk Customer 09876'.length;
  await expect(hint(page)).toHaveText('Karachi · +92 300 0009876 · 30-day terms');
  await expect(editor(page).locator('datalist option')).toHaveCount(1);
  await expect(editor(page).locator('datalist option[value="Bulk Customer 09876"]')).toHaveCount(1);
  test.info().annotations.push({ type: 'measured', description: `${Math.round(perKey)} ms per keystroke with 10,004 customers` });
  await closeAll(page);
  expect(perKey).toBeLessThan(150);
});
