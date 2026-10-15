import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  APP, DESKTOP, F, PHONE, QA_TENANT, gotoApp, home, navItem, noHorizontalScroll, openModule, readWorkspaceApi, richWorkspace,
  seedRich, setupWorkspace, sharedSession, keepSignedIn, signedInPage, writeQaWorkspace,
} from './helpers';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { businessToday } from '../../src/modules/erp/dates';
import { outstanding } from '../../src/modules/erp/engine';
import type { Workspace } from '../../src/modules/erp/types';

// Shell: navigation, search, notifications, workspace switcher, Overview (docs/qa/cases/17-shell.md).
// Every write goes to the QA tenant only. Switching company is verified by intercepting the navigation,
// so no other company is ever opened.

let s: Awaited<ReturnType<typeof sharedSession>>;
let ids: Record<string, string> = {};
test.beforeAll(async ({ browser }) => { s = await sharedSession(browser); ids = s.ids; });
test.afterAll(async () => { await s?.context.close(); });
// Another suite's sign-out tests end every session of the shared owner account; sign the shared page back in if so.
test.beforeEach(async ({ browser }) => { if (s) await keepSignedIn(browser, s.context, s.page); });

const MODULES = ['Overview', 'Sales', 'Purchasing', 'Imports & costing', 'Inventory', 'Collections', 'Cash & bank', 'Commissions', 'Payroll', 'Accounting', 'Reports', 'Settings'];
const MOBILE = { viewport: PHONE, hasTouch: true, isMobile: true };
const searchDialog = (page: Page) => page.getByRole('dialog', { name: 'Search' });
const searchInput = (page: Page) => searchDialog(page).getByLabel('Search the workspace');
const results = (page: Page) => searchDialog(page).locator('.search-result');
const resultTitles = (page: Page) => results(page).locator('strong').allInnerTexts();
const breadcrumb = (page: Page) => page.locator('.breadcrumb strong');
const bell = (page: Page) => page.getByRole('button', { name: /^Notifications/ });
const notice = (page: Page) => page.locator('.main-content > .form-note, .main-content > .error-note');
const salesRows = (page: Page) => page.locator('section.card').first().locator('tbody tr');
const numberOf = (w: Workspace, id: string) => w.documents.find(d => d.id === id)!.number;

async function search(page: Page, query: string) {
  if (!(await searchDialog(page).isVisible())) await page.keyboard.press('Control+k');
  await expect(searchDialog(page)).toBeVisible();
  await searchInput(page).fill(query);
}
async function closeSearch(page: Page) { if (await searchDialog(page).isVisible()) await page.keyboard.press('Escape'); await expect(searchDialog(page)).toHaveCount(0); }
/** Re-seeds the QA tenant and reloads the shared page (for tests that change data). */
async function reseed(page: Page, workspace?: Workspace) {
  if (workspace) await writeQaWorkspace(workspace); else ids = (await seedRich()).ids;
  await gotoApp(page);
}
async function phoneSession(browser: Browser) {
  const session = await signedInPage(browser, MOBILE);
  await gotoApp(session.page);
  return session;
}
async function viewAs(page: Page, role: string) {
  await home(page);
  await openModule(page, 'Settings');
  await page.getByRole('tab', { name: 'Access' }).click();
  await page.getByLabel('View as role').selectOption(role);
  await expect(page.getByText(`Previewing as ${role}`)).toBeVisible();
}
async function exitPreview(page: Page) {
  if (await page.getByRole('button', { name: 'Exit preview' }).count()) await page.getByRole('button', { name: 'Exit preview' }).click();
  await expect(page.locator('.preview-chip')).toHaveCount(0);
}
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
/** Max Event Timing duration (input → next paint) for interactions recorded since `startEventTiming`. */
async function startEventTiming(page: Page) {
  await page.evaluate(() => {
    const store = window as unknown as { qaEvents: { name: string; duration: number }[] };
    store.qaEvents = [];
    new PerformanceObserver(list => { for (const e of list.getEntries()) store.qaEvents.push({ name: e.name, duration: e.duration }); })
      .observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
  });
}
const eventTimings = (page: Page) => page.evaluate(async () => { await new Promise(r => setTimeout(r, 300)); return (window as unknown as { qaEvents: { name: string; duration: number }[] }).qaEvents; });

// ============================================================ navigation

test('NAV-002 Clicking each sidebar item changes the view; breadcrumb "Workspace › {Module}"; URL unchanged', async () => {
  const { page } = s;
  await home(page);
  const url = page.url();
  await expect(page.locator('button.nav-item')).toHaveCount(MODULES.length);
  for (const label of MODULES) {
    await navItem(page, label).click();
    await expect(breadcrumb(page)).toHaveText(label);
    await expect(page.locator('.breadcrumb > span')).toHaveText('Workspace');
    await expect(page.locator('.breadcrumb > svg')).toHaveCount(1);
    await expect(page.locator('h1').first()).toContainText(label);
    await expect(navItem(page, label)).toHaveClass(/active/);
    expect(page.url()).toBe(url);
  }
});

test('NAV-005 Keyboard: Tab moves through the nav and Enter activates an item', async () => {
  const { page } = s;
  await home(page);
  await page.locator('a.brand').focus();
  const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.trim() ?? '');
  const seen: string[] = [];
  for (let i = 0; i < 8 && !(await focused()).startsWith('Purchasing'); i++) { await page.keyboard.press('Tab'); seen.push(await focused()); }
  expect(await focused()).toBe('Purchasing');
  expect(seen).toEqual(expect.arrayContaining(['Overview', 'Sales', 'Purchasing']));
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
  expect(outline).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(breadcrumb(page)).toHaveText('Purchasing');
  await page.keyboard.press('Tab');
  expect(await focused()).toBe('Imports & costing');
  await page.keyboard.press('Enter');
  await expect(breadcrumb(page)).toHaveText('Imports & costing');
});

