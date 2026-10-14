import { expect, test, type Page } from '@playwright/test';
import { APP, PASSWORD, PHONE, QA_TENANT, gotoApp, home, openModule, post, readWorkspaceApi, richWorkspace, setupWorkspace, sharedSession, signedInPage, writeQaWorkspace, type Session, keepSignedIn } from './helpers';

let s: Session;
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); });
test.beforeEach(async ({ browser }) => { if (s) await keepSignedIn(browser, s.context, s.page); });
test.afterAll(async () => { await s?.context.close(); });

async function settings(page: Page, tab: 'Company & documents' | 'Features' | 'Access' | 'Audit history') {
  await home(page);
  await openModule(page, 'Settings');
  await page.getByRole('tab', { name: tab }).click();
}
const hideDialog = (page: Page) => page.getByRole('dialog', { name: /^Hide / });

test('SET-012 Edit, then switch tab without saving: change dropped, nothing partially saved', async () => {
  const { page, context } = s;
  await settings(page, 'Company & documents');
  const phone = page.getByLabel('Phone');
  const before = await phone.inputValue();
  await phone.fill('+92 999 0000000');
  await page.getByRole('tab', { name: 'Features' }).click();
  await page.getByRole('tab', { name: 'Company & documents' }).click();
  await expect(page.getByLabel('Phone')).toHaveValue(before);
  expect((await readWorkspaceApi(context.request)).company.phone).toBe(before);
});

test('SET-027 Cancel on the hide dialog leaves the switch on', async () => {
  const { page } = s;
  await settings(page, 'Features');
  await page.getByRole('switch', { name: 'Commissions module' }).click();
  await expect(hideDialog(page)).toBeVisible();
  await hideDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(hideDialog(page)).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Commissions module' })).toBeChecked();
});

test('SET-028 Escape closes the hide dialog with no change', async () => {
  const { page, context } = s;
  await settings(page, 'Features');
  await page.getByRole('switch', { name: 'Payroll module' }).click();
  await expect(hideDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hideDialog(page)).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Payroll module' })).toBeChecked();
  expect((await readWorkspaceApi(context.request)).modules).toContain('payroll');
});

test('SET-033 Records of a hidden module do not appear in search', async () => {
  const { page, context } = s;
  const all = (await readWorkspaceApi(context.request)).modules;
  const hidden = await post(context.request, 'set_modules', { enabled: all.filter(m => m !== 'purchasing' && m !== 'imports') }, { confirmPassword: PASSWORD });
  expect(hidden.status).toBe(200);
  try {
    await gotoApp(page);
    await page.keyboard.press('ControlOrMeta+k');
    const search = page.getByRole('dialog', { name: 'Search' });
    await search.getByLabel('Search the workspace').fill('Ningbo');
    await expect(search.getByText(/No matches for/)).toBeVisible();
    await search.getByLabel('Search the workspace').fill('PO-2026');
    await expect(search.getByText(/No matches for/)).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await post(context.request, 'set_modules', { enabled: all });
    await gotoApp(page);
  }
});

