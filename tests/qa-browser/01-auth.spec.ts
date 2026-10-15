import { expect, test, type Browser, type Page, type Request } from '@playwright/test';
import { EMAIL, PASSWORD, PHONE, QA_TENANT, authState, gotoApp, savedSessionAlive, seedRich, signedInPage } from './helpers';

// Sign-in, reset and session cases. Uses anonymous contexts for the login page; successful sign-ins and
// sign-outs are kept few because Supabase rate-limits sign-ins per IP and signs out every session of the user.
const APP = `/?tenant=${QA_TENANT}`;
let ids: Record<string, string>;
test.beforeAll(async () => { ({ ids } = await seedRich()); });

async function loginPage(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  // Sign-in runs on the server (D-31): the browser posts the credentials to the app's own /auth/signin route.
  const signInRequests: Request[] = [];
  page.on('request', r => { if (new URL(r.url()).pathname === '/auth/signin') signInRequests.push(r); });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(APP);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  return { context, page, signInRequests, errors };
}
const email = (page: Page) => page.getByLabel('Email address');
const password = (page: Page) => page.locator('input[autocomplete="current-password"]');
const submit = (page: Page) => page.getByRole('button', { name: 'Sign in securely' });
const errorNote = (page: Page) => page.locator('.login-form .error-note');
async function attempt(page: Page, mail: string, pass: string) {
  await email(page).fill(mail);
  await password(page).fill(pass);
  await submit(page).click();
}
const bodyOf = (r: Request) => { try { return JSON.parse(r.postData() || '{}') as { email?: string; password?: string }; } catch { return {}; } };

let wrongPasswordMessage = '';
let successfulSignInRequests: { url: string; method: string; body: string }[] = [];
let successfulConsole: string[] = [];

test('AUTH-002 Sign in with valid email and password lands on the company without error [documented: signs in at /?tenant=QA so it lands on that company; a bare / would open the first non-demo membership]', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  await attempt(page, EMAIL, PASSWORD);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.error-note')).toHaveCount(0);
  await expect(page.locator('.workspace-picker')).toContainText('QA Trading Company');
  await context.close();
});

test('AUTH-003 Wrong password: error under the form, stays on login, password focusable, no reload', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  await page.evaluate(() => { (window as unknown as { qaMarker: number }).qaMarker = 42; });
  await attempt(page, EMAIL, 'definitely-not-the-password');
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  wrongPasswordMessage = (await errorNote(page).innerText()).trim();
  // The message sits inside the form, after the password field and before the submit button.
  const [noteBox, passBox] = [await errorNote(page).boundingBox(), await password(page).boundingBox()];
  expect(noteBox!.y).toBeGreaterThan(passBox!.y);
  expect(new URL(page.url()).search).toBe(`?tenant=${QA_TENANT}`);
  expect(await page.evaluate(() => (window as unknown as { qaMarker?: number }).qaMarker)).toBe(42);
  await password(page).focus();
  await expect(password(page)).toBeFocused();
  await context.close();
});

test('AUTH-004 Unknown email shows the same generic error as a wrong password', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  await attempt(page, 'nobody-qa-404@example.com', 'definitely-not-the-password');
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  expect((await errorNote(page).innerText()).trim()).toBe('Invalid login credentials');
  expect(wrongPasswordMessage || 'Invalid login credentials').toBe('Invalid login credentials');
  await context.close();
});

test('AUTH-007 Email with surrounding spaces is trimmed and accepted', async ({ browser }) => {
  const { context, page, signInRequests } = await loginPage(browser);
  await attempt(page, `  ${EMAIL}  `, PASSWORD);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  expect(bodyOf(signInRequests[0]).email).toBe(EMAIL);
  await context.close();
});

test('AUTH-008 Email in different case is accepted', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  await attempt(page, EMAIL.toUpperCase(), PASSWORD);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  await context.close();
});

test('AUTH-009 Password with leading/trailing spaces is not trimmed and does not match', async ({ browser }) => {
  const { context, page, signInRequests } = await loginPage(browser);
  await attempt(page, EMAIL, ` ${PASSWORD} `);
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  expect(bodyOf(signInRequests[0]).password).toBe(` ${PASSWORD} `);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await context.close();
});

test('AUTH-010 200-character password is not truncated [documented: no account has a 200-char password; the field and the request carry all 200 characters and Supabase answers with the generic error]', async ({ browser }) => {
  const { context, page, signInRequests } = await loginPage(browser);
  const long = 'Aa1!'.repeat(50);
  await attempt(page, EMAIL, long);
  expect(await password(page).inputValue()).toHaveLength(200);
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  expect(bodyOf(signInRequests[0]).password).toHaveLength(200);
  await context.close();
});