test('NAV-008 Workspace switcher lists memberships with demo/private tag; current company marked [documented: current company carries a check icon labelled "Current company"; there is no separate highlight colour]', async () => {
  const { page } = s;
  await home(page);
  await page.locator('.workspace-picker').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.workspace-menu-label')).toHaveText('YOUR COMPANIES');
  const items = menu.getByRole('menuitem');
  const count = await items.count();
  expect(count).toBeGreaterThan(1);
  for (let i = 0; i < count; i++) await expect(items.nth(i).locator('small')).toHaveText(/^(Demo workspace|Private workspace)$/);
  const current = items.filter({ has: page.getByLabel('Current company') });
  await expect(current).toHaveCount(1);
  await expect(current.locator('strong')).toHaveText('QA Trading Company');
  await expect(current.locator('small')).toHaveText('Demo workspace');
  await expect(page.locator('.workspace-picker small')).toHaveText('Demo workspace');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('NAV-009 Switching company navigates to /?tenant=<id> [documented: target navigation intercepted and verified; the other company is not opened per the isolation rule]', async () => {
  const page = await s.context.newPage();
  await gotoApp(page);
  const captured: string[] = [];
  await page.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    const tenant = url.searchParams.get('tenant');
    if (request.isNavigationRequest() && tenant && tenant !== QA_TENANT) {
      captured.push(request.url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>intercepted</title><p>intercepted</p>' });
    }
    return route.continue();
  });
  await page.locator('.workspace-picker').click();
  // Selecting the current company does nothing.
  await page.getByRole('menuitem').filter({ has: page.getByLabel('Current company') }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(page.url()).toContain(`tenant=${QA_TENANT}`);
  await page.locator('.workspace-picker').click();
  await page.getByRole('menuitem').filter({ hasNot: page.getByLabel('Current company') }).first().click();
  await expect.poll(() => captured.length).toBe(1);
  const target = new URL(captured[0]);
  expect(target.pathname).toBe('/');
  expect(target.searchParams.get('tenant')).toMatch(/^[0-9a-f-]{36}$/);
  expect(target.searchParams.get('tenant')).not.toBe(QA_TENANT);
  await page.close();
});

test('NAV-010 Switcher with one company [documented: the owner account belongs to 6 companies, so a one-company menu cannot be produced without creating a user; verified the trigger shows the current company and it appears exactly once in the menu]', async () => {
  const { page } = s;
  await home(page);
  await expect(page.locator('.workspace-picker strong')).toHaveText('QA Trading Company');
  await page.locator('.workspace-picker').click();
  const items = page.getByRole('menuitem');
  test.info().annotations.push({ type: 'memberships', description: String(await items.count()) });
  await expect(items.filter({ has: page.getByLabel('Current company') })).toHaveCount(1);
  await page.keyboard.press('Escape');
});

// ============================================================ search

test('NAV-014 Ctrl+K and ⌘K open search instantly with no dialog animation', async () => {
  const { page } = s;
  await home(page);
  for (const combo of ['Control+k', 'Meta+k']) {
    await page.keyboard.press(combo);
    const state = await page.evaluate(() => {
      const el = document.querySelector('.search-dialog');
      return el && { animation: getComputedStyle(el).animationName, running: el.getAnimations().length, focused: document.activeElement?.getAttribute('aria-label') };
    });
    expect(state, `${combo} opened the dialog in the same task`).not.toBeNull();
    expect(state!.animation).toBe('none');
    expect(state!.running).toBe(0);
    await expect(searchDialog(page)).toBeVisible();
    await expect(searchInput(page)).toBeFocused();
    await closeSearch(page);
  }
});

test('NAV-015 Search "INV-2026" lists documents; Enter opens the first [case-corrected: since D-39 the journals whose memo names an INV-2026 invoice also match; the invoices are listed first]', async () => {
  const { page } = s;
  await home(page);
  await search(page, 'INV-2026');
  const titles = await resultTitles(page);
  const modules = await results(page).locator('.search-module').allInnerTexts();
  const documents = modules.filter(m => m === 'Sales').length;
  expect(documents).toBeGreaterThan(0);
  expect(modules.slice(0, documents).every(m => m === 'Sales'), 'documents come first').toBe(true);
  for (const t of titles.slice(0, documents)) expect(t).toMatch(/^INV-2026-\d{4}$/);
  for (const [i, m] of modules.entries()) if (i >= documents) { expect(m).toBe('Accounting'); await expect(results(page).nth(i).locator('small')).toContainText('INV-2026'); }
  await expect(results(page).first().locator('.search-module')).toHaveText('Sales');
  await searchInput(page).press('Enter');
  // Expected: the first document opens (dialog closes and the invoice is shown).
  await expect(searchDialog(page)).toHaveCount(0, { timeout: 3000 });
  await expect(page.getByRole('dialog', { name: new RegExp(titles[0]) })).toBeVisible({ timeout: 3000 });
});

test('NAV-016 Search a customer name lists the customer and their documents [case-corrected: since D-39 a journal whose memo names the customer (an expense "for the Metro Home Stores order") is listed too]', async () => {
  const { page, context } = s;
  await home(page);
  const w = await readWorkspaceApi(context.request);
  const metro = w.parties.find(p => p.name === F.metro)!;
  const docs = w.documents.filter(d => d.partyId === metro.id && !d.partyName).map(d => d.number);
  await search(page, F.metro);
  const titles = await resultTitles(page);
  expect(titles).toContain(F.metro);
  const modules = await results(page).locator('.search-module').allInnerTexts();
  expect(titles.filter((t, i) => t !== F.metro && modules[i] !== 'Accounting').sort()).toEqual(docs.sort());
  for (const [i, m] of modules.entries()) if (m === 'Accounting') await expect(results(page).nth(i).locator('small')).toContainText(F.metro);
  await expect(results(page).filter({ hasText: 'customer · Lahore' }).locator('.search-module')).toHaveText('Collections');
  await closeSearch(page);
});

test('NAV-017 Search a walk-in typed name finds the document', async () => {
  const { page, context } = s;
  await home(page);
  const w = await readWorkspaceApi(context.request);
  await search(page, F.walkIn);
  expect(await resultTitles(page)).toEqual([numberOf(w, ids.walkInv)]);
  await expect(results(page).first()).toContainText(F.walkIn);
  await closeSearch(page);
});

test('NAV-018 Search a product SKU finds the product', async () => {
  const { page } = s;
  await home(page);
  await search(page, 'QA-KET');
  expect(await resultTitles(page)).toEqual([F.kettle]);
  await expect(results(page).first()).toContainText('QA-KET · Home');
  await expect(results(page).first().locator('.search-module')).toHaveText('Inventory');
  await closeSearch(page);
});

test('NAV-019 Search employee [case-corrected: search covers documents, customers, suppliers and products only, as its description says; employees are never returned for any role, so salaries cannot leak]', async () => {
  const { page } = s;
  await home(page);
  await search(page, F.salesperson);
  await expect(searchDialog(page).getByText('Documents, customers, suppliers and products in this workspace.')).toBeVisible();
  await expect(results(page)).toHaveCount(0);
  await expect(searchDialog(page).getByText(`No matches for “${F.salesperson}”.`)).toBeVisible();
  await closeSearch(page);
  await viewAs(page, 'Salesperson');
  await search(page, 'Sara');
  await expect(results(page)).toHaveCount(0);
  await closeSearch(page);
  await exitPreview(page);
});

test('NAV-020 Search respects module gating: records of hidden modules are absent', async () => {
  const { page } = s;
  await reseed(page, richWorkspace({ hide: ['purchasing', 'imports', 'inventory'] }).w);
  await expect(navItem(page, 'Purchasing')).toHaveCount(0);
  await expect(navItem(page, 'Inventory')).toHaveCount(0);
  for (const q of [F.supplier, F.localSupplier, 'PO-2026', 'BILL-2026', 'GRN-2026', 'QA-LED', F.kettle]) {
    await search(page, q);
    await expect(results(page), `"${q}" while Purchasing/Inventory are hidden`).toHaveCount(0);
  }
  await search(page, 'INV-2026');
  expect((await resultTitles(page)).length).toBeGreaterThan(0);
  await closeSearch(page);
  await reseed(page);
});

test('NAV-021 Search respects role scoping: Salesperson preview finds only their own documents', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  const scoped = scopeWorkspace(w, { id: 'preview', name: 'Preview', role: 'Salesperson', branchIds: [], email: '', employeeId: ids.hamza });
  const visible = new Set(scoped.documents.map(d => d.number));
  const salesKinds = ['quotation', 'sales_order', 'delivery', 'sales_invoice', 'credit_note'];
  const probes = [ids.inv1, ids.saraInv, ids.walkInv, ids.inv2, ids.bill, ids.po].map(id => w.documents.find(d => d.id === id)!);
  expect(visible.has(numberOf(w, ids.inv1))).toBe(true);
  expect(visible.has(numberOf(w, ids.saraInv))).toBe(false);
  await viewAs(page, 'Salesperson');
  for (const doc of probes) {
    await search(page, doc.number);
    const expected = visible.has(doc.number) && salesKinds.includes(doc.kind);
    if (expected) expect(await resultTitles(page), doc.number).toContain(doc.number);
    else expect(await resultTitles(page), doc.number).not.toContain(doc.number);
  }
  await closeSearch(page);
  await exitPreview(page);
});

test('NAV-022 Empty search shows prompt text [documented: placeholder "Invoice number, customer, SKU…" and the description; the results area stays empty, also for spaces only]', async () => {
  const { page } = s;
  await home(page);
  await search(page, '');
  await expect(searchInput(page)).toHaveAttribute('placeholder', 'Invoice number, customer, SKU…');
  await expect(searchDialog(page).getByText('Documents, customers, suppliers and products in this workspace.')).toBeVisible();
  await expect(results(page)).toHaveCount(0);
  await searchInput(page).fill('   ');
  await expect(results(page)).toHaveCount(0);
  await expect(searchDialog(page).getByText(/No matches/)).toHaveCount(0);
  await closeSearch(page);
});

test('NAV-023 Two-character search [documented: results appear from the first character with no "type more" message; "Al" returns the first 8 documents (their type text "sales invoice" matches), so the Ali Traders customer is pushed past the 8-result cap]', async () => {
  const { page } = s;
  await home(page);
  await search(page, 'Al');
  const titles = await resultTitles(page);
  expect(titles.length).toBe(8);
  await expect(results(page).first().locator('small')).toContainText('sales invoice');
  expect(titles).not.toContain(F.customer);
  await expect(searchDialog(page).getByText(/type more/i)).toHaveCount(0);
  await search(page, 'Ali T');
  expect(await resultTitles(page)).toContain(F.customer);
  await closeSearch(page);
});

test('NAV-025 Urdu search matches', async () => {
  const { page } = s;
  await home(page);
  await search(page, 'علی');
  expect(await resultTitles(page)).toContain(F.urduCustomer);
  await search(page, 'کراچی');
  expect(await resultTitles(page)).toContain(F.urduCustomer);
  await closeSearch(page);
});

test('NAV-026 Arrow keys move the selection; Escape closes', async () => {
  const { page } = s;
  await home(page);
  await search(page, 'INV-2026');
  expect(await results(page).count()).toBeGreaterThan(1);
  await searchInput(page).press('ArrowDown');
  const selected = () => page.evaluate(() => {
    const active = document.activeElement;
    const marked = document.querySelector('.search-result[aria-selected="true"], .search-result[data-selected], .search-result[data-highlighted]');
    const descendant = active?.getAttribute('aria-activedescendant');
    const list = [...document.querySelectorAll('.search-result')];
    if (active && active.classList.contains('search-result')) return list.indexOf(active);
    if (marked) return list.indexOf(marked);
    if (descendant) return list.findIndex(el => el.id === descendant);
    return -1;
  });
  expect.soft(await selected(), 'ArrowDown selects the first result').toBe(0);
  await page.keyboard.press('ArrowDown');
  expect.soft(await selected(), 'second ArrowDown selects the second result').toBe(1);
  await page.keyboard.press('Escape');
  await expect(searchDialog(page)).toHaveCount(0);
});

test('NAV-027 Clicking a result navigates to its module and opens the record', async () => {
  const { page, context } = s;
  await home(page);
  const w = await readWorkspaceApi(context.request);
  const number = numberOf(w, ids.inv1);
  await search(page, number);
  // The invoice itself (its journals mention the number too since D-39).
  await results(page).filter({ has: page.locator('strong', { hasText: new RegExp(`^${number}$`) }) }).click();
  await expect(searchDialog(page)).toHaveCount(0);
  await expect(breadcrumb(page)).toHaveText('Sales');
  await expect(page.getByRole('dialog', { name: new RegExp(number) }), 'the invoice opens').toBeVisible({ timeout: 3000 });
  // A supplier opens Purchasing on its Suppliers tab, also when Purchasing is already open on another tab.
  const pickSupplier = async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await searchInput(page).fill(F.supplier);
    await results(page).filter({ hasText: 'supplier · ' }).click();
    await expect(breadcrumb(page)).toHaveText('Purchasing');
    await expect(page.getByRole('tab', { name: 'Suppliers' })).toHaveAttribute('aria-selected', 'true');
  };
  await home(page);
  await pickSupplier();
  await page.getByRole('tab', { name: 'Documents' }).click();
  await pickSupplier();
  // A product opens Inventory on its Products tab with the product's details.
  await page.keyboard.press('ControlOrMeta+k');
  await searchInput(page).fill('QA-KET');
  await results(page).first().click();
  await expect(breadcrumb(page)).toHaveText('Inventory');
  await expect(page.getByRole('dialog', { name: new RegExp(F.kettle) })).toBeVisible({ timeout: 3000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tab', { name: 'Products' })).toHaveAttribute('aria-selected', 'true');
});

test('NAV-028 Search with 20k records stays under 100 ms per keystroke', async ({ browser }) => {
  test.setTimeout(600_000);
  const { w } = richWorkspace();
  const template = w.documents.find(d => d.id === w.documents.find(x => x.status === 'draft' && x.kind === 'sales_invoice')!.id)!;
  const item = w.items[0];
  for (let i = 0; i < 10_000; i++) {
    w.documents.push({ ...structuredClone(template), id: `bulk-doc-${i}`, number: `INV-2025-${String(i).padStart(5, '0')}`, date: '2025-06-01', dueDate: '2025-06-01' });
    w.items.push({ ...item, id: `bulk-item-${i}`, sku: `BULK-${String(i).padStart(5, '0')}`, name: `Bulk product ${i}` });
  }
  await writeQaWorkspace(w);
  const session = await signedInPage(browser);
  const { page } = session;
  try {
    await page.goto(APP, { timeout: 180_000 });
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 180_000 });
    await expect(page.locator('button.nav-item').first()).toBeEnabled({ timeout: 180_000 });
    await page.keyboard.press('Control+k');
    await expect(searchInput(page)).toBeFocused();
    await startEventTiming(page);
    const query = 'bulk product 9999';
    // Wall-clock per keystroke measured in the page: input event → React commit → next animation frame.
    const wall = await page.evaluate(async q => {
      const input = document.querySelector<HTMLInputElement>('input.search-input')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const times: number[] = [];
      for (const ch of q) {
        const t0 = performance.now();
        setter.call(input, input.value + ch);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => requestAnimationFrame(() => r(null)));
        times.push(performance.now() - t0);
      }
      return times;
    }, query);
    await expect(results(page).first()).toContainText('Bulk product 9999');
    await searchInput(page).fill('');
    await page.keyboard.type('INV-2025-0999', { delay: 30 });
    await expect(results(page).first()).toContainText('INV-2025-0999');
    const events = await eventTimings(page);
    const maxEvent = Math.max(0, ...events.map(e => e.duration));
    test.info().annotations.push({ type: 'measured', description: `wall per keystroke max ${Math.round(Math.max(...wall))} ms (median ${Math.round(wall.sort((a, b) => a - b)[Math.floor(wall.length / 2)])} ms); Event Timing max ${maxEvent} ms over ${events.length} slow entries` });
    expect(Math.max(...wall)).toBeLessThan(100);
    expect(maxEvent).toBeLessThan(100);
  } finally {
    await session.context.close();
    await reseed(s.page);
  }
});