test('SET-040 Settings tiles use the same colours as the sidebar', async () => {
  const { page } = s;
  await settings(page, 'Features');
  for (const key of ['sales', 'purchasing', 'inventory', 'imports', 'collections', 'cashbank', 'commissions', 'payroll', 'reports']) {
    const tile = await page.locator(`.module-card[data-module="${key}"] .module-tile`).evaluate(el => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
    const nav = await page.locator(`button.nav-item[data-module="${key}"] .nav-icon`).evaluate(el => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
    expect(tile, key).toEqual(nav);
  }
});

test('SET-041 Hide dialog backdrop is blurred and tinted', async () => {
  const { page } = s;
  await settings(page, 'Features');
  await page.getByRole('switch', { name: 'Commissions module' }).click();
  await expect(hideDialog(page)).toBeVisible();
  const overlay = await page.locator('.dialog-overlay').evaluate(el => ({ filter: getComputedStyle(el).backdropFilter, bg: getComputedStyle(el).backgroundColor }));
  await page.keyboard.press('Escape');
  expect(overlay.filter).toContain('blur(8px)');
  expect(overlay.bg).toBe('rgba(16, 31, 82, 0.38)');
});

test('SET-042 Hide dialog on phone is a bottom sheet with a 16px password input', async ({ browser }) => {
  const phone = await signedInPage(browser, { viewport: PHONE, hasTouch: true });
  await gotoApp(phone.page);
  await openModule(phone.page, 'Settings');
  await phone.page.getByRole('tab', { name: 'Features' }).click();
  await phone.page.getByRole('switch', { name: 'Commissions module' }).click();
  const dialog = hideDialog(phone.page);
  await expect(dialog).toBeVisible();
  await phone.page.waitForTimeout(500);
  const box = (await dialog.boundingBox())!;
  const vp = await phone.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const font = await dialog.locator('input[type=password]').evaluate(el => getComputedStyle(el).fontSize);
  await phone.context.close();
  expect(Math.round(box.width)).toBe(vp.w);
  expect(Math.abs(box.y + box.height - vp.h)).toBeLessThan(2);
  expect(font).toBe('16px');
});

test('SET-043 Access tab shows company name, tax id and revision', async () => {
  const { page, context } = s;
  await settings(page, 'Access');
  const w = await readWorkspaceApi(context.request);
  const grid = page.locator('.settings-grid');
  await expect(grid).toContainText('QA Trading Company');
  await expect(grid).toContainText('1234567-8');
  await expect(grid.locator('div').filter({ hasText: 'Revision' }).locator('strong')).toHaveText(String(w.revision));
});

test('SET-045 View as Salesperson: reduced sidebar, "Previewing as Salesperson" chip, Exit preview', async () => {
  const { page } = s;
  await settings(page, 'Access');
  await page.getByLabel('View as role').selectOption('Salesperson');
  await expect(page.getByText('Previewing as Salesperson')).toBeVisible();
  await expect(page.locator('button.nav-item')).toHaveText(['Overview', 'Sales', 'Collections', 'CommissionsLIVE']);
  await page.getByRole('button', { name: 'Exit preview' }).click();
  await expect(page.getByText('Previewing as')).toHaveCount(0);
  await expect(page.locator('button.nav-item')).toHaveCount(12);
});

test('SET-060 Active tab has a violet underline', async () => {
  const { page } = s;
  await settings(page, 'Features');
  const st = await page.getByRole('tab', { name: 'Features' }).evaluate(el => ({ color: getComputedStyle(el).borderBottomColor, width: getComputedStyle(el).borderBottomWidth }));
  expect(st).toEqual({ color: 'rgb(107, 61, 245)', width: '2px' });
  const other = await page.getByRole('tab', { name: 'Access' }).evaluate(el => getComputedStyle(el).borderBottomColor);
  expect(other).not.toBe('rgb(107, 61, 245)');
});

test('SET-069 Branding preview typography and colours match the print page [defect]', async () => {
  const { page, context } = s;
  await settings(page, 'Company & documents');
  const read = (p: Page, root: string) => p.evaluate(r => {
    const q = (sel: string) => document.querySelector(`${r} ${sel}`)!;
    const cs = (sel: string) => getComputedStyle(q(sel));
    return { family: cs('.doc-company').fontFamily, company: cs('.doc-company').color, head: cs('.doc-lines th').backgroundColor, headText: cs('.doc-lines th').color, title: cs('.doc-title-meta td').color, border: cs('.doc-header').borderBottomColor };
  }, root);
  const preview = await read(page, '.branding-preview');
  const invoice = (await readWorkspaceApi(context.request)).documents.find(d => d.kind === 'sales_invoice' && d.status === 'submitted')!;
  const print = await context.newPage();
  await print.goto(`/print/sales_invoice/${invoice.id}?tenant=${QA_TENANT}`);
  await expect(print.locator('.doc')).toBeVisible({ timeout: 30_000 });
  const printed = await read(print, '.print-page');
  await print.close();
  expect(preview).toEqual(printed);
});

test('SET-075 Settings → Features shows an "N turned on" count matching the switches [defect]', async () => {
  const { page } = s;
  await settings(page, 'Features');
  const on = await page.locator('.module-card input[role=switch]:checked').count();
  await expect(page.locator('main')).toContainText(`${on} turned on`, { timeout: 3000 });
});

test('SET-076 Long module descriptions wrap inside tiles', async () => {
  const { page } = s;
  await settings(page, 'Features');
  const rows = await page.locator('.module-card p').evaluateAll(ps => ps.map(p => ({ ws: getComputedStyle(p).whiteSpace, overflow: p.scrollWidth > p.clientWidth + 1, lines: Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight)) })));
  for (const r of rows) { expect(r.ws).toBe('normal'); expect(r.overflow).toBe(false); }
  expect(Math.max(...rows.map(r => r.lines))).toBeGreaterThan(1);
});

