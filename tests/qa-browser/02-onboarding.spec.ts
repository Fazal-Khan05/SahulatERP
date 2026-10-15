import { expect, test, type Browser, type Page } from '@playwright/test';
import { DESKTOP, PHONE, QA_TENANT, gotoApp, richWorkspace, setupWorkspace, signedInPage, writeQaWorkspace } from './helpers';
import type { ToggleModule } from '../../src/modules/erp/types';

// Setup wizard: every test writes the wizard state it needs into the QA tenant, then opens the card.
const APP = `/?tenant=${QA_TENANT}`;
const DEMO_TENANT = '11111111-1111-4111-8111-111111111111';
const card = (page: Page) => page.locator('.setup-card');
const heading = (page: Page) => page.locator('#setup-title');

async function openWizard(browser: Browser, step: 1 | 2 | 3 | 4, options: Parameters<Browser['newContext']>[0] = {}, modules?: ToggleModule[]) {
  await writeQaWorkspace(setupWorkspace(step, modules));
  const session = await signedInPage(browser, options);
  await session.page.goto(APP);
  await session.page.waitForLoadState('networkidle');
  await expect(card(session.page)).toBeVisible({ timeout: 60_000 });
  await expect(session.page.getByRole('button', { name: /Continue|Create my workspace/ })).toBeEnabled({ timeout: 60_000 });
  return session;
}
const animationsOf = (page: Page, selector: string) => page.evaluate(sel => document.getAnimations().filter(a => (a.effect as KeyframeEffect)?.target instanceof Element && ((a.effect as KeyframeEffect).target as Element).matches(sel)).map(a => ({ name: (a as CSSAnimation).animationName, frames: JSON.stringify((a.effect as KeyframeEffect).getKeyframes()) })), selector);

test('ONB-016 Back from step 2 shows the saved step-1 values with a slide-left transition', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 1);
  await page.getByLabel('Company name').fill('Back Test Traders');
  await page.getByLabel('Address').fill('7 Saddar, Karachi');
  await page.getByLabel('Phone').fill('+92 300 7654321');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(heading(page)).toHaveText('Documents', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(heading(page)).toHaveText('Company');
  await expect(page.locator('.setup-body')).toHaveClass(/step-back/);
  expect((await animationsOf(page, '.setup-body')).map(a => a.name)).toContain('step-back');
  await expect(page.getByLabel('Company name')).toHaveValue('Back Test Traders');
  await expect(page.getByLabel('Address')).toHaveValue('7 Saddar, Karachi');
  await expect(page.getByLabel('Phone')).toHaveValue('+92 300 7654321');
  await context.close();
});

test('ONB-044 Selected feature tile has a violet outline and a lifted shadow', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 3);
  await page.getByRole('switch', { name: 'Payroll module' }).uncheck();
  const on = page.locator('.module-card.enabled').first();
  const off = page.locator('.module-card:not(.enabled)').first();
  await expect(on).toBeVisible();
  const [onStyle, offStyle] = await Promise.all([on, off].map(l => l.evaluate(el => { const s = getComputedStyle(el); return { border: s.borderColor, shadow: s.boxShadow }; })));
  expect(onStyle.border).toBe('rgb(107, 61, 245)');
  expect(onStyle.shadow).toContain('rgb(107, 61, 245)');
  expect(onStyle.shadow).toMatch(/rgba\(18, 43, 165/);
  expect(offStyle.shadow).not.toContain('rgb(107, 61, 245)');
  await context.close();
});

test('ONB-047 Edit from Review → step 1, change the name, continue through; Review shows the change', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 4);
  await page.locator('.wizard-review section').filter({ hasText: 'Shown on every document' }).getByRole('button', { name: 'Edit' }).click();
  await expect(heading(page)).toHaveText('Company');
  await page.getByLabel('Company name').fill('Renamed Review Traders');
  for (const next of ['Documents', 'Features', 'Review']) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(heading(page)).toHaveText(next, { timeout: 30_000 });
  }
  await expect(page.locator('.review-list').first()).toContainText('Renamed Review Traders');
  await context.close();
});

