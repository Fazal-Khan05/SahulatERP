import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DESKTOP, F, PHONE, QA_TENANT, contrast, freshBuilder, gotoApp, home, keepSignedIn, openModule, richWorkspace, saveEvidence, setupWorkspace, signedInPage, writeQaWorkspace } from './helpers';

// Responsive layout, keyboard, focus, axe and visual-consistency checks in a real Chromium.
// Each describe block writes the company it needs into the QA tenant first.

const MODULES = ['Overview', 'Sales', 'Purchasing', 'Imports & costing', 'Inventory', 'Collections', 'Cash & bank', 'Commissions', 'Payroll', 'Accounting', 'Reports', 'Settings'];
const LONG_COMPANY = 'Al-Noor Consolidated Importers, Distributors & General Order Suppliers of Electrical and Household Goods (Private) Ltd';
const LONG_CUSTOMER = 'Haji Muhammad Abdul Rehman & Sons Electrical Wholesale and Retail Traders, Shop 14-B';

type Opened = { context: BrowserContext; page: Page; errors: string[] };
async function open(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}): Promise<Opened> {
  const session = await signedInPage(browser, options);
  await gotoApp(session.page);
  return session;
}
/** Opens a module; on a phone the drawer is closed again so the page itself is measured. */
async function goModule(page: Page, label: string) {
  for (let i = 0; i < 3 && await page.locator('[role=dialog]:not(.setup-layer), [role=menu]').count(); i++) await page.keyboard.press('Escape');
  await openModule(page, label);
  if (await page.locator('.sidebar.mobile-open').count()) await page.getByRole('button', { name: 'Dismiss menu' }).click();
  await expect(page.locator('.sidebar.mobile-open')).toHaveCount(0);
  await page.waitForTimeout(250); // view-enter animation
}
/** Page width against the configured viewport width (under isMobile, window.innerWidth grows with an overflowing page). */
const pageWidth = async (page: Page) => ({ scroll: await page.evaluate(() => document.documentElement.scrollWidth), inner: page.viewportSize()!.width });
/** What sticks out past the right edge of the viewport (outside horizontal scrollers). */
const sticksOut = (page: Page, width: number) => page.evaluate(w => [...document.querySelectorAll('body *')].filter(e => {
  const r = e.getBoundingClientRect();
  if (r.width === 0 || r.right <= w + 0.5) return false;
  for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || (o !== 'visible' && p.getBoundingClientRect().right <= w + 0.5)) return false; }
  return true;
}).slice(0, 3).map(e => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(' ')[0]} "${(e.textContent ?? '').trim().slice(0, 20)}" right=${Math.round(e.getBoundingClientRect().right)}`), width);
/** Visible boxes among the given selectors that overlap each other. */
const overlaps = (page: Page, selector: string) => page.evaluate(sel => {
  const boxes = [...document.querySelectorAll(sel)].filter(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0).map(e => ({ e, r: e.getBoundingClientRect() }));
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a, b] = [boxes[i].r, boxes[j].r];
    if (boxes[i].e.contains(boxes[j].e) || boxes[j].e.contains(boxes[i].e)) continue;
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${boxes[i].e.className} × ${boxes[j].e.className}`);
  }
  return out;
}, selector);