test('SET-079 Hiding the module whose view is open returns to Overview, no blank page [documented: an open tab moves to Overview on its next successful command]', async () => {
  const { page, context } = s;
  await home(page);
  await openModule(page, 'Commissions');
  await page.getByRole('tab', { name: 'Salespeople' }).click();
  const all = (await readWorkspaceApi(context.request)).modules;
  expect((await post(context.request, 'set_modules', { enabled: all.filter(m => m !== 'commissions') }, { confirmPassword: PASSWORD })).status).toBe(200);
  try {
    await page.getByRole('button', { name: 'Edit Hamza Khan' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await expect(page.locator('button.nav-item').filter({ hasText: 'Commissions' })).toHaveCount(0);
    await expect(page.locator('.metric-grid')).toBeVisible();
  } finally {
    await post(context.request, 'set_modules', { enabled: all });
    await gotoApp(page);
  }
});

test('SET-090 Error notice from a failed save is red', async () => {
  const { page } = s;
  await settings(page, 'Company & documents');
  await page.getByLabel('Company name').fill('A');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const note = page.locator('.main-content > .error-note');
  await expect(note).toBeVisible({ timeout: 30_000 });
  const st = await note.evaluate(el => ({ color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor, role: el.getAttribute('role') }));
  expect(st).toEqual({ color: 'rgb(217, 45, 32)', bg: 'rgb(254, 233, 231)', role: 'alert' });
  await gotoApp(page);
});

test('SET-091 Success notice is neutral (not red)', async () => {
  const { page } = s;
  await settings(page, 'Company & documents');
  await page.getByLabel('Phone').fill('+92 300 7777777');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const note = page.getByText('Company details and document branding saved.');
  await expect(note).toBeVisible({ timeout: 30_000 });
  const st = await note.evaluate(el => ({ cls: el.className, color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
  expect(st.cls).toContain('form-note');
  expect(st.bg).not.toBe('rgb(254, 233, 231)');
  expect(st.color).not.toBe('rgb(217, 45, 32)');
});

test('SET-092 Notice clears when the next command starts', async () => {
  const { page } = s;
  await settings(page, 'Company & documents');
  await page.getByLabel('Phone').fill('+92 300 8888888');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.main-content > .form-note')).toBeVisible({ timeout: 30_000 });
  await page.route('**/api/workspace', async route => { if (route.request().method() === 'POST') await new Promise(r => setTimeout(r, 2000)); await route.continue().catch(() => undefined); });
  await page.getByLabel('Phone').fill('+92 300 9999999');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForTimeout(400);
  await expect(page.locator('.main-content > .form-note, .main-content > .error-note')).toHaveCount(0);
  await expect(page.getByText('Company details and document branding saved.')).toHaveCount(0);
  await expect(page.getByText('Company details and document branding saved.')).toBeVisible({ timeout: 30_000 });
});

test('SET-044 "View as role" is enabled only for the Owner of a demo company', async () => {
  const { page } = s;
  await settings(page, 'Access');
  await expect(page.getByLabel('View as role')).toBeEnabled();
  await writeQaWorkspace(richWorkspace({ demo: false }).w);
  await gotoApp(page);
  await settings(page, 'Access');
  await expect(page.getByLabel('View as role')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reset demo' })).toHaveCount(0);
});

test('SET-080 Settings is not reachable while the company is still in setup', async () => {
  const { page } = s;
  await writeQaWorkspace(setupWorkspace(1));
  await page.goto(APP);
  await expect(page.locator('.setup-card')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
  await page.locator('button.nav-item').filter({ hasText: 'Settings' }).click({ force: true, timeout: 3000 }).catch(() => undefined);
  await expect(page.getByRole('tab', { name: 'Features' })).toHaveCount(0);
  await expect(page.locator('#setup-title')).toHaveText('Company');
});