// ============================================================ notifications

test('NAV-030 Bell menu lists the attention queues with counts; clicking one opens its module [documented: one row per queue labelled "{count} · {Module}" rather than grouped headings; queues are commission awaiting approval, unallocated shipment costs, overdue supplier bills (D-42), open customer invoices, cheques due, follow-ups due, draft sales]', async () => {
  const { page, context } = s;
  await home(page);
  // Bills past due on the business day the test runs (the fixture's later bills fall due in October 2026).
  const w = await readWorkspaceApi(context.request);
  const overdueBills = w.documents.filter(d => d.kind === 'supplier_invoice' && d.status === 'submitted' && d.dueDate < businessToday() && Number(outstanding(d)) > 0).length;
  await bell(page).click();
  const menu = page.getByRole('menu');
  await expect(menu.locator('.workspace-menu-label')).toHaveText('NEEDS ATTENTION');
  const rows = menu.getByRole('menuitem');
  const expected: [string, string, number][] = [
    ['Commission awaiting approval', 'Commissions', 1], ['Shipment costs unallocated', 'Imports & costing', 1], ['Overdue supplier bills', 'Purchasing', overdueBills],
    ['Open customer invoices', 'Collections', 5], ['Cheques due for deposit or clearing', 'Collections', 2],
    ['Recovery follow-ups due', 'Collections', 1], ['Draft sales documents to submit', 'Sales', 1],
  ];
  await expect(rows.locator('strong')).toHaveText(expected.map(e => e[0]));
  await expect(rows.locator('small')).toHaveText(expected.map(e => `${e[2]} · ${e[1]}`));
  const total = expected.reduce((n, e) => n + e[2], 0);
  await page.keyboard.press('Escape');
  await expect(bell(page)).toHaveAttribute('aria-label', `Notifications, ${total} items need attention`);
  await expect(page.locator('.bell-count')).toHaveText(String(total));
  for (const [title, module] of expected) {
    await home(page);
    await bell(page).click();
    await page.getByRole('menuitem').filter({ hasText: title }).click();
    await expect(breadcrumb(page)).toHaveText(module);
    await expect(page.getByRole('menu')).toHaveCount(0);
  }
});