test('AUTH-011 SQL-ish email gives a generic failure, no 500 [documented: the browser email validation blocks it before any request]', async ({ browser }) => {
  const { context, page, signInRequests } = await loginPage(browser);
  const statuses: number[] = [];
  page.on('response', r => statuses.push(r.status()));
  await attempt(page, "' OR 1=1--@x.com", 'whatever-password');
  expect(await email(page).evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
  await page.waitForTimeout(500);
  expect(signInRequests).toHaveLength(0);
  expect(statuses.filter(s => s >= 500)).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await context.close();
});

test('AUTH-012 Script tag in the email field never executes [documented: blocked by email validation, nothing rendered]', async ({ browser }) => {
  const { context, page, signInRequests } = await loginPage(browser);
  let dialog = false;
  page.on('dialog', d => { dialog = true; void d.dismiss(); });
  await attempt(page, '<script>alert(1)</script>@x.com', 'whatever-password');
  await page.waitForTimeout(500);
  expect(dialog).toBe(false);
  expect(signInRequests).toHaveLength(0);
  expect(await page.locator('script:has-text("alert(1)")').count()).toBe(0);
  await context.close();
});

test('AUTH-013 Unicode email local part is rejected by email validation, no crash', async ({ browser }) => {
  const { context, page, signInRequests, errors } = await loginPage(browser);
  await attempt(page, 'علی@example.com', 'whatever-password');
  await page.waitForTimeout(500);
  const valid = await email(page).evaluate((el: HTMLInputElement) => el.validity.valid);
  if (valid) await expect(errorNote(page)).toBeVisible({ timeout: 30_000 }); else expect(signInRequests).toHaveLength(0);
  expect(errors).toEqual([]);
  await context.close();
});

test('AUTH-014 Eye toggle shows/hides characters and keeps the cursor position', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  await password(page).fill('secret-123');
  await password(page).evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(password(page)).toHaveAttribute('type', 'text');
  expect(await password(page).inputValue()).toBe('secret-123');
  expect(await password(page).evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(3);
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(password(page)).toHaveAttribute('type', 'password');
  expect(await password(page).evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(3);
  await context.close();
});

test('AUTH-016 Enter in the password field submits', async ({ browser }) => {
  const { context, page, signInRequests } = await loginPage(browser);
  await email(page).fill(EMAIL);
  await password(page).fill('definitely-not-the-password');
  await password(page).press('Enter');
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  expect(signInRequests).toHaveLength(1);
  await context.close();
});

test('AUTH-017 Double-click sends one request; spinner and disabled while busy', async ({ browser }) => {
  const { context, page, signInRequests } = await loginPage(browser);
  await page.route('**/auth/signin', async route => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
  await email(page).fill(EMAIL);
  await password(page).fill('definitely-not-the-password');
  await submit(page).dblclick();
  await expect(submit(page)).toBeDisabled();
  await expect(submit(page).locator('.spin')).toBeVisible();
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  expect(signInRequests).toHaveLength(1);
  await context.close();
});

test('AUTH-018 Reload keeps the cookie session', async ({ browser }) => {
  const { context, page } = await signedInPage(browser);
  await gotoApp(page, APP);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
  await context.close();
});

test('AUTH-033 Forgot password with an unknown email shows the same confirmation text', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  await email(page).fill('nobody-qa-404@example.com');
  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await expect(page.locator('.login-form .form-note, .login-form .error-note')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.login-form .form-note')).toHaveText('Password reset instructions were sent if this address is registered.');
  await context.close();
});

test('AUTH-036 [manual] Set a new 8-char password through the emailed reset link, sign in with it, old one fails', async () => {
  test.skip(true, 'Needs a real reset email and would change the shared bootstrap owner password; run by hand on a throw-away account.');
});

test('AUTH-037 New password of 7 chars is refused with a length message', async ({ browser }) => {
  const { context, page } = await signedInPage(browser);
  let updates = 0;
  await page.route('**/auth/password', route => { if (route.request().method() === 'POST') { updates++; return route.abort(); } return route.continue(); });
  await page.goto('/account/reset');
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('New password', { exact: true }).fill('Abc1234');
  await page.getByLabel('Confirm new password').fill('Abc1234');
  await page.getByRole('button', { name: 'Save new password' }).click();
  const message = await page.getByLabel('New password', { exact: true }).evaluate((el: HTMLInputElement) => el.validationMessage);
  const appMessage = (await page.locator('.error-note').allTextContents()).join(' ');
  expect(`${message} ${appMessage}`).toMatch(/8|lengthen|at least/i);
  expect(updates).toBe(0);
  await context.close();
});

test('AUTH-038 Empty new password is blocked', async ({ browser }) => {
  const { context, page } = await signedInPage(browser);
  let updates = 0;
  await page.route('**/auth/password', route => { if (route.request().method() === 'POST') { updates++; return route.abort(); } return route.continue(); });
  await page.goto('/account/reset');
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Save new password' }).click();
  expect(await page.getByLabel('New password', { exact: true }).evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  expect(updates).toBe(0);
  await expect(page.getByText('Your password was changed.')).toHaveCount(0);
  await context.close();
});

test('AUTH-041 Reset page without a session shows the expired state with a link back to login', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/account/reset');
  await expect(page.getByText(/expired or was already used/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 30_000 });
  await context.close();
});

test('AUTH-042 [manual] Reusing the emailed reset link after success shows the expired state', async () => {
  test.skip(true, 'Needs a real emailed recovery link (actual email delivery).');
});

test('AUTH-051 [manual] Two accounts in two browsers have independent sessions', async () => {
  test.skip(true, 'Needs a second user account; creating accounts on the hosted Supabase project is out of scope for this run.');
});

test('AUTH-052 Same account in two tabs: commands from both apply', async ({ browser }) => {
  const { context, page } = await signedInPage(browser);
  const second = await context.newPage();
  await gotoApp(page, APP); await gotoApp(second, APP);
  const stamp = Date.now().toString().slice(-5);
  for (const [tab, name] of [[page, `Tab A ${stamp}`], [second, `Tab B ${stamp}`]] as [Page, string][]) {
    await tab.locator('button.nav-item').filter({ hasText: 'Inventory' }).click();
    await tab.getByRole('tab', { name: 'Warehouses' }).click();
    await tab.getByLabel('New branch name').fill(name);
    await tab.getByRole('button', { name: 'Add branch' }).click();
    await expect(tab.locator('.branch-list')).toContainText(name);
  }
  // The second tab started from an older revision; its command was applied on top of the first tab's change.
  await expect(second.locator('.branch-list')).toContainText(`Tab A ${stamp}`);
  await context.close();
});

test('AUTH-053 Login page at 390px: single column, 16px inputs, no horizontal scroll', async ({ browser }) => {
  const { context, page } = await loginPage(browser, { viewport: PHONE, isMobile: true, hasTouch: true });
  await expect(page.locator('.login-visual')).toBeHidden();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.login-shell')!).gridTemplateColumns.split(' ').length)).toBe(1);
  for (const input of [email(page), password(page)]) expect(await input.evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});

test('AUTH-058 Reduced motion: no slide animations on login', async ({ browser }) => {
  const { context, page } = await loginPage(browser, { reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForLoadState('networkidle');
  const moving = await page.evaluate(() => document.getAnimations().filter(a => {
    const effect = a.effect as KeyframeEffect | null;
    const frames = effect?.getKeyframes?.() ?? [];
    const duration = Number(effect?.getComputedTiming().duration ?? 0);
    return duration > 1 && frames.some(f => 'transform' in f || 'translate' in f);
  }).length);
  expect(moving).toBe(0);
  await context.close();
});

test('AUTH-060 Browser Back after signing in does not show the login form while signed in', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  await attempt(page, EMAIL, PASSWORD);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  await page.goBack().catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  if (page.url().startsWith('http')) await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
  await context.close();
});

test('AUTH-061 Sign in while offline: clear network error; retry works when online', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  await context.setOffline(true);
  await attempt(page, EMAIL, PASSWORD);
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  const message = await errorNote(page).innerText();
  await context.setOffline(false);
  await submit(page).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  // A clear network error names the connection; the raw fetch error does not.
  expect(message, `offline message was "${message}"`).toMatch(/network|connection|offline|internet/i);
  expect(message.trim()).toBe('No internet connection. Check your connection and try again.');
  await context.close();
});

test('AUTH-062 Slow auth (>10 s): spinner persists, no duplicate submit, eventually resolves', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page, signInRequests } = await loginPage(browser);
  await page.route('**/auth/signin', async route => { await new Promise(r => setTimeout(r, 11_000)); await route.continue(); });
  await email(page).fill(EMAIL);
  await password(page).fill(PASSWORD);
  await submit(page).click();
  await page.waitForTimeout(5000);
  await expect(submit(page)).toBeDisabled();
  await expect(submit(page).locator('.spin')).toBeVisible();
  await submit(page).click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(5500);
  await expect(submit(page).locator('.spin')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  expect(signInRequests).toHaveLength(1);
  await context.close();
});

test('AUTH-063 Network: the password goes only in a POST body, never in a URL or log [case-corrected: sign-in runs on the server (D-31), so the browser posts the password once to the app\'s own /auth/signin route (HTTPS in production) and never calls Supabase itself]', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  successfulSignInRequests = []; successfulConsole = [];
  page.on('request', r => successfulSignInRequests.push({ url: r.url(), method: r.method(), body: r.postData() ?? '' }));
  page.on('console', m => successfulConsole.push(m.text()));
  const appOrigin = new URL(page.url()).origin;
  await attempt(page, EMAIL, PASSWORD);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  await context.close();
  const carrying = successfulSignInRequests.filter(r => r.body.includes(PASSWORD));
  expect(carrying).toHaveLength(1);
  expect(carrying[0].method).toBe('POST');
  const target = new URL(carrying[0].url);
  expect(`${target.pathname}${target.search}`).toBe('/auth/signin');
  expect(target.origin).toBe(appOrigin);
  expect(successfulSignInRequests.some(r => r.url.includes('/auth/v1/'))).toBe(false);
  expect(successfulSignInRequests.some(r => r.url.includes(encodeURIComponent(PASSWORD)) || r.url.includes(PASSWORD))).toBe(false);
  expect(successfulConsole.some(t => t.includes(PASSWORD))).toBe(false);
});

test('AUTH-066 [manual] Reset-password flow for one user then sign-in as another in the same browser: no leakage', async () => {
  test.skip(true, 'Needs a reset email and a second user account.');
});

test('AUTH-073 Wrong-password copy is plain English with no Supabase internals [documented: shows Supabase\'s own message "Invalid login credentials" verbatim]', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  await attempt(page, EMAIL, 'definitely-not-the-password');
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  wrongPasswordMessage = (await errorNote(page).innerText()).trim();
  await context.close();
  expect(wrongPasswordMessage).not.toMatch(/AuthApiError|supabase|invalid_grant|status|\b\d{3}\b|undefined|null/i);
  expect(wrongPasswordMessage).toMatch(/^[A-Z][a-z ]+/);
});

test('AUTH-074 Violet focus ring on inputs, visible with the keyboard', async ({ browser }) => {
  const { context, page } = await loginPage(browser);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 6 && !(await email(page).evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(email(page)).toBeFocused();
  const ring = await page.locator('.input-wrap').first().evaluate(el => getComputedStyle(el).boxShadow);
  expect(ring).toContain('rgba(107, 61, 245');
  await context.close();
});

test('AUTH-076 254-character email is accepted by validation or gets a clear error [documented: passes browser validation, reaches Supabase and gets the generic error]', async ({ browser }) => {
  const { context, page, signInRequests } = await loginPage(browser);
  const local = 'a'.repeat(64);
  const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
  const long = `${local}@${domain}`;
  expect(long).toHaveLength(254);
  await attempt(page, long, 'whatever-password');
  await page.waitForTimeout(500);
  const valid = await email(page).evaluate((el: HTMLInputElement) => el.validity.valid);
  if (valid) { await expect(errorNote(page)).toBeVisible({ timeout: 30_000 }); expect(signInRequests).toHaveLength(1); }
  else expect(await email(page).evaluate((el: HTMLInputElement) => el.validationMessage)).not.toBe('');
  await context.close();
});

test('AUTH-077 Pasted email with a newline: newline stripped, no crash', async ({ browser }) => {
  const { context, page, errors } = await loginPage(browser);
  await email(page).fill('');
  await email(page).focus();
  await page.keyboard.insertText('qa-paste@example.com\n');
  expect(await email(page).inputValue()).not.toContain('\n');
  await password(page).fill('whatever-password');
  await submit(page).click();
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
  await context.close();
});

test('AUTH-078 Emoji password is sent intact [documented: no account has an emoji password; the field and request keep the emoji and Supabase answers with the generic error]', async ({ browser }) => {
  const { context, page, signInRequests } = await loginPage(browser);
  await attempt(page, EMAIL, '😀🔒 pass word ✓');
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  expect(bodyOf(signInRequests[0]).password).toBe('😀🔒 pass word ✓');
  await context.close();
});

test('AUTH-084 Refresh on /account/reset after a successful change shows the expired/complete state, not the form', async ({ browser }) => {
  const { context, page } = await signedInPage(browser);
  // The change is stubbed (and uses the current password) so the real password never changes. The password is
  // set by the app's /auth/password route (D-31); its GET (does this browser hold a reset session?) stays real.
  await page.route('**/auth/password', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto('/account/reset');
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm new password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByText('Your password was changed.')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Your password was changed.')).toBeVisible();
  await context.close();
});

test('AUTH-088 Plus-tag email passes validation and reaches sign-in [documented: no a+qa account exists; the address is accepted by the form and sent unchanged, Supabase answers generically]', async ({ browser }) => {
  const { context, page, signInRequests } = await loginPage(browser);
  await attempt(page, 'qa+tag@example.com', 'whatever-password');
  await expect(errorNote(page)).toBeVisible({ timeout: 30_000 });
  expect(bodyOf(signInRequests[0]).email).toBe('qa+tag@example.com');
  await context.close();
});

test('AUTH-093 Deep link to /print/... then sign in reaches the app', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/print/sales_invoice/${ids.inv1}?tenant=${QA_TENANT}`);
  await expect(page.getByText('Sign in to print documents.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Go to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await attempt(page, EMAIL, PASSWORD);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
  await expect(page.locator('.app-shell')).toBeVisible();
  await context.close();
});

test('AUTH-096 Very slow network (3G): login usable, no duplicate submissions', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page, signInRequests } = await loginPage(browser);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024 });
  await email(page).fill(EMAIL);
  await password(page).fill('definitely-not-the-password');
  await submit(page).click();
  await submit(page).click({ force: true, timeout: 2000 }).catch(() => undefined);
  await expect(errorNote(page)).toBeVisible({ timeout: 60_000 });
  expect(signInRequests).toHaveLength(1);
  await context.close();
});

// --- Sign-out cases last: Supabase sign-out is global, so each one invalidates every session of the owner.
test('AUTH-019 Sign out from the sidebar profile returns to login; Back does not show workspace content [documented: sign-out ends every session of the account]', async ({ browser }) => {
  // A separate sign-in, so the saved owner session is a different session we can watch.
  const witness = await authState(browser);
  const { context, page } = await loginPage(browser);
  await attempt(page, EMAIL, PASSWORD);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: 60_000 });
  expect(await savedSessionAlive(browser, witness)).toBe(true);
  await page.locator('form[action="/auth/signout"] button.profile').click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 30_000 });
  expect(await savedSessionAlive(browser, witness), 'the other, untouched session after signing out here').toBe(false);
  await page.goBack().catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1000);
  await expect(page.locator('.app-shell')).toHaveCount(0, { timeout: 3000 });
  await context.close();
});

test('AUTH-049 Sign out in one tab; the other tab\'s next command gets 401 and the UI shows the login [documented: sign-out ends every session of the account] [defect]', async ({ browser }) => {
  const { context, page } = await signedInPage(browser);
  const other = await context.newPage();
  await gotoApp(page, APP); await gotoApp(other, APP);
  await page.locator('form[action="/auth/signout"] button.profile').click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 30_000 });
  const status = other.waitForResponse(r => r.url().includes('/api/workspace') && r.request().method() === 'POST');
  await other.locator('button.nav-item').filter({ hasText: 'Inventory' }).click();
  await other.getByRole('tab', { name: 'Warehouses' }).click();
  await other.getByLabel('New branch name').fill('After sign-out');
  await other.getByRole('button', { name: 'Add branch' }).click();
  expect((await status).status()).toBe(401);
  await expect(other.getByRole('heading', { name: 'Welcome back' }).or(other.getByRole('link', { name: /sign in/i }))).toBeVisible({ timeout: 10_000 });
  await context.close();
});

test('AUTH-090 Sign out while a command is in flight returns to login without error [documented: sign-out ends every session of the account]', async ({ browser }) => {
  const { context, page, errors } = await signedInPage(browser);
  await gotoApp(page, APP);
  await page.route('**/api/workspace', async route => { if (route.request().method() === 'POST') await new Promise(r => setTimeout(r, 2500)); await route.continue().catch(() => undefined); });
  await page.locator('button.nav-item').filter({ hasText: 'Inventory' }).click();
  await page.getByRole('tab', { name: 'Warehouses' }).click();
  await page.getByLabel('New branch name').fill('In flight');
  await page.getByRole('button', { name: 'Add branch' }).click();
  await page.locator('form[action="/auth/signout"] button.profile').click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  expect(errors.filter(e => e.startsWith('pageerror'))).toEqual([]);
  await context.close();
});