// ====================================================================== busy importer at every size
test.describe('layout, keyboard and accessibility on the busy company', () => {
  test.beforeAll(async () => { await writeQaWorkspace(richWorkspace().w); });

  test('UIX-001 every module at 390×844 has no horizontal page scroll', async ({ browser }) => {
    const s = await open(browser, { viewport: PHONE, hasTouch: true });
    const bad: string[] = [];
    for (const m of MODULES) {
      await goModule(s.page, m);
      const { scroll, inner } = await pageWidth(s.page);
      if (scroll > inner) bad.push(`${m}: scrollWidth ${scroll} > ${inner} (${(await sticksOut(s.page, inner)).join('; ')})`);
    }
    saveEvidence('uix-001-phone-overflow.json', bad);
    // D-35: on a phone the top bar keeps only the menu button, the module name (ellipsis), search and the bell.
    expect(bad).toEqual([]);
    await s.context.close();
  });

  test('UIX-002 every module at 1440×900 lays out as designed (sidebar + content, no overflow or overlap)', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const bad: string[] = [];
    for (const m of MODULES) {
      await goModule(s.page, m);
      const l = await s.page.evaluate(() => {
        const r = (q: string) => document.querySelector(q)!.getBoundingClientRect();
        return { sidebar: r('.sidebar'), shell: r('.main-shell'), h1: r('h1'), sw: document.documentElement.scrollWidth };
      });
      if (l.sw > 1440) bad.push(`${m}: horizontal scroll ${l.sw}`);
      if (l.sidebar.left !== 0 || l.sidebar.width < 200) bad.push(`${m}: sidebar not docked left`);
      if (l.shell.left < l.sidebar.right - 1) bad.push(`${m}: content under the sidebar`);
      if (l.h1.left < l.sidebar.right) bad.push(`${m}: heading under the sidebar`);
      bad.push(...(await sticksOut(s.page, 1440)).map(x => `${m}: ${x}`));
      bad.push(...(await overlaps(s.page, '.topbar > *, .page-heading > *')).map(x => `${m}: ${x}`));
    }
    expect(bad).toEqual([]);
    expect(s.errors).toEqual([]);
    await s.context.close();
  });

  test('UIX-003 768×1024 tablet: sidebar shown beside readable content, no horizontal scroll [defect]', async ({ browser }) => {
    const s = await open(browser, { viewport: { width: 768, height: 1024 }, hasTouch: true });
    const bad: string[] = [];
    for (const m of MODULES) {
      await goModule(s.page, m);
      const l = await s.page.evaluate(() => ({ sidebar: getComputedStyle(document.querySelector('.sidebar')!).display, sbRight: document.querySelector('.sidebar')!.getBoundingClientRect().right, shell: document.querySelector('.main-shell')!.getBoundingClientRect().left, sw: document.documentElement.scrollWidth, small: [...document.querySelectorAll('.main-content p, .main-content td, .main-content th, .main-content label')].filter(e => (e as HTMLElement).offsetParent && !e.closest('.branding-preview-frame') && parseFloat(getComputedStyle(e).fontSize) < 11).length }));
      if (l.sidebar === 'none') bad.push(`${m}: no sidebar`);
      if (l.shell < l.sbRight - 1) bad.push(`${m}: content under sidebar`);
      if (l.sw > 768) bad.push(`${m}: scrollWidth ${l.sw} (${(await sticksOut(s.page, 768)).join('; ')})`);
      if (l.small) bad.push(`${m}: ${l.small} text nodes under 11px`);
    }
    saveEvidence('uix-003-tablet.json', bad);
    // Actual: Overview keeps four metric cards in a row; "Rs 217,354.…" spills out of its card and widens the page to ~799 px.
    expect(bad).toEqual([]);
    await s.context.close();
  });

  test('UIX-004 1920×1080: content keeps a max width and does not stretch', async ({ browser }) => {
    const s = await open(browser, { viewport: { width: 1920, height: 1080 } });
    for (const m of ['Overview', 'Sales', 'Inventory', 'Reports', 'Settings']) {
      await goModule(s.page, m);
      const l = await s.page.evaluate(() => ({ main: document.querySelector('.main-content')!.getBoundingClientRect().width, maxWidth: getComputedStyle(document.querySelector('.main-content')!).maxWidth, cards: Math.max(...[...document.querySelectorAll('.main-content .card')].map(c => c.getBoundingClientRect().width)), sw: document.documentElement.scrollWidth }));
      expect(l.maxWidth, m).toBe('1440px');
      expect(l.main, m).toBeLessThanOrEqual(1440);
      expect(l.cards, m).toBeLessThanOrEqual(1440);
      expect(l.sw, m).toBeLessThanOrEqual(1920);
    }
    await s.context.close();
  });

  test('UIX-005 320px width is usable and wraps (drawer, dialogs, no horizontal scroll)', async ({ browser }) => {
    const s = await open(browser, { viewport: { width: 320, height: 640 }, hasTouch: true });
    const bad: string[] = [];
    for (const m of MODULES) {
      await goModule(s.page, m);
      const { scroll, inner } = await pageWidth(s.page);
      if (scroll > inner) bad.push(`${m}: scrollWidth ${scroll} (${(await sticksOut(s.page, inner)).join('; ')})`);
    }
    await s.page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = await s.page.locator('.sidebar.mobile-open').boundingBox();
    expect(drawer!.width).toBeLessThanOrEqual(320);
    await s.page.getByRole('button', { name: 'Close menu' }).click();
    await expect(s.page.locator('.sidebar.mobile-open')).toHaveCount(0);
    await goModule(s.page, 'Sales');
    await s.page.getByRole('button', { name: 'New invoice' }).first().click();
    const dialog = await s.page.getByRole('dialog').boundingBox();
    expect(dialog!.width).toBeLessThanOrEqual(320);
    await s.page.keyboard.press('Escape');
    saveEvidence('uix-005-320-overflow.json', bad);
    expect(bad).toEqual([]);
    await s.context.close();
  });

  test('UIX-008 dialogs on phone are bottom sheets with sticky actions', async ({ browser }) => {
    const s = await open(browser, { viewport: PHONE, isMobile: true, hasTouch: true });
    const sheets: [string, () => Promise<void>][] = [
      ['New sales invoice', async () => { await goModule(s.page, 'Sales'); await s.page.getByRole('button', { name: 'New invoice' }).first().click(); }],
      ['Record receipt', async () => { await goModule(s.page, 'Collections'); await s.page.locator('.heading-actions').getByRole('button', { name: 'Record receipt' }).click(); }],
      ['New customer', async () => { await goModule(s.page, 'Sales'); await s.page.getByRole('tab', { name: 'Customers' }).click(); await s.page.getByRole('button', { name: 'New customer' }).click(); }],
    ];
    for (const [name, openIt] of sheets) {
      await openIt();
      const dialog = s.page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await s.page.waitForTimeout(500);
      const m = await dialog.evaluate(el => { const r = el.getBoundingClientRect(); const a = [...el.querySelectorAll('.form-actions')].at(-1)!; return { left: r.left, width: r.width, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight, sticky: getComputedStyle(a).position }; });
      expect(m.left, name).toBe(0);
      expect(m.width, name).toBe(m.vw);
      expect(Math.abs(m.bottom - m.vh), name).toBeLessThanOrEqual(1);
      expect(m.sticky, name).toBe('sticky');
      // Actions stay on screen at the top and at the bottom of a long form.
      await dialog.evaluate(el => { el.scrollTop = 0; });
      await expect(dialog.locator('.form-actions').last(), name).toBeInViewport();
      await dialog.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect(dialog.locator('.form-actions').last(), name).toBeInViewport();
      await s.page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    await s.context.close();
  });

  test('UIX-028 the app is operable by keyboard alone (navigate, tabs, open/close dialog, search)', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const { page } = s;
    const focused = () => page.evaluate(() => { const e = document.activeElement as HTMLElement; return `${e.tagName}|${e.getAttribute('role') ?? ''}|${(e.getAttribute('aria-label') ?? e.innerText ?? '').trim().split('\n')[0]}`; });
    async function tabTo(match: RegExp, max = 80) {
      for (let i = 0; i < max; i++) { await page.keyboard.press('Tab'); if (match.test(await focused())) return; }
      throw new Error(`Tab never reached ${match}; last ${await focused()}`);
    }
    await page.locator('body').focus();
    await tabTo(/^BUTTON\|\|Sales$/);
    await page.keyboard.press('Enter');
    await expect(page.locator('.breadcrumb strong')).toHaveText('Sales');
    await tabTo(/^BUTTON\|tab\|Customers/);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'Customers' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Shift+Tab');
    expect(await focused()).toMatch(/^BUTTON\|tab\|Documents/);
    await page.keyboard.press('Enter');
    await tabTo(/^BUTTON\|\|New invoice/);
    await page.keyboard.press('Enter');
    const editor = page.getByRole('dialog', { name: 'New sales invoice' });
    await expect(editor).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await page.keyboard.press('Control+k');
    const search = page.getByRole('dialog', { name: 'Search' });
    await expect(search).toBeVisible();
    await page.keyboard.type(F.led);
    await tabTo(new RegExp(F.led), 10);
    await page.keyboard.press('Enter');
    await expect(search).toHaveCount(0);
    await expect(page.locator('.breadcrumb strong')).toHaveText('Inventory');
    await s.context.close();
  });

  test('UIX-029 keyboard focus is visible everywhere (violet ring) [defect]', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const { page } = s;
    const missing: string[] = [];
    const seen = new Set<string>();
    async function walk(stops: number, where: string) {
      for (let i = 0; i < stops; i++) {
        await page.keyboard.press('Tab');
        const f = await page.evaluate(() => {
          const e = document.activeElement as HTMLElement;
          if (!e || e === document.body) return null;
          const cs = getComputedStyle(e);
          const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1) ? cs.outlineColor : /rgba?\(107, 61, 245/.test(cs.boxShadow) ? 'box-shadow' : '';
          return { key: `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} "${(e.getAttribute('aria-label') ?? e.innerText ?? '').trim().slice(0, 25)}"`, ring };
        });
        if (!f || seen.has(f.key)) continue;
        seen.add(f.key);
        if (!f.ring || !/107, 61, 245|box-shadow/.test(f.ring)) missing.push(`${where}: ${f.key} (${f.ring || 'no ring'})`);
      }
    }
    // Read the settled focus style, not the first frame of its 150 ms transition.
    const still = '*,*::before,*::after{transition:none!important;animation:none!important}';
    for (const m of ['Overview', 'Sales', 'Collections', 'Settings']) {
      await goModule(page, m);
      await page.addStyleTag({ content: still });
      await page.locator('body').focus();
      await walk(70, m);
    }
    await goModule(page, 'Sales');
    await page.getByRole('button', { name: 'New invoice' }).first().click();
    await page.addStyleTag({ content: still });
    await walk(30, 'invoice editor');
    await page.keyboard.press('Escape');
    saveEvidence('uix-029-focus.json', { checked: [...seen], missing });
    expect(seen.size).toBeGreaterThan(40);
    expect(missing).toEqual([]);
    await s.context.close();
  });

  test('UIX-030 focus is trapped in dialogs and returns to the trigger on close', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const { page } = s;
    const returned: string[] = [];
    for (const [module, trigger, name] of [['Sales', 'New invoice', 'New sales invoice'], ['Collections', 'Record receipt', /receipt/i]] as const) {
      await goModule(page, module);
      const button = page.locator('.main-content').getByRole('button', { name: trigger }).first();
      await button.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name });
      await expect(dialog).toBeVisible();
      for (const key of [...Array(40).fill('Tab'), ...Array(15).fill('Shift+Tab')]) {
        await page.keyboard.press(key);
        expect(await dialog.evaluate(el => el.contains(document.activeElement)), `${name}: focus stays inside after ${key}`).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await page.waitForTimeout(500);
      const now = await page.evaluate(() => { const e = document.activeElement as HTMLElement; return e === document.body ? 'body' : `${e.tagName.toLowerCase()} "${e.innerText.trim()}"`; });
      returned.push(`${trigger}: ${await button.evaluate(el => el === document.activeElement) ? 'trigger' : now}`);
    }
    // Dialogs open from state, so ui/dialog.tsx records the focused element on open and returns focus there on close (D-45).
    expect(returned).toEqual(['New invoice: trigger', 'Record receipt: trigger']);
    await s.context.close();
  });

  test('UIX-034 all inputs are labelled (axe label rules on every module and the main forms)', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const { page } = s;
    const rules = ['label', 'select-name', 'aria-input-field-name', 'aria-toggle-field-name', 'input-button-name', 'button-name'];
    const found: string[] = [];
    const scan = async (where: string) => { for (const v of (await new AxeBuilder({ page }).withRules(rules).analyze()).violations) found.push(`${where}: ${v.id} ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')}`); };
    for (const m of MODULES) { await goModule(page, m); await scan(m); }
    await goModule(page, 'Sales');
    await page.getByRole('button', { name: 'New invoice' }).first().click(); await scan('invoice editor'); await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Customers' }).click(); await page.getByRole('button', { name: 'New customer' }).click(); await scan('customer form'); await page.keyboard.press('Escape');
    await goModule(page, 'Collections');
    await page.locator('.heading-actions').getByRole('button', { name: 'Record receipt' }).click(); await scan('receipt form'); await page.keyboard.press('Escape');
    expect(found).toEqual([]);
    await s.context.close();
  });

  test('UIX-058 dates are YYYY-MM-DD in tables and friendly in the top bar', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const odd: string[] = [];
    let iso = 0;
    for (const m of MODULES) {
      await goModule(s.page, m);
      for (const c of await s.page.locator('.main-content td').allInnerTexts()) {
        if (/\b\d{4}-\d{2}-\d{2}\b/.test(c)) iso++;
        if (/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}\b/.test(c)) odd.push(`${m}: ${c}`);
      }
    }
    expect(iso).toBeGreaterThan(20);
    expect(odd).toEqual([]);
    const top = await s.page.locator('.topbar-date').innerText();
    expect(top).toBe(new Date().toLocaleDateString('en-PK', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Karachi' }));
    expect(top).toMatch(/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}$/);
    await s.context.close();
  });

  test('UIX-060 error copy is plain English and names the fix', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const { page } = s;
    const errors: string[] = [];
    // 1. Invoice with a customer but no product.
    await goModule(page, 'Sales');
    await page.getByRole('button', { name: 'New invoice' }).first().click();
    const editor = page.getByRole('dialog', { name: 'New sales invoice' });
    await editor.getByLabel('Customer', { exact: true }).fill(F.customer);
    await editor.getByRole('button', { name: 'Save draft' }).click();
    await expect(editor.getByRole('alert')).toBeVisible();
    errors.push(`invoice without product: ${(await editor.getByRole('alert').innerText()).trim()}`);
    // 2. Quantity above stock on a submitted invoice.
    await editor.getByLabel('Line 1 product').selectOption({ label: `QA-FAN · ${F.fan}` });
    await editor.getByLabel('Line 1 quantity').fill('100000');
    await editor.getByRole('button', { name: /submit/i }).click();
    await expect.poll(async () => (await page.getByRole('alert').allInnerTexts()).join(' ')).toMatch(/stock|available/i);
    errors.push(`invoice above stock: ${(await page.getByRole('alert').allInnerTexts()).find(t => /stock|available/i.test(t))!.trim()}`);
    await page.keyboard.press('Escape');
    // 3. Customer without a name.
    await goModule(page, 'Sales');
    await page.getByRole('tab', { name: 'Customers' }).click();
    await page.getByRole('button', { name: 'New customer' }).click();
    const form = page.getByRole('dialog');
    await form.getByRole('button', { name: 'Add customer' }).click();
    errors.push(`customer without name: ${await form.getByRole('alert').count() ? (await form.getByRole('alert').innerText()).trim() : await form.locator('input:invalid').first().evaluate(el => (el as HTMLInputElement).validationMessage)}`);
    await page.keyboard.press('Escape');
    saveEvidence('uix-060-errors.json', errors);
    for (const e of errors) {
      const text = e.slice(e.indexOf(': ') + 2);
      expect(text, e).not.toMatch(/ZodError|undefined|null|NaN|TypeError|Exception|stack|invalid_type|\{|\}|\[object/);
      expect(text, e).toMatch(/^[A-Z"“]/);
      expect(text, `${e} — names the fix`).toMatch(/\b(Choose|Select|Pick|Add|Enter|Type|Fill|Use|Reduce|Remove|Check|Try|Set|Please|Requested|available)\b/i);
    }
    await s.context.close();
  });

  test('UIX-062 a single radius scale 6/10/14/20 (no stray radii) [defect]', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const { page } = s;
    const stray = new Map<string, string>();
    const collect = async (where: string) => {
      const found = await page.evaluate(() => {
        const ok = (v: string) => v === '0px' || v.endsWith('%') || ['6px', '10px', '14px', '20px'].includes(v) || parseFloat(v) >= 999;
        const out: [string, string][] = [];
        for (const e of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(e);
          if (cs.display === 'none' || e.getBoundingClientRect().width === 0 || e.closest('.doc')) continue; // the printable template is sized in mm
          for (const v of [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]) {
            const first = v.split(' ')[0];
            if (!ok(first)) out.push([first, `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(' ')[0]}`]);
          }
        }
        return out;
      });
      for (const [v, el] of found) if (!stray.has(`${v} ${el}`)) stray.set(`${v} ${el}`, where);
    };
    for (const m of MODULES) { await goModule(page, m); await collect(m); }
    await goModule(page, 'Sales');
    await page.getByRole('button', { name: 'New invoice' }).first().click(); await collect('invoice editor'); await page.keyboard.press('Escape');
    const list = [...stray].map(([k, where]) => `${k} (${where})`).sort();
    saveEvidence('uix-062-stray-radii.json', list);
    expect(list).toEqual([]);
    await s.context.close();
  });

  test('UIX-071 desktop zoom 200% (720 CSS px) has no overlap or horizontal scroll', async ({ browser }) => {
    const s = await open(browser, { viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    const bad: string[] = [];
    for (const m of MODULES) {
      await goModule(s.page, m);
      const { scroll, inner } = await pageWidth(s.page);
      if (scroll > inner) bad.push(`${m}: scrollWidth ${scroll} (${(await sticksOut(s.page, inner)).join('; ')})`);
      bad.push(...(await overlaps(s.page, '.topbar .breadcrumb, .topbar .topbar-right > *, .page-heading > div')).map(x => `${m}: ${x}`));
    }
    expect(bad).toEqual([]);
    await s.context.close();
  });

  test('UIX-080 select elements are styled consistently [documented: filter-bar selects are a compact 12.64 px / 41 px size; form selects are 14 px / 42 px; radius, border, background, colour and font are identical everywhere]', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const { page } = s;
    const styles = new Map<string, string[]>();
    const collect = async (where: string) => {
      const found = await page.locator('select:visible').evaluateAll(els => els.map(e => { const c = getComputedStyle(e); return { key: JSON.stringify({ h: c.height, r: c.borderTopLeftRadius, b: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`, bg: c.backgroundColor, fs: c.fontSize, color: c.color, font: c.fontFamily.split(',')[0] }), label: e.getAttribute('aria-label') ?? '' }; }));
      for (const f of found) styles.set(f.key, [...(styles.get(f.key) ?? []), `${where}: ${f.label}`]);
    };
    for (const m of MODULES) { await goModule(page, m); await collect(m); }
    await goModule(page, 'Sales');
    await page.getByRole('button', { name: 'New invoice' }).first().click(); await collect('invoice editor'); await page.keyboard.press('Escape');
    saveEvidence('uix-080-selects.json', Object.fromEntries(styles));
    const variants = [...styles.keys()].map(k => JSON.parse(k) as Record<string, string>);
    expect(variants.length).toBeGreaterThan(0);
    expect([...new Set(variants.map(v => `${v.fs}/${v.h}`))].sort()).toEqual(['12.64px/41px', '14px/42px']);
    for (const key of ['r', 'b', 'bg', 'color', 'font']) expect([...new Set(variants.map(v => v[key]))], `select ${key} is the same everywhere`).toHaveLength(1);
    await s.context.close();
  });

  test('UIX-087 loading spinners appear on the busy button only', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const { page } = s;
    await goModule(page, 'Sales');
    expect(await page.locator('.spin:visible').count()).toBe(0);
    await page.getByRole('button', { name: 'New invoice' }).first().click();
    const editor = page.getByRole('dialog', { name: 'New sales invoice' });
    await editor.getByLabel('Customer', { exact: true }).fill(F.customer);
    await editor.getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
    await editor.getByLabel('Line 1 quantity').fill('1');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    await page.route('**/api/workspace', async route => { if (route.request().method() === 'POST') await gate; await route.continue(); });
    const save = editor.getByRole('button', { name: 'Save draft' });
    await save.click();
    await expect(save.locator('.spin')).toBeVisible();
    const spinners = await page.locator('.spin:visible').evaluateAll(els => els.map(e => e.closest('button')?.innerText.trim() ?? `outside a button: ${e.parentElement?.className}`));
    expect(spinners).toEqual(['Save draft']);
    await expect(editor.getByRole('button', { name: /submit/i })).toBeDisabled();
    release();
    await expect(editor).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.spin:visible')).toHaveCount(0);
    await page.unroute('**/api/workspace');
    await s.context.close();
  });

  test('UIX-089 notices are readable on phone [defect]', async ({ browser }) => {
    const s = await open(browser, { viewport: PHONE, isMobile: true, hasTouch: true });
    const { page } = s;
    await goModule(page, 'Sales');
    const row = page.locator('section.card').first().locator('tbody tr').filter({ has: page.getByRole('button', { name: 'Submit', exact: true }) }).first();
    await row.scrollIntoViewIfNeeded();
    await row.getByRole('button', { name: 'Submit', exact: true }).click();
    const notice = page.locator('.main-content > [role=status], .main-content > [role=alert]');
    await expect(notice).toHaveText(/\S/, { timeout: 30_000 });
    const m = await notice.evaluate(el => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { fs: parseFloat(cs.fontSize), color: cs.color, bg: cs.backgroundColor, left: r.left, right: r.right, top: r.top, vw: window.innerWidth, sw: el.scrollWidth, cw: el.clientWidth, scrollY: window.scrollY }; });
    saveEvidence('uix-089-notice.json', { text: await notice.innerText(), ...m });
    expect(m.fs).toBeGreaterThanOrEqual(12);
    expect(contrast(m.color, m.bg)).toBeGreaterThanOrEqual(4.5);
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.right).toBeLessThanOrEqual(m.vw);
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    // Actual: the notice is rendered in the page flow above the heading; after acting on a row further down it is off-screen.
    await expect(notice, 'the notice is on screen after the action').toBeInViewport();
    await s.context.close();
  });

  test('UIX-092 axe-core: no serious or critical violations on any module (desktop and phone) [defect]', async ({ browser }) => {
    const found: string[] = [];
    for (const [name, options] of [['desktop', { viewport: DESKTOP }], ['phone', { viewport: PHONE, isMobile: true, hasTouch: true }]] as const) {
      const s = await open(browser, options);
      for (const m of MODULES) {
        await goModule(s.page, m);
        const result = await new AxeBuilder({ page: s.page }).analyze();
        for (const v of result.violations.filter(x => x.impact === 'serious' || x.impact === 'critical')) found.push(`${name} ${m}: ${v.id} (${v.impact}) ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')}`);
      }
      await s.context.close();
    }
    saveEvidence('uix-092-axe.json', found);
    expect(found).toEqual([]);
  });

  test('UIX-095 nested dialog title ids are unique', async ({ browser }) => {
    const s = await open(browser, { viewport: DESKTOP });
    const { page } = s;
    await goModule(page, 'Sales');
    await page.getByRole('button', { name: 'New invoice' }).first().click();
    const editor = page.getByRole('dialog', { name: 'New sales invoice' });
    await editor.getByLabel('Customer', { exact: true }).fill('Brand New Buyer Karachi');
    await editor.getByLabel('Line 1 product').selectOption({ label: `QA-LED · ${F.led}` });
    await editor.getByLabel('Line 1 quantity').fill('1');
    await editor.getByRole('button', { name: 'Save draft' }).click();
    const confirm = page.getByRole('dialog', { name: 'Save customer?' });
    await expect(confirm).toBeVisible();
    const dialogs = await page.locator('[role=dialog]').evaluateAll(els => els.map(e => { const id = e.getAttribute('aria-labelledby') ?? ''; const title = id ? document.getElementById(id) : null; return { id, inside: !!title && e.contains(title), text: title?.textContent ?? '' }; }));
    const allIds = await page.locator('[id]').evaluateAll(els => els.map(e => e.id));
    expect(dialogs.map(d => d.text).sort()).toEqual(['New sales invoice', 'Save customer?']);
    expect(new Set(dialogs.map(d => d.id)).size).toBe(dialogs.length);
    expect(dialogs.every(d => d.inside)).toBe(true);
    expect(allIds.length).toBe(new Set(allIds).size);
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await page.keyboard.press('Escape');
    await s.context.close();
  });
});

// ====================================================================== long and right-to-left names
test.describe('long and Urdu names', () => {
  let s: Opened;
  test.beforeAll(async ({ browser }) => {
    const r = richWorkspace();
    r.b.run('save_company', { name: LONG_COMPANY, address: '12 Jodia Bazar, Karachi', phone: '+92 300 1234567', email: 'office@qa.example', taxId: '1234567-8' });
    r.b.party(LONG_CUSTOMER, 'customer', { city: 'Hyderabad' });
    await writeQaWorkspace(r.b.w);
    s = await open(browser, { viewport: DESKTOP });
  });
  test.beforeEach(async ({ browser }) => { await keepSignedIn(browser, s.context, s.page); });
  test.afterAll(async () => { await s?.context.close(); });
  const customerRow = (page: Page, name: string) => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Customers', level: 2 }) }).locator('tbody tr').filter({ hasText: name });

  test('UIX-083 long names truncate with an ellipsis in fixed-width spots (workspace switcher) [defect]', async () => {
    const { page } = s;
    await home(page);
    const spots = await page.evaluate(() => [...document.querySelectorAll('.sidebar *')].filter(e => e.children.length === 0 && (e.textContent ?? '').includes('Al-Noor')).map(e => {
      const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); const side = document.querySelector('.sidebar')!.getBoundingClientRect();
      return { cls: `${e.tagName.toLowerCase()}.${(e as HTMLElement).className}`, ellipsis: cs.textOverflow, nowrap: cs.whiteSpace, clipped: (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth, inside: r.right <= side.right + 0.5 };
    }));
    saveEvidence('uix-083-ellipsis.json', spots);
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.every(spot => spot.inside)).toBe(true);
    await page.locator('.workspace-picker').click();
    const menuName = page.locator('.workspace-menu-name strong').filter({ hasText: 'Al-Noor' });
    await expect(menuName).toBeVisible();
    const menu = await menuName.evaluate(el => ({ ellipsis: getComputedStyle(el).textOverflow, clipped: el.scrollWidth > el.clientWidth }));
    await page.keyboard.press('Escape');
    expect(menu).toEqual({ ellipsis: 'ellipsis', clipped: true });
    // Actual: the sidebar workspace switcher wraps the 115-character name over several lines instead of truncating it.
    for (const spot of spots) expect({ cls: spot.cls, ellipsis: spot.ellipsis, nowrap: spot.nowrap }).toEqual({ cls: spot.cls, ellipsis: 'ellipsis', nowrap: 'nowrap' });
  });

  test('UIX-084 Urdu text renders with a real font fallback [documented: Geist has no Arabic script; Chromium falls back to a system Arabic font]', async () => {
    const { page } = s;
    await home(page);
    await openModule(page, 'Sales');
    await page.getByRole('tab', { name: 'Customers' }).click();
    const cell = customerRow(page, F.urduCustomer).locator('td').first();
    await expect(cell).toHaveText(F.urduCustomer);
    await cell.evaluate(el => el.setAttribute('data-qa-urdu', '1'));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-qa-urdu]' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    await cdp.detach();
    saveEvidence('uix-084-urdu-fonts.json', fonts);
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.map(f => f.familyName)).not.toContain('LastResort');
    expect(fonts.filter(f => !/Geist/i.test(f.familyName)).reduce((n, f) => n + f.glyphCount, 0)).toBeGreaterThan(5);
  });

  test('UIX-085 right-to-left text in the left-to-right UI does not break the layout', async () => {
    const { page } = s;
    await home(page);
    await openModule(page, 'Sales');
    await page.getByRole('tab', { name: 'Customers' }).click();
    const urdu = customerRow(page, F.urduCustomer);
    const latin = customerRow(page, F.metro);
    const [u, l] = await Promise.all([urdu, latin].map(row => row.evaluate(tr => ({ h: tr.getBoundingClientRect().height, cells: [...tr.children].map(td => { const r = td.getBoundingClientRect(); return { left: r.left, right: r.right }; }) }))));
    expect(Math.abs(u.h - l.h)).toBeLessThanOrEqual(4);
    expect(u.cells.map(c => Math.round(c.left))).toEqual(l.cells.map(c => Math.round(c.left)));
    for (let i = 1; i < u.cells.length; i++) expect(u.cells[i].left).toBeGreaterThanOrEqual(u.cells[i - 1].right - 0.5);
    const text = await urdu.locator('td').first().evaluate(td => { const range = document.createRange(); range.selectNodeContents(td); const r = range.getBoundingClientRect(); const c = td.getBoundingClientRect(); return { left: r.left, right: r.right, cl: c.left, cr: c.right }; });
    expect(text.left).toBeGreaterThanOrEqual(text.cl);
    expect(text.right).toBeLessThanOrEqual(text.cr);
    await expect(urdu.locator('td').nth(1)).toHaveText('کراچی');
  });
});

// ====================================================================== empty company
test.describe('empty company', () => {
  test('UIX-059 empty states offer a next action [defect]', async ({ browser }) => {
    await writeQaWorkspace(freshBuilder().w);
    const s = await open(browser, { viewport: DESKTOP });
    const bad: string[] = [];
    const seen: string[] = [];
    for (const m of MODULES) {
      await goModule(s.page, m);
      const tabs = await s.page.locator('.main-content [role=tab]').allInnerTexts();
      for (const tab of tabs.length ? tabs : ['']) {
        if (tab) await s.page.locator('.main-content').getByRole('tab', { name: tab, exact: true }).click();
        const states = await s.page.locator('.empty-state:visible').evaluateAll(els => els.map(el => {
          const card = el.closest('.card, section, .stack') ?? el.parentElement!;
          const actions = [...card.querySelectorAll('button:not([disabled]), a[href]')].filter(b => !b.closest('.list-filters, [role=tablist], thead') && !el.contains(b)).map(b => (b as HTMLElement).innerText.trim()).filter(Boolean);
          return { text: (el as HTMLElement).innerText.trim(), inside: !!el.querySelector('button, a[href]'), actions };
        }));
        for (const st of states) {
          seen.push(`${m}${tab ? `/${tab}` : ''}: "${st.text}" → ${st.inside ? 'action inside' : st.actions.join(', ') || 'none'}`);
          // A good-news status ("Nothing needs attention.") needs no action; copy that names the next step counts as one.
          const status = /^(Nothing needs attention|No cheques waiting)\.?$/.test(st.text);
          const namesStep = /\b(Submit|Add|Create|Record|Import|Receive|Approve|Log)\b/.test(st.text);
          if (!status && !namesStep && !st.inside && !st.actions.length) bad.push(`${m}${tab ? `/${tab}` : ''}: "${st.text}"`);
        }
      }
    }
    saveEvidence('uix-059-empty-states.json', { seen, bad });
    // Actual: the generic workbench "No records yet." (Overview, Imports, Commissions, Accounting) offers no way forward
    // (wave 2); Cash & bank activity, the Stock tab and the document lists were fixed under D-73.
    expect(seen.length).toBeGreaterThan(5);
    expect(bad).toEqual([]);
    await s.context.close();
  });
});

// ====================================================================== setup card on a phone
test.describe('setup wizard on a phone', () => {
  async function wizard(browser: Browser, step: 1 | 3) {
    await writeQaWorkspace(setupWorkspace(step));
    const s = await signedInPage(browser, { viewport: PHONE, isMobile: true, hasTouch: true });
    await s.page.goto(`/?tenant=${QA_TENANT}`);
    await s.page.waitForLoadState('networkidle');
    await expect(s.page.locator('.setup-card')).toBeVisible({ timeout: 60_000 });
    await expect(s.page.getByRole('button', { name: /Continue|Create my workspace/ })).toBeEnabled({ timeout: 60_000 });
    return s;
  }

  test('UIX-097 preset pills wrap on phone; descriptions hidden', async ({ browser }) => {
    const s = await wizard(browser, 3);
    const presets = s.page.locator('.module-preset');
    expect(await presets.count()).toBeGreaterThan(1);
    const boxes = await presets.evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), left: r.left, right: r.right }; }));
    expect(Math.max(...boxes.map(b => b.right))).toBeLessThanOrEqual(390);
    expect(Math.min(...boxes.map(b => b.left))).toBeGreaterThanOrEqual(0);
    expect(new Set(boxes.map(b => b.top)).size, 'pills wrap onto more than one row').toBeGreaterThan(1);
    expect(await presets.first().evaluate(e => getComputedStyle(e.parentElement!).flexWrap)).toBe('wrap');
    expect(await s.page.locator('.module-preset small').evaluateAll(els => els.every(e => getComputedStyle(e).display === 'none'))).toBe(true);
    await s.context.close();
  });

  test('UIX-098 module tiles are a single column on phone', async ({ browser }) => {
    const s = await wizard(browser, 3);
    const tiles = await s.page.locator('.module-card').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width), top: Math.round(r.top) }; }));
    expect(tiles.length).toBeGreaterThan(4);
    expect(new Set(tiles.map(t => t.left)).size).toBe(1);
    expect(new Set(tiles.map(t => t.top)).size).toBe(tiles.length);
    expect(Math.min(...tiles.map(t => t.width))).toBeGreaterThan(300);
    await s.context.close();
  });

  test('UIX-099 setup card is full-screen on phone', async ({ browser }) => {
    for (const step of [1, 3] as const) {
      const s = await wizard(browser, step);
      const m = await s.page.locator('.setup-card').evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, radius: getComputedStyle(el).borderTopLeftRadius, vw: window.innerWidth, vh: window.innerHeight, page: document.documentElement.scrollWidth }; });
      saveEvidence(`uix-099-step-${step}.json`, m);
      // D-35: the blurred workspace behind the card used to be 407 px wide because of the top bar.
      expect(m.page, `step ${step}: nothing behind the card widens the page`).toBeLessThanOrEqual(390);
      expect(m.left, `step ${step}`).toBe(0);
      expect(m.top, `step ${step}`).toBe(0);
      expect(m.width, `step ${step}`).toBe(m.vw);
      expect(m.height, `step ${step}`).toBeGreaterThanOrEqual(m.vh - 1);
      expect(m.radius, `step ${step}`).toBe('0px');
      await s.context.close();
    }
  });
});