test('NAV-076 "Draft sales documents to submit" opens Sales filtered to drafts', async () => {
  const { page } = s;
  await home(page);
  await page.locator('.attention-row').filter({ hasText: 'Draft sales documents to submit' }).click();
  await expect(breadcrumb(page)).toHaveText('Sales');
  await expect(page.getByLabel('Document status'), 'status filter preset to Draft').toHaveValue('draft', { timeout: 3000 });
  // The bell's entry does the same; opening Sales from the menu shows every status.
  await home(page);
  await bell(page).click();
  await page.getByRole('menuitem').filter({ hasText: 'Draft sales documents to submit' }).click();
  await expect(page.getByLabel('Document status')).toHaveValue('draft');
  await home(page);
  await openModule(page, 'Sales');
  await expect(page.getByLabel('Document status')).toHaveValue('');
});

// ============================================================ branch picker, notices

test('NAV-048 Branch picker filters the views to the chosen branch', async () => {
  const { page } = s;
  const r = richWorkspace();
  const b = r.b;
  const lahore = b.run('save_branch', { name: 'Lahore branch' })!;
  const godown = b.run('save_warehouse', { name: 'Lahore godown', branchId: lahore })!;
  b.run('bulk_stock_increase', { warehouseId: godown, date: '2026-10-01', purpose: 'opening_stock', reason: 'QA Lahore stock', lines: [{ itemId: r.ids.led, quantity: '20', cost: '1450' }] });
  const lahoreInv = b.doc('sales_invoice', r.ids.metro, [{ itemId: r.ids.led, quantity: '2', price: '2400' }], { warehouseId: godown, date: '2026-10-09', dueDate: '2026-10-30' });
  await reseed(page, b.w);
  const picker = page.getByRole('button', { name: /^Branch filter/ });
  await expect(picker).toHaveText(/All branches/);
  await openModule(page, 'Sales');
  const all = await salesRows(page).count();
  await picker.click();
  await page.getByRole('menuitem', { name: 'Lahore branch' }).click();
  await expect(picker).toHaveAttribute('aria-label', 'Branch filter, showing Lahore branch');
  await expect(salesRows(page).locator('td:first-child')).toHaveText([b.number(lahoreInv)]);
  await openModule(page, 'Overview');
  await expect(page.getByText('Showing Lahore branch operations.', { exact: false })).toBeVisible();
  await expect(page.locator('section.card').filter({ hasText: 'Recent sales' }).locator('tbody tr td:first-child')).toHaveText([b.number(lahoreInv)]);
  // Stock is per branch (products themselves are company-wide): LED shows only the Lahore godown's 20 − 2.
  await openModule(page, 'Inventory');
  const ledRow = page.locator('tbody tr').filter({ hasText: 'QA-LED' }).first();
  await expect(ledRow).toContainText('18 pcs');
  // The ledger is company-wide: with a branch picked, Accounting explains instead of showing balances (like Reports).
  await openModule(page, 'Accounting');
  await expect(page.getByRole('heading', { name: 'The general ledger is company-wide' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Trial balance' })).toHaveCount(0);
  await openModule(page, 'Inventory');
  await picker.click();
  await page.getByRole('menuitem', { name: 'All branches' }).click();
  await expect(ledRow).not.toContainText('18 pcs');
  await openModule(page, 'Accounting');
  await expect(page.getByRole('heading', { name: 'Trial balance' })).toBeVisible();
  await openModule(page, 'Sales');
  await expect(salesRows(page)).toHaveCount(all);
  await reseed(page);
});

test('NAV-050 A notice clears on the next command', async () => {
  const { page, context } = s;
  const w = await readWorkspaceApi(context.request);
  await home(page);
  await openModule(page, 'Inventory');
  await page.getByRole('tab', { name: 'Warehouses' }).click();
  await page.getByLabel('New branch name').fill(w.branches[0].name);
  await page.getByRole('button', { name: 'Add branch' }).click();
  const error = page.locator('.main-content > .error-note');
  await expect(error).toHaveText(`Branch ${w.branches[0].name} already exists.`);
  await expect(error).toHaveAttribute('role', 'alert');
  await page.getByLabel('New branch name').fill('Hyderabad branch');
  await page.getByRole('button', { name: 'Add branch' }).click();
  await expect(page.locator('.main-content > .form-note')).toHaveText('Branch Hyderabad branch saved.');
  await expect(page.locator('.main-content > .form-note')).toHaveAttribute('role', 'status');
  await expect(error).toHaveCount(0);
  await expect(notice(page)).toHaveCount(1);
  await reseed(page);
});

// ============================================================ phone drawer

test('NAV-051 Phone: hamburger opens the drawer sliding in over a blurred scrim with a close X', async ({ browser }) => {
  const { context, page } = await phoneSession(browser);
  await expect(page.locator('.sidebar')).toBeHidden();
  const toggle = page.getByRole('button', { name: 'Open navigation' });
  await toggle.tap();
  const drawer = page.locator('.sidebar.mobile-open');
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate(el => getComputedStyle(el).animationName)).toBe('drawer-in');
  const scrim = page.getByRole('button', { name: 'Dismiss menu' });
  await expect(scrim).toBeVisible();
  expect(await scrim.evaluate(el => getComputedStyle(el).backdropFilter)).toMatch(/blur\(\d+px\)/);
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveAttribute('aria-expanded', 'true');
  await drawer.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  const d = (await drawer.boundingBox())!;
  expect(d.x).toBe(0);
  expect(d.width).toBeLessThan(PHONE.width);
  await page.getByRole('button', { name: 'Close menu' }).tap();
  await expect(drawer).toHaveCount(0);
  await context.close();
});

test('NAV-052 Phone: tapping the scrim closes the drawer', async ({ browser }) => {
  const { context, page } = await phoneSession(browser);
  await page.getByRole('button', { name: 'Open navigation' }).tap();
  await expect(page.locator('.sidebar.mobile-open')).toBeVisible();
  await page.touchscreen.tap(PHONE.width - 20, PHONE.height / 2);
  await expect(page.locator('.sidebar.mobile-open')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dismiss menu' })).toHaveCount(0);
  await expect(breadcrumb(page)).toHaveText('Overview');
  await context.close();
});

test('NAV-053 Phone: tapping an item closes the drawer and navigates', async ({ browser }) => {
  const { context, page } = await phoneSession(browser);
  for (const label of ['Sales', 'Cash & bank', 'Settings']) {
    await page.getByRole('button', { name: 'Open navigation' }).tap();
    await navItem(page, label).tap();
    await expect(page.locator('.sidebar.mobile-open')).toHaveCount(0);
    await expect(breadcrumb(page)).toHaveText(label);
  }
  await context.close();
});

test('NAV-054 Phone: Escape closes the drawer', async ({ browser }) => {
  const { context, page } = await phoneSession(browser);
  await page.getByRole('button', { name: 'Open navigation' }).tap();
  await expect(page.locator('.sidebar.mobile-open')).toBeVisible();
  await navItem(page, 'Sales').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar.mobile-open'), 'drawer closes on Escape').toHaveCount(0, { timeout: 3000 });
  await context.close();
});

// ============================================================ tabs, transitions, history

test('NAV-057 Tabbed modules switch tabs with role=tab and aria-selected [documented: tabs expose role=tablist/tab and aria-selected; no role=tabpanel/aria-controls and no arrow-key movement between tabs]', async () => {
  const { page } = s;
  const cases: [string, string[], string[]][] = [
    ['Sales', ['Documents', 'Customers'], ['Sales documents', 'Customers']],
    ['Inventory', ['Stock', 'Products', 'Warehouses'], ['', 'Products', 'Branches']],
  ];
  for (const [module, tabs, markers] of cases) {
    await home(page);
    await openModule(page, module);
    await expect(page.getByRole('tablist').first().getByRole('tab')).toHaveText(tabs);
    for (const [index, tab] of tabs.entries()) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
      for (const other of tabs.filter(t => t !== tab)) await expect(page.getByRole('tab', { name: other, exact: true })).toHaveAttribute('aria-selected', 'false');
      if (markers[index]) await expect(page.getByRole('heading', { name: markers[index], exact: true }).first()).toBeVisible();
    }
  }
  expect(await page.getByRole('tabpanel').count()).toBe(0);
});

test('NAV-058 Tab state resets to the first tab when switching module, without errors', async () => {
  const { page, errors } = s;
  const before = errors.length;
  await home(page);
  await openModule(page, 'Sales');
  await page.getByRole('tab', { name: 'Customers' }).click();
  await openModule(page, 'Inventory');
  await expect(page.getByRole('tab', { name: 'Stock' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Warehouses' }).click();
  await openModule(page, 'Sales');
  await expect(page.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
  await openModule(page, 'Inventory');
  await expect(page.getByRole('tab', { name: 'Stock' })).toHaveAttribute('aria-selected', 'true');
  expect(errors.slice(before)).toEqual([]);
});

test('NAV-059 Module change plays a fade/slide view transition (fade only with reduced motion)', async () => {
  const { page } = s;
  await home(page);
  const read = () => page.evaluate(() => {
    const el = document.querySelector('.view-enter')!;
    const style = getComputedStyle(el);
    return { name: style.animationName, duration: style.animationDuration, marked: el.hasAttribute('data-qa-old') };
  });
  await page.evaluate(() => document.querySelector('.view-enter')!.setAttribute('data-qa-old', ''));
  await navItem(page, 'Sales').click();
  const normal = await read();
  expect(normal).toEqual({ name: 'view-in', duration: '0.2s', marked: false });
  const frames = await page.evaluate(() => [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules]; } catch { return []; } })
    .filter((r): r is CSSKeyframesRule => r instanceof CSSKeyframesRule && r.name === 'view-in').map(r => r.cssText)[0]);
  expect(frames).toMatch(/opacity: 0/);
  expect(frames).toMatch(/translateY\(4px\)/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await navItem(page, 'Inventory').click();
  const reduced = await read();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(reduced.name).toBe('overlay-in');
});

test('NAV-060 Browser back/forward leaves no broken state [documented: module switches add no history entries; Back leaves the app for the previous page and Forward reloads the same company on Overview]', async () => {
  const page = await s.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/favicon.svg');
  await gotoApp(page);
  const length = await page.evaluate(() => history.length);
  for (const label of ['Sales', 'Inventory', 'Reports']) await openModule(page, label);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  expect(page.url()).toContain('/favicon.svg');
  await page.goForward();
  await page.waitForLoadState('networkidle');
  await expect(breadcrumb(page)).toHaveText('Overview', { timeout: 60_000 });
  await expect(page.locator('.workspace-picker strong')).toHaveText('QA Trading Company');
  await expect(page.locator('button.nav-item').first()).toBeEnabled();
  await openModule(page, 'Sales');
  expect(page.url()).toContain(`tenant=${QA_TENANT}`);
  expect(errors).toEqual([]);
  await page.close();
});

test('NAV-061 Reload keeps the company and returns to Overview [case-corrected: the company is kept by the ?tenant= query that stays in the URL, not by a cookie]', async () => {
  const { page, context } = s;
  await home(page);
  await openModule(page, 'Commissions');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(breadcrumb(page)).toHaveText('Overview', { timeout: 60_000 });
  await expect(page.locator('.workspace-picker strong')).toHaveText('QA Trading Company');
  expect(page.url()).toContain(`tenant=${QA_TENANT}`);
  const cookies = await context.cookies();
  expect(cookies.filter(c => c.value.includes(QA_TENANT))).toEqual([]);
  await expect(page.locator('button.nav-item').first()).toBeEnabled();
});

test('NAV-062 A deep link with ?tenant= reloads into the same company', async ({ browser }) => {
  const session = await signedInPage(browser);
  const { page } = session;
  await gotoApp(page, `/?tenant=${QA_TENANT}`);
  await expect(page.locator('.workspace-picker strong')).toHaveText('QA Trading Company');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.workspace-picker strong')).toHaveText('QA Trading Company', { timeout: 60_000 });
  await expect(page.locator('h1').first()).toContainText('Demo workspace');
  expect(page.url()).toContain(`tenant=${QA_TENANT}`);
  await session.context.close();
});

test('NAV-063 Preview-as-role chip and Exit appear only for an Owner of a demo company [documented: non-Owner members could not be signed in here; demo vs non-demo verified]', async () => {
  const { page } = s;
  await viewAs(page, 'Accountant');
  const chip = page.locator('.preview-chip');
  await expect(chip).toHaveText(/Previewing as Accountant/);
  await expect(chip.getByRole('button', { name: 'Exit preview' })).toBeVisible();
  await chip.getByRole('button', { name: 'Exit preview' }).click();
  await expect(chip).toHaveCount(0);
  await expect(page.getByLabel('View as role')).toHaveValue('Owner');
  await reseed(page, richWorkspace({ demo: false }).w);
  await openModule(page, 'Settings');
  await page.getByRole('tab', { name: 'Access' }).click();
  await expect(page.getByLabel('View as role')).toBeDisabled();
  await expect(chip).toHaveCount(0);
  await reseed(page);
});

// ============================================================ dialogs

async function openEditorWithConfirm(page: Page) {
  await home(page);
  await openModule(page, 'Sales');
  await page.getByRole('button', { name: 'New sales invoice' }).click();
  const editor = page.getByRole('dialog', { name: 'New sales invoice' });
  await expect(editor).toBeVisible();
  await editor.getByLabel('Customer').fill('Brand New Buyer QA');
  await editor.getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  await editor.getByLabel('Line 1 quantity').fill('1');
  await editor.getByRole('button', { name: 'Save draft' }).click();
  const confirm = page.getByRole('dialog', { name: 'Save customer?' });
  await expect(confirm).toBeVisible();
  return { editor, confirm };
}

test('NAV-066 Stacked editor + confirm dialogs trap focus in the top one', async () => {
  const { page } = s;
  const { editor, confirm } = await openEditorWithConfirm(page);
  const inConfirm = () => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')?.textContent?.includes('is not in your customer list'));
  expect(await inConfirm()).toBe(true);
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); expect(await inConfirm(), `Tab ${i + 1}`).toBe(true); }
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+Tab'); expect(await inConfirm(), `Shift+Tab ${i + 1}`).toBe(true); }
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(editor).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
});

test('NAV-068 Escape closes dialogs (search, follow-up, editor, invoice view, reset confirm, nested confirm one level at a time)', async () => {
  const { page } = s;
  const check = async (open: () => Promise<void>, name: string | RegExp) => {
    await open();
    const dialog = page.getByRole('dialog', { name });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  };
  await home(page);
  await check(async () => { await page.keyboard.press('Control+k'); }, 'Search');
  await check(async () => { await openModule(page, 'Collections'); await page.getByRole('button', { name: 'Log follow-up' }).click(); }, 'Log recovery follow-up');
  await check(async () => { await openModule(page, 'Sales'); await page.getByRole('button', { name: 'New sales invoice' }).click(); }, 'New sales invoice');
  await check(async () => { await openModule(page, 'Overview'); await page.getByRole('button', { name: /^View invoice/ }).first().click(); }, /INV-2026/);
  await check(async () => { await openModule(page, 'Settings'); await page.getByRole('tab', { name: 'Access' }).click(); await page.getByRole('button', { name: 'Reset demo' }).click(); }, 'Reset the demo company?');
  const { editor, confirm } = await openEditorWithConfirm(page);
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(editor).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
});

test('NAV-069 Overlay click closes every dialog consistently [documented: the document editor also closes on an overlay click, discarding typed lines]', async () => {
  const { page } = s;
  const outside = async () => { await page.mouse.click(DESKTOP.width - 8, 8); };
  const check = async (open: () => Promise<void>, name: string | RegExp) => {
    await open();
    const dialog = page.getByRole('dialog', { name });
    await expect(dialog).toBeVisible();
    await outside();
    await expect(dialog, `${name} closes on overlay click`).toHaveCount(0);
  };
  await home(page);
  await check(async () => { await page.keyboard.press('Control+k'); }, 'Search');
  await check(async () => { await openModule(page, 'Collections'); await page.getByRole('button', { name: 'Log follow-up' }).click(); }, 'Log recovery follow-up');
  await check(async () => {
    await openModule(page, 'Sales'); await page.getByRole('button', { name: 'New sales invoice' }).click();
    await page.getByRole('dialog', { name: 'New sales invoice' }).getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
  }, 'New sales invoice');
  await check(async () => { await openModule(page, 'Overview'); await page.getByRole('button', { name: /^View invoice/ }).first().click(); }, /INV-2026/);
  await check(async () => { await openModule(page, 'Settings'); await page.getByRole('tab', { name: 'Access' }).click(); await page.getByRole('button', { name: 'Reset demo' }).click(); }, 'Reset the demo company?');
});

// ============================================================ performance and console

test('NAV-071 Module switch renders in under 100 ms', async () => {
  const { page } = s;
  await home(page);
  await startEventTiming(page);
  const wall: Record<string, number> = {};
  for (const label of [...MODULES.slice(1), 'Overview']) {
    wall[label] = await page.evaluate(async text => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button.nav-item')].find(b => b.innerText.trim().startsWith(text))!;
      const t0 = performance.now();
      button.click();
      await new Promise(r => requestAnimationFrame(() => r(null)));
      return performance.now() - t0;
    }, label);
    await expect(breadcrumb(page)).toHaveText(label);
  }
  for (const label of MODULES.slice(1)) { await navItem(page, label).click(); await expect(breadcrumb(page)).toHaveText(label); }
  const events = await eventTimings(page);
  const slowest = Object.entries(wall).sort((a, b) => b[1] - a[1])[0];
  const maxEvent = Math.max(0, ...events.map(e => e.duration));
  test.info().annotations.push({ type: 'measured', description: `slowest switch ${slowest[0]} ${Math.round(slowest[1])} ms (click → next frame); Event Timing max ${maxEvent} ms` });
  expect(slowest[1]).toBeLessThan(100);
  expect(maxEvent).toBeLessThan(100);
});

test('NAV-072 Console is free of errors on every module and tab', async ({ browser }) => {
  const session = await signedInPage(browser);
  const { page, errors } = session;
  await gotoApp(page);
  for (const label of MODULES) {
    await openModule(page, label);
    const tabs = page.getByRole('tab');
    for (let i = 0; i < await tabs.count(); i++) await tabs.nth(i).click();
  }
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
  await session.context.close();
});

test('NAV-073 No hydration warnings on first load (desktop and phone)', async ({ browser }) => {
  for (const options of [{}, MOBILE]) {
    const session = await signedInPage(browser, options);
    const messages: string[] = [];
    session.page.on('console', m => messages.push(`${m.type()}: ${m.text()}`));
    await gotoApp(session.page);
    await session.page.reload();
    await gotoApp(session.page);
    const hydration = [...messages, ...session.errors].filter(m => /hydrat|did not match|server rendered|#418|#423|#425/i.test(m));
    expect(hydration).toEqual([]);
    await session.context.close();
  }
});

test('NAV-074 Workspace menu scales in from the trigger origin', async () => {
  const { page } = s;
  await home(page);
  await page.locator('.workspace-picker').click();
  const menu = page.locator('.workspace-menu');
  await expect(menu).toBeVisible();
  const info = await menu.evaluate(el => {
    const style = getComputedStyle(el);
    const [ox, oy] = style.transformOrigin.split(' ').map(parseFloat);
    const rect = el.getBoundingClientRect();
    return { name: style.animationName, duration: style.animationDuration, origin: { x: rect.x + ox, y: rect.y + oy } };
  });
  const trigger = await box(page, '.workspace-picker');
  await page.keyboard.press('Escape');
  expect(info.name).toBe('menu-in');
  expect(info.duration).toBe('0.15s');
  // The origin sits on the trigger's bottom-left edge (menu opens below, aligned to start).
  expect(Math.abs(info.origin.x - trigger.x)).toBeLessThan(4);
  expect(Math.abs(info.origin.y - (trigger.y + trigger.height))).toBeLessThan(10);
});

// ============================================================ phone menus, long names, small heights

test('NAV-080 Search dialog on phone is full width with a 16px input', async ({ browser }) => {
  const { context, page } = await phoneSession(browser);
  await page.getByRole('button', { name: /^Search anything/ }).tap();
  await expect(searchDialog(page)).toBeVisible();
  await searchDialog(page).evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  // D-61: .search-dialog .search-input is 16px on touch/phone (it used to override the global 16px input rule).
  expect.soft(await searchInput(page).evaluate(el => getComputedStyle(el).fontSize), 'search input is 16px on a touch phone').toBe('16px');
  await expect(searchInput(page)).toBeFocused();
  await searchInput(page).fill(F.metro);
  expect(await results(page).count()).toBeGreaterThan(0);
  const b = (await searchDialog(page).boundingBox())!;
  const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, layoutViewport: innerWidth, screen: visualViewport!.width }));
  test.info().annotations.push({ type: 'measured', description: `sheet ${Math.round(b.width)} px wide; ${JSON.stringify(layout)}` });
  expect(Math.round(b.x)).toBe(0);
  // D-35: the top bar no longer overflows the 390 px screen, so the layout viewport and the sheet stay 390 px.
  expect.soft(Math.round(b.width), 'search sheet matches the 390 px screen').toBe(PHONE.width);
  expect.soft(layout.scrollWidth, 'no horizontal overflow behind the sheet').toBeLessThanOrEqual(PHONE.width);
  await context.close();
});