test('ONB-048 "Create my workspace" shows the provisioning ring, "Setting up {company}" and staggered lines for at least 2.6 s', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 4);
  const started = Date.now();
  await page.getByRole('button', { name: 'Create my workspace' }).click();
  await expect(page.locator('.setup-provisioning')).toBeVisible();
  await expect(page.locator('.provision-ring')).toBeVisible();
  await expect(heading(page)).toHaveText('Setting up QA Trading Company');
  const delays = await page.locator('.provision-lines li').evaluateAll(lis => lis.map(li => parseFloat(getComputedStyle(li).animationDelay)));
  expect(delays.length).toBeGreaterThan(2);
  for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.setup-layer')).toHaveCount(0);
  expect(Date.now() - started).toBeGreaterThanOrEqual(2600);
  await context.close();
});

test('ONB-060 Provisioning lines = selected modules + "Opening your books" + "Preparing your workspace"', async ({ browser }) => {
  const modules: ToggleModule[] = ['sales', 'inventory', 'collections', 'reports'];
  const { context, page } = await openWizard(browser, 4, {}, modules);
  await page.getByRole('button', { name: 'Create my workspace' }).click();
  await expect(page.locator('.setup-provisioning')).toBeVisible();
  const lines = await page.locator('.provision-lines li').allInnerTexts();
  expect(lines.map(l => l.trim())).toEqual(['Setting up Sales', 'Setting up Inventory', 'Setting up Collections & PDCs', 'Setting up Reports', 'Opening your books', 'Preparing your workspace']);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  await context.close();
});

test('ONB-061 Reduced motion: provisioning lines appear without stagger and the ring turns slowly', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 4, { reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Create my workspace' }).click();
  await expect(page.locator('.setup-provisioning')).toBeVisible();
  const delays = await page.locator('.provision-lines li').evaluateAll(lis => lis.map(li => getComputedStyle(li).animationDelay));
  expect(new Set(delays)).toEqual(new Set(['0s']));
  const ring = await page.locator('.provision-ring').evaluate(el => { const s = getComputedStyle(el); return { duration: s.animationDuration, count: s.animationIterationCount }; });
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  await context.close();
  // "Slow" ring: a multi-second rotation that keeps turning (D-53: its rule is !important so the universal reduced-motion reset cannot freeze it).
  expect(ring, `ring animation under reduced motion: ${JSON.stringify(ring)}`).toEqual({ duration: '3s', count: 'infinite' });
});

test('ONB-066 Global search excludes records of modules that are off', async ({ browser }) => {
  await writeQaWorkspace(richWorkspace({ hide: ['purchasing', 'imports'] }).w);
  const { context, page } = await signedInPage(browser);
  await gotoApp(page, APP);
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('dialog', { name: 'Search' });
  for (const off of ['Ningbo Exports', 'PO-2026', 'BILL-2026', 'Karachi Packaging']) {
    await search.getByLabel('Search the workspace').fill(off);
    await expect(search.getByText(/No matches for/)).toBeVisible();
  }
  await search.getByLabel('Search the workspace').fill('Ali Traders');
  await expect(search.getByRole('listitem').first()).toBeVisible();
  await context.close();
});

