import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { F, home, navItem, openModule, readWorkspaceApi, sharedSession, type Session, AUTH_FILE, QA_TENANT, authState, gotoApp } from './helpers';

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

async function commissions(page: Page, tab?: string) {
  await home(page);
  await openModule(page, 'Commissions');
  if (tab) await page.getByRole('tab', { name: tab }).click();
}
const entitlements = (page: Page) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Commission entitlements' }) });
const entitlementRows = (page: Page) => entitlements(page).locator('tbody tr');

test('COM-081 Entitlement badges use distinct colours per state [case-corrected: states read unreleased / pending (released, awaiting approval) / approved / recoverable]', async () => {
  const { page } = s;
  await commissions(page);
  const badges = await entitlementRows(page).evaluateAll(rows => rows.map(r => { const b = r.querySelectorAll('td')[5]?.querySelector('.badge'); if (!b) return null; const cs = getComputedStyle(b); return { text: b.textContent, bg: cs.backgroundColor, fg: cs.color }; }).filter(Boolean) as { text: string; bg: string; fg: string }[]);
  const byState = Object.fromEntries(badges.map(b => [b.text, `${b.bg} / ${b.fg}`]));
  test.info().annotations.push({ type: 'actual', description: JSON.stringify(byState) });
  expect(Object.keys(byState).sort()).toEqual(['approved', 'pending', 'unreleased']);
  // Earned-but-unreleased, released-awaiting-approval and approved must not share a colour.
  expect(new Set(Object.values(byState)).size).toBe(3);
  // Each state renders the same way on every row.
  for (const b of badges) expect(`${b.bg} / ${b.fg}`).toBe(byState[b.text]);
});

test('COM-084 Plan form fields are consistent across plan types [documented: every type shows all fields — category, class, tier rates, target and multiplier]', async () => {
  const { page } = s;
  await commissions(page, 'Plans');
  await page.getByRole('button', { name: 'New commission plan' }).click();
  const form = page.getByRole('dialog');
  await expect(form).toBeVisible();
  const labels = () => form.locator('label').evaluateAll(ls => ls.filter(l => (l as HTMLElement).offsetParent !== null).map(l => (l.querySelector('.record-label')?.textContent ?? l.textContent ?? '').replace('*', '').trim()));
  const type = form.getByLabel('Plan type');
  const seen: Record<string, string[]> = {};
  for (const value of ['flat', 'category', 'customer_class', 'per_unit', 'tiered']) {
    await type.selectOption(value);
    seen[value] = await labels();
  }
  await page.keyboard.press('Escape');
  const all = ['Plan name', 'Effective from', 'Effective to', 'Plan type', 'Default rate', 'Category rates', 'Customer-class rates', 'Tiers', 'Monthly target (PKR)', 'Multiplier above target'];
  for (const [value, fields] of Object.entries(seen)) expect(fields, value).toEqual(all);
  // Editing an existing plan shows the same fields.
  await page.locator('section.card tbody tr').filter({ hasText: 'Standard 2%' }).getByRole('button', { name: /Edit/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.getByRole('dialog').locator('label').evaluateAll(ls => ls.filter(l => (l as HTMLElement).offsetParent !== null).map(l => (l.querySelector('.record-label')?.textContent ?? l.textContent ?? '').replace('*', '').trim()))).toEqual(all);
  await page.keyboard.press('Escape');
});

test('COM-085 Owner "View as" Salesperson filters entitlements', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const name = (id: string) => w.employees.find(e => e.id === id)!.name;
  // The preview stands in for the first salesperson on a document line.
  const previewed = w.documents.flatMap(d => d.lines.map(l => l.employeeId)).find(Boolean)!;
  const mine = w.commissions.filter(c => c.employeeId === previewed);
  expect(name(previewed)).toBe(F.salesperson);
  expect(w.commissions.some(c => c.employeeId !== previewed)).toBe(true);
  await commissions(page);
  await expect(entitlementRows(page)).toHaveCount(w.commissions.length);
  await expect(entitlements(page)).toContainText('Sara Malik');
  await openModule(page, 'Settings');
  await page.getByRole('tab', { name: 'Access' }).click();
  await page.getByLabel('View as role').selectOption('Salesperson');
  await expect(page.getByText('Previewing as Salesperson')).toBeVisible();
  try {
    await openModule(page, 'Commissions');
    await expect(entitlementRows(page)).toHaveCount(mine.length);
    expect(new Set(await entitlementRows(page).locator('td:first-child').allInnerTexts())).toEqual(new Set([F.salesperson]));
    await expect(entitlements(page)).not.toContainText('Sara Malik');
    const invoices = (await entitlementRows(page).locator('td:nth-child(2)').allInnerTexts()).sort();
    expect(invoices).toEqual(mine.map(c => w.documents.find(d => d.id === c.invoiceId)!.number).sort());
    // Preview is read-only for approvals (Salesperson cannot approve).
    await expect(entitlements(page).getByRole('button', { name: 'Approve' })).toHaveCount(0);
  } finally {
    await page.getByRole('button', { name: 'Exit preview' }).click();
    await expect(page.getByText('Previewing as')).toHaveCount(0);
  }
});

test('COM-089 LIVE label shows on Commissions in the sidebar', async () => {
  const { page } = s;
  await home(page);
  const item = navItem(page, 'Commissions');
  await expect(item.locator('.new-label')).toHaveText('LIVE');
  await expect(item.locator('.new-label')).toBeVisible();
  await expect(page.locator('button.nav-item .new-label')).toHaveCount(1);
  const st = await item.locator('.new-label').evaluate(el => ({ fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundImage }));
  expect(st.bg).toContain('gradient');
  expect(st.fg).toBe('rgb(255, 255, 255)');
});