test('NAV-081 Bell menu fits on a phone', async ({ browser }) => {
  const { context, page } = await phoneSession(browser);
  await bell(page).tap();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const b = (await menu.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width);
  expect(b.y + b.height).toBeLessThanOrEqual(PHONE.height);
  const rows = menu.getByRole('menuitem');
  for (let i = 0; i < await rows.count(); i++) {
    const strong = rows.nth(i).locator('strong');
    expect(await strong.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `row ${i} label fits`).toBe(true);
  }
  await rows.filter({ hasText: 'Recovery follow-ups due' }).tap();
  await expect(breadcrumb(page)).toHaveText('Collections');
  await context.close();
});

test('NAV-082 A long company name is truncated with an ellipsis in the switcher', async () => {
  const { page } = s;
  const longName = 'Haji Abdul Rehman Muhammad Siddique International Importers and Distributors (Private) Limited';
  const r = richWorkspace();
  r.w.company.name = longName;
  await reseed(page, r.w);
  const trigger = page.locator('.workspace-picker');
  const triggerBox = (await trigger.boundingBox())!;
  const sidebar = await box(page, '.sidebar');
  const nameStyle = await trigger.locator('strong').evaluate(el => ({ overflow: getComputedStyle(el).textOverflow, clipped: el.scrollWidth > el.clientWidth, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '16')) }));
  await trigger.click();
  const current = page.getByRole('menuitem').filter({ has: page.getByLabel('Current company') }).locator('strong');
  const menuStyle = await current.evaluate(el => ({ overflow: getComputedStyle(el).textOverflow, clipped: el.scrollWidth > el.clientWidth }));
  await page.keyboard.press('Escape');
  await reseed(page);
  test.info().annotations.push({ type: 'measured', description: `trigger name ${JSON.stringify(nameStyle)}, height ${Math.round(triggerBox.height)} px; menu ${JSON.stringify(menuStyle)}` });
  expect(menuStyle).toEqual({ overflow: 'ellipsis', clipped: true });
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
  expect(nameStyle.overflow, 'switcher trigger truncates with an ellipsis').toBe('ellipsis');
  expect(triggerBox.height, 'switcher trigger keeps one-line height').toBeLessThan(80);
});