test('ONB-067 Setup card at 390 px: full screen, numbered steps except the current one, sticky footer, no horizontal scroll', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 2, { viewport: PHONE, isMobile: true, hasTouch: true });
  const box = await card(page).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(PHONE.height - 1);
  const titles = await page.locator('.setup-steps li').evaluateAll(lis => lis.map(li => ({ current: li.classList.contains('current'), shown: getComputedStyle(li.querySelector('.setup-step-title')!).display !== 'none', index: li.querySelector('.setup-step-index')!.textContent })));
  for (const t of titles) expect(t.shown).toBe(t.current);
  expect(await page.locator('.setup-actions').evaluate(el => getComputedStyle(el).position)).toBe('sticky');
  // D-35: nothing behind or inside the card (top bar, invoice preview) widens the page past the 390 px screen.
  const widths = await page.evaluate(() => ({ card: Math.round(document.querySelector('.setup-card')!.getBoundingClientRect().width), page: document.documentElement.scrollWidth, screen: screen.width }));
  await context.close();
  expect(widths, JSON.stringify(widths)).toEqual({ card: 390, page: 390, screen: 390 });
});

test('ONB-068 Setup card on iPad portrait: centred with scrim [case-corrected: the Documents step stacks the preview under the form below 1000 px, so iPad portrait shows one column]', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 2, { viewport: { width: 768, height: 1024 }, hasTouch: true });
  const box = (await card(page).boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 384)).toBeLessThan(2);
  expect(box.width).toBeLessThan(768);
  expect(await page.locator('.setup-layer').evaluate(el => getComputedStyle(el).backgroundImage)).toContain('rgba(16, 31, 82');
  const columns = await page.locator('.branding-layout').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(1);
  const [controls, preview] = [await page.locator('.branding-controls').boundingBox(), await page.locator('.branding-preview').boundingBox()];
  expect(preview!.y).toBeGreaterThanOrEqual(controls!.y + controls!.height - 1);
  await context.close();
});

test('ONB-069 Documents step on phone: preview below the form, scrollable inside the card', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 2, { viewport: PHONE, isMobile: true, hasTouch: true });
  const [controls, preview] = [await page.locator('.branding-controls').boundingBox(), await page.locator('.branding-preview').boundingBox()];
  expect(preview!.y).toBeGreaterThanOrEqual(controls!.y + controls!.height - 1);
  const scroll = await card(page).evaluate(el => ({ sh: el.scrollHeight, ch: el.clientHeight, overflow: getComputedStyle(el).overflowY }));
  expect(scroll.overflow).toBe('auto');
  expect(scroll.sh).toBeGreaterThan(scroll.ch);
  await card(page).evaluate(el => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.locator('.branding-preview')).toBeInViewport();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  await context.close();
  expect(width, 'page width at 390 px').toBeLessThanOrEqual(390);
});

test('ONB-070 Backdrop: dashboard visible but blurred, not clickable, not focusable (inert)', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 1);
  const shell = page.locator('.app-shell');
  await expect(shell).toHaveAttribute('inert', '');
  expect(await shell.evaluate(el => getComputedStyle(el).filter)).toContain('blur(7px)');
  expect(await page.evaluate(() => document.elementFromPoint(20, 450)?.closest('.app-shell') === null)).toBe(true);
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.app-shell'))).toBe(false);
  }
  await context.close();
});

test('ONB-072 Switching company from the wizard footer navigates with ?tenant and keeps the first company\'s wizard state', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 2);
  const link = page.locator('.setup-foot a').filter({ hasText: 'Sahulat Trading Co.' });
  await expect(link).toHaveAttribute('href', `/?tenant=${DEMO_TENANT}`);
  await link.click();
  await page.waitForURL(`**/?tenant=${DEMO_TENANT}`);
  await expect(page.locator('.workspace-picker')).toContainText('Sahulat Trading Co.', { timeout: 60_000 });
  await page.goto(APP);
  await expect(card(page)).toBeVisible({ timeout: 60_000 });
  await expect(heading(page)).toHaveText('Documents');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('Company name')).toHaveValue('QA Trading Company');
  await context.close();
});

test('ONB-074 Escape on the setup card does nothing', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 2);
  await page.getByLabel('Upload logo').focus().catch(() => undefined);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeVisible();
  await expect(heading(page)).toHaveText('Documents');
  await context.close();
});

test('ONB-085 Step transition: forward slides in from the right, back from the left', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 2);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(heading(page)).toHaveText('Features', { timeout: 30_000 });
  await expect(page.locator('.setup-body')).toHaveClass(/step-forward/);
  const forward = await page.evaluate(() => [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } }).find(r => r instanceof CSSKeyframesRule && r.name === 'step-forward')?.cssText ?? '');
  expect(forward).toMatch(/translateX?\(24px\)/); // the production CSS minifier writes translateX(24px) as translate(24px)
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.setup-body')).toHaveClass(/step-back/);
  const back = await page.evaluate(() => [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } }).find(r => r instanceof CSSKeyframesRule && r.name === 'step-back')?.cssText ?? '');
  expect(back).toMatch(/translateX?\(-24px\)/);
  expect(await page.locator('.setup-body').evaluate(el => getComputedStyle(el).animationName)).toBe('step-back');
  await context.close();
});

test('ONB-088 Owner finishes setup while a second session is on the card; that session\'s next action shows the workspace [documented: simulated with the same owner in a second browser context; no second member account]', async ({ browser }) => {
  const first = await openWizard(browser, 4);
  const second = await signedInPage(browser);
  await second.page.goto(APP);
  await expect(card(second.page)).toBeVisible({ timeout: 60_000 });
  await expect(second.page.getByRole('button', { name: 'Create my workspace' })).toBeEnabled({ timeout: 60_000 });
  await first.page.getByRole('button', { name: 'Create my workspace' }).click();
  await expect(first.page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  // The stale card's natural next action on Review.
  await second.page.getByRole('button', { name: 'Create my workspace' }).click();
  await second.page.waitForTimeout(5000);
  const state = { overview: await second.page.getByRole('heading', { name: 'Overview' }).isVisible(), card: await card(second.page).count(), error: (await second.page.locator('.setup-card .error-note').allInnerTexts()).join(' ') };
  await first.context.close(); await second.context.close();
  expect(state, JSON.stringify(state)).toMatchObject({ overview: true, card: 0 });
});

test('ONB-093 Logo upload while offline shows a clear error and can be retried', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 2);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await context.setOffline(true);
  await page.getByLabel('Upload logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
  const error = page.locator('.branding-controls .error-note');
  await expect(error).toBeVisible({ timeout: 30_000 });
  const message = await error.innerText();
  await context.setOffline(false);
  await page.getByLabel('Upload logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('button', { name: 'Replace logo' })).toBeVisible({ timeout: 30_000 });
  await context.close();
  expect(message, `offline upload message was "${message}"`).toMatch(/network|connection|offline|internet/i);
});

test('ONB-099 All features on a slow connection: provisioning completes and the sidebar is never half-provisioned', async ({ browser }) => {
  test.setTimeout(180_000);
  const all: ToggleModule[] = ['sales', 'purchasing', 'inventory', 'imports', 'collections', 'cashbank', 'commissions', 'payroll', 'reports'];
  const { context, page } = await openWizard(browser, 4, {}, all);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: 100 * 1024, uploadThroughput: 50 * 1024 });
  await page.getByRole('button', { name: 'Create my workspace' }).click();
  const seen = new Set<number>();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({ setup: !!document.querySelector('.setup-layer'), items: document.querySelectorAll('button.nav-item').length }));
    if (!state.setup) seen.add(state.items);
    if (!state.setup && await page.getByRole('heading', { name: 'Overview' }).isVisible()) break;
    await page.waitForTimeout(100);
  }
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  expect([...seen]).toEqual([12]);
  await context.close();
});

// Last: signing out is global for the owner.
test('ONB-073 Sign out from the wizard returns to the login screen [documented: sign-out ends every session of the account]', async ({ browser }) => {
  const { context, page } = await openWizard(browser, 3);
  await page.locator('.setup-foot').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 30_000 });
  await context.close();
});

void DESKTOP;