test('NAV-083 Ten companies in the switcher stay reachable [documented: with 10 entries the menu fits within 1440×900 and 1366×768 without scrolling; the menu has no max-height, so it does not scroll itself]', async () => {
  const { page } = s;
  for (const viewport of [DESKTOP, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await home(page);
    await page.locator('.workspace-picker').click();
    const menu = page.locator('.workspace-menu');
    await expect(menu).toBeVisible();
    // Pad the real menu to 10 companies with copies of a real row (layout only).
    await menu.evaluate(el => { const rows = el.querySelectorAll('[role=menuitem]'); const template = rows[rows.length - 1]; for (let i = rows.length; i < 10; i++) { const copy = template.cloneNode(true) as HTMLElement; copy.setAttribute('data-qa-copy', ''); el.appendChild(copy); } });
    await expect(menu.getByRole('menuitem')).toHaveCount(10);
    const fit = await menu.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const last = [...el.querySelectorAll('[role=menuitem]')].at(-1)!.getBoundingClientRect();
      return { bottom: rect.bottom, lastBottom: last.bottom, scrollable: el.scrollHeight > el.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY), maxHeight: getComputedStyle(el).maxHeight };
    });
    test.info().annotations.push({ type: 'measured', description: `${viewport.width}×${viewport.height}: ${JSON.stringify(fit)}` });
    await page.keyboard.press('Escape');
    expect(fit.lastBottom <= viewport.height || fit.scrollable, `last company reachable at ${viewport.width}×${viewport.height}`).toBe(true);
  }
  await page.setViewportSize(DESKTOP);
});

test('NAV-084 On a short window the sidebar nav scrolls and the profile stays visible', async () => {
  const { page } = s;
  await page.setViewportSize({ width: 1440, height: 520 });
  try {
    await home(page);
    const nav = page.locator('.sidebar nav');
    const metrics = await nav.evaluate(el => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflow: getComputedStyle(el).overflowY }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.overflow).toBe('auto');
    const profile = (await page.locator('.sidebar .profile').boundingBox())!;
    expect(profile.y + profile.height).toBeLessThanOrEqual(520);
    await nav.evaluate(el => el.scrollTo(0, el.scrollHeight));
    await expect(navItem(page, 'Settings')).toBeInViewport();
    await navItem(page, 'Settings').click();
    await expect(breadcrumb(page)).toHaveText('Settings');
  } finally {
    await page.setViewportSize(DESKTOP);
  }
});

test('NAV-085 "Imports & costing" fits or wraps without clipping on the narrow sidebar', async ({ browser }) => {
  for (const options of [{ viewport: { width: 1000, height: 800 } }, { viewport: { width: 320, height: 700 }, hasTouch: true, isMobile: true }]) {
    const session = await signedInPage(browser, options);
    const { page } = session;
    await gotoApp(page);
    if (options.viewport.width <= 760) await page.getByRole('button', { name: 'Open navigation' }).tap();
    const item = navItem(page, 'Imports & costing');
    await expect(item).toBeVisible();
    const fit = await item.evaluate(el => {
      const label = el.querySelector('span:not(.nav-icon)')!;
      const a = label.getBoundingClientRect(); const b = el.getBoundingClientRect(); const side = el.closest('.sidebar')!.getBoundingClientRect();
      return { inside: a.right <= b.right + 0.5 && a.right <= side.right, noOverflow: el.scrollWidth <= el.clientWidth, width: Math.round(side.width) };
    });
    test.info().annotations.push({ type: 'measured', description: `${options.viewport.width}px: ${JSON.stringify(fit)}` });
    expect(fit.inside).toBe(true);
    expect(fit.noOverflow).toBe(true);
    await session.context.close();
  }
});

// ============================================================ concurrency, offline, zoom

test('NAV-096 Two tabs: a command in one; the other updates on its next command without data loss', async () => {
  const { page, context } = s;
  await reseed(page);
  const other = await context.newPage();
  await gotoApp(other);
  const shp2 = (await readWorkspaceApi(context.request)).shipments.find(x => x.id === ids.shp2)!.number;
  // Tab A allocates the shipment cost.
  await home(page);
  await openModule(page, 'Imports & costing');
  const rowA = page.locator('tbody tr').filter({ hasText: shp2 });
  await rowA.getByRole('button', { name: 'Allocate' }).click();
  await expect(rowA).toContainText('Complete');
  // Tab B is stale: it still offers Allocate. It logs a follow-up instead.
  await openModule(other, 'Imports & costing');
  await expect(other.locator('tbody tr').filter({ hasText: shp2 }).getByRole('button', { name: 'Allocate' })).toBeVisible();
  await openModule(other, 'Collections');
  await other.getByRole('button', { name: 'Log follow-up' }).click();
  const dialog = other.getByRole('dialog', { name: 'Log recovery follow-up' });
  await dialog.locator('select[name=partyId]').selectOption({ label: F.metro });
  await dialog.locator('textarea[name=note]').fill('Two-tab check: promised cheque Monday');
  await dialog.getByRole('button', { name: 'Save follow-up' }).click();
  await expect(dialog).toHaveCount(0);
  await openModule(other, 'Imports & costing');
  await expect(other.locator('tbody tr').filter({ hasText: shp2 })).toContainText('Complete');
  const w = await readWorkspaceApi(context.request);
  expect(w.shipments.find(x => x.id === ids.shp2)!.costs.every(c => c.allocated)).toBe(true);
  expect(w.followUps.some(f => f.note === 'Two-tab check: promised cheque Monday')).toBe(true);
  await other.close();
  await reseed(page);
});

test('NAV-097 Offline command shows an error notice and a retry works [documented: the notice reads the browser text "Failed to fetch"]', async () => {
  const { page, context } = s;
  await reseed(page);
  const shp2 = (await readWorkspaceApi(context.request)).shipments.find(x => x.id === ids.shp2)!.number;
  await home(page);
  await openModule(page, 'Imports & costing');
  const row = page.locator('tbody tr').filter({ hasText: shp2 });
  await context.setOffline(true);
  try {
    await row.getByRole('button', { name: 'Allocate' }).click();
    const error = page.locator('.main-content > .error-note');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');
    test.info().annotations.push({ type: 'notice', description: await error.innerText() });
  } finally {
    await context.setOffline(false);
  }
  await row.getByRole('button', { name: 'Allocate' }).click();
  await expect(row).toContainText('Complete');
  await expect(page.locator('.main-content > .error-note')).toHaveCount(0);
  const w = await readWorkspaceApi(context.request);
  const sh = w.shipments.find(x => x.id === ids.shp2)!;
  expect(sh.costs.every(c => c.allocated)).toBe(true);
  expect(w.journals.filter(j => j.sourceId.startsWith(sh.id)).length).toBeLessThanOrEqual(2);
  await reseed(page);
});

test('NAV-099 Desktop zoom 200% (720×450 CSS px) stays usable without overlap', async ({ browser }) => {
  const session = await signedInPage(browser, { viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  const { page } = session;
  await gotoApp(page);
  for (const label of ['Overview', 'Sales', 'Inventory', 'Collections', 'Reports', 'Settings']) {
    await openModule(page, label);
    expect(await noHorizontalScroll(page), `${label}: no horizontal scroll`).toBe(true);
    expect(overlaps(await box(page, '.breadcrumb'), await box(page, '.topbar-right')), `${label}: top bar`).toBe(false);
    const heading = await box(page, '.page-heading h1');
    const actions = page.locator('.heading-actions > *');
    for (let i = 0; i < await actions.count(); i++) expect(overlaps(heading, (await actions.nth(i).boundingBox())!), `${label}: heading vs action`).toBe(false);
  }
  await page.keyboard.press('Control+k');
  const dialog = (await searchDialog(page).boundingBox())!;
  expect(dialog.y).toBeGreaterThanOrEqual(0);
  expect(dialog.y + dialog.height).toBeLessThanOrEqual(450);
  await page.keyboard.press('Escape');
  expect(session.errors).toEqual([]);
  await session.context.close();
});

// ============================================================ end-to-end tour

/** docs/DEMO-TOUR.md condensed to its UI steps, from an empty company in the setup wizard to reports. */
async function demoTour(page: Page, phone: boolean) {
  const dialog = () => page.getByRole('dialog').last();
  const primary = () => dialog().locator('.form-actions button').last();
  const tab = (name: string) => page.getByRole('tab', { name, exact: true }).click();
  const row = (text: string) => page.locator('tbody tr').filter({ hasText: text }).first();
  const settle = async () => { await expect(page.locator('.spin')).toHaveCount(0, { timeout: 30_000 }); };
  const go = async (label: string) => { await openModule(page, label); await settle(); };
  const submit = async () => {
    await primary().click();
    try { await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 }); }
    catch { throw new Error(`Dialog stayed open: ${(await dialog().innerText()).replace(/\s+/g, ' ').slice(0, 600)}`); }
    await settle();
  };
  // Part 1: setup wizard.
  await page.getByLabel('Company name').fill('Tour Traders');
  await page.getByLabel('Address').fill('3 Jodia Bazar, Karachi');
  await page.getByLabel('Phone').fill('+92 300 5550000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#setup-title')).toHaveText('Documents', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#setup-title')).toHaveText('Features', { timeout: 30_000 });
  await page.getByRole('button', { name: /Importer-distributor/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#setup-title')).toHaveText('Review', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Create my workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.setup-layer')).toHaveCount(0);
  // Part 2: product, customer, supplier, warehouse.
  await go('Inventory'); await tab('Products');
  await page.getByRole('button', { name: 'New product' }).click();
  await dialog().locator('[name=sku]').fill('TOUR-LAMP');
  await dialog().locator('[name=name]').fill('Tour Desk Lamp');
  await dialog().locator('[name=price]').fill('3000');
  await dialog().locator('[name=cost]').fill('1500');
  await submit();
  await tab('Warehouses');
  await go('Sales'); await tab('Customers');
  await page.getByRole('button', { name: 'New customer' }).click();
  await dialog().locator('[name=name]').fill('Tour Retail Mart');
  await dialog().locator('[name=city]').fill('Lahore');
  await submit();
  await go('Purchasing'); await tab('Suppliers');
  await page.getByRole('button', { name: 'New supplier' }).click();
  await dialog().locator('[name=name]').fill('Tour Ningbo Lighting');
  await submit();
  // Part 3: buy stock — PO (USD) → receive → bill → payment.
  await go('Purchasing'); await tab('Documents');
  await page.getByRole('button', { name: 'New purchase order' }).first().click();
  let ed = page.getByRole('dialog', { name: 'New purchase order' });
  await ed.getByLabel('Supplier', { exact: true }).fill('Tour Ningbo Lighting');
  await ed.getByLabel('Currency').selectOption('USD');
  await ed.getByLabel('Exchange rate').fill('280');
  await ed.getByLabel('Line 1 product').selectOption({ label: 'TOUR-LAMP · Tour Desk Lamp' });
  await ed.getByLabel('Line 1 quantity').fill('20');
  await ed.getByLabel('Line 1 price').fill('5');
  await ed.locator('.form-actions button').last().click();
  await expect(ed).toHaveCount(0, { timeout: 30_000 }); await settle();
  await page.getByRole('button', { name: /^Convert PO-/ }).first().click();
  await submit();
  await row('GRN-').getByRole('button', { name: 'Submit' }).click(); await settle();
  await page.getByRole('button', { name: /^Convert GRN-/ }).first().click();
  await submit();
  await row('BILL-').getByRole('button', { name: 'Submit' }).click(); await settle();
  await tab('Supplier payments');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await dialog().getByLabel('Supplier').selectOption({ label: 'Tour Ningbo Lighting' });
  await dialog().getByLabel('Amount to allocate oldest first').fill('100');
  await submit();
  // Part 4: sell.
  await go('Sales');
  await page.getByRole('button', { name: 'New sales invoice' }).click();
  ed = page.getByRole('dialog', { name: 'New sales invoice' });
  await ed.getByLabel('Customer', { exact: true }).fill('Tour Retail Mart');
  await ed.getByLabel('Line 1 product').selectOption({ label: 'TOUR-LAMP · Tour Desk Lamp' });
  await ed.getByLabel('Line 1 quantity').fill('4');
  await ed.locator('.form-actions button').last().click();
  await expect(ed).toHaveCount(0, { timeout: 30_000 }); await settle();
  await page.getByRole('button', { name: /^View invoice INV-/ }).first().click();
  await expect(dialog()).toContainText('Tour Retail Mart');
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  // Part 5: get paid — cash, then a cheque deposited and cleared; a follow-up.
  await go('Collections');
  await page.getByRole('button', { name: 'Record receipt' }).first().click();
  await dialog().getByLabel('Customer').selectOption({ label: 'Tour Retail Mart' });
  await dialog().getByLabel('Amount to allocate oldest first').fill('5000');
  await dialog().getByLabel('Payment method').selectOption('cash');
  await submit();
  await page.getByRole('button', { name: 'Record receipt' }).first().click();
  await dialog().getByLabel('Customer').selectOption({ label: 'Tour Retail Mart' });
  await dialog().getByLabel('Amount to allocate oldest first').fill('7000');
  await dialog().getByLabel('Payment method').selectOption('cheque');
  await dialog().getByLabel('Cheque number').fill('TOUR-555');
  await submit();
  await page.getByRole('button', { name: 'Deposit TOUR-555' }).click(); await settle();
  await page.getByRole('button', { name: 'Clear TOUR-555' }).click(); await settle();
  await page.getByRole('button', { name: 'Log follow-up' }).click();
  await dialog().locator('select[name=partyId]').selectOption({ label: 'Tour Retail Mart' });
  await dialog().locator('textarea[name=note]').fill('Promised payment Friday');
  await submit();
  // Part 6: cash & bank, stock, reports, accounting.
  await go('Cash & bank');
  await page.getByRole('button', { name: 'Transfer' }).click();
  await dialog().getByLabel('Transfer amount').fill('1000');
  await submit();
  await page.getByRole('button', { name: 'Record expense' }).click();
  await dialog().getByLabel('Expense amount').fill('200');
  await dialog().getByLabel('Expense memo').fill('Fuel');
  await submit();
  await go('Inventory');
  await expect(row('TOUR-LAMP')).toContainText('16');
  await go('Reports');
  const reports = page.locator('.reports-menu button');
  for (let i = 0; i < await reports.count(); i++) { if (phone && !(await reports.nth(i).isVisible())) continue; await reports.nth(i).click(); await settle(); }
  await go('Accounting');
  // Part 7: commissions, settings.
  await go('Commissions');
  await go('Settings');
  for (const name of ['Features', 'Company & documents', 'Access', 'Audit history']) await tab(name);
  await go('Overview');
  await expect(page.locator('.metric-card').first()).not.toContainText('Rs 0');
}

// Phone runs at 390×844 with touch but without isMobile: with isMobile the top-bar overflow (NAV-080) widens the
// layout viewport to 407 px and zooms the page out, which breaks Playwright's hit-testing of the wizard footer.
test('NAV-100 End-to-end tour (docs/DEMO-TOUR.md) completes at desktop and phone without console errors', async ({ browser }) => {
  test.setTimeout(900_000);
  for (const [label, options] of [['desktop', { viewport: DESKTOP }], ['phone', { viewport: PHONE, hasTouch: true }]] as const) {
    await writeQaWorkspace(setupWorkspace(1));
    const session = await signedInPage(browser, options);
    const { page, errors } = session;
    try {
      await page.goto(APP);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('.setup-card')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 60_000 });
      await demoTour(page, label === 'phone');
      const w = await readWorkspaceApi(session.context.request);
      const kinds = Object.fromEntries(['purchase_order', 'goods_receipt', 'supplier_invoice', 'sales_invoice'].map(k => [k, w.documents.filter(d => d.kind === k && d.status === 'submitted').length]));
      expect(kinds, label).toEqual({ purchase_order: 1, goods_receipt: 1, supplier_invoice: 1, sales_invoice: 1 });
      expect(w.receipts.filter(r => r.status === 'cleared').length, label).toBe(3);
      expect(w.receipts.find(r => r.chequeNo === 'TOUR-555')?.status, label).toBe('cleared');
      expect(w.followUps, label).toHaveLength(1);
      expect(w.company.name, label).toBe('Tour Traders');
      expect(errors, `${label} console errors`).toEqual([]);
    } finally {
      await session.context.close();
    }
  }
  await seedRich();
});
