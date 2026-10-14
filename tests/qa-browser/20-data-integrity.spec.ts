import { expect, test, type FullConfig } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import globalSetup from '../e2e/global-setup';
import { DESKTOP, QA_TENANT, gotoApp, openModule, post, readWorkspaceApi, richWorkspace, saveEvidence, signedInPage, writeQaWorkspace } from './helpers';

// Data integrity in the browser: big-company load time, a browser that dies mid-command, suite independence and warm-up.

test('DAT-051 page load with 10,000 documents is under 4 s [documented: 9,9xx extra documents are drafts cloned from an engine-built draft (no postings, so the ledger stays balanced); a 10k-document company cannot be built command-by-command in test time]', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const { w, ids } = richWorkspace();
  const draft = w.documents.find(d => d.id === ids.draftInv)!;
  for (let i = w.documents.length, n = 10001; i < 10_000; i++, n++) {
    w.documents.push({ ...structuredClone(draft), id: randomUUID(), number: `INV-2026-${n}`, lines: draft.lines.map(l => ({ ...structuredClone(l), id: randomUUID() })) });
  }
  expect(w.documents).toHaveLength(10_000);
  await writeQaWorkspace(w);
  const s = await signedInPage(browser, { viewport: DESKTOP });
  await gotoApp(s.page); // first load warms the server for this tenant
  const times: { ready: number; load: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await gotoApp(s.page);
    const ready = Date.now() - t0;
    times.push({ ready, load: await s.page.evaluate(() => Math.round((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventEnd)) });
  }
  await openModule(s.page, 'Sales');
  const sales = w.documents.filter(d => ['quotation', 'sales_order', 'delivery', 'sales_invoice', 'credit_note'].includes(d.kind)).length;
  await expect(s.page.locator('section.card').first().locator('.card-heading p')).toHaveText(`${sales} of ${sales} documents`);
  times.sort((a, b) => a.ready - b.ready);
  saveEvidence('dat-051-10k-load-ms.json', times);
  expect(s.errors).toEqual([]);
  expect(times[1].ready, 'median time to a usable, hydrated Overview').toBeLessThan(4000);
  await s.context.close();
});

test('DAT-058 browser closed mid-command: the server completes and a reload shows the result [defect]', async ({ browser }) => {
  const { w, ids } = richWorkspace();
  await writeQaWorkspace(w);
  const number = w.documents.find(d => d.id === ids.draftInv)!.number;
  const s = await signedInPage(browser, { viewport: DESKTOP });
  await gotoApp(s.page);
  await openModule(s.page, 'Sales');
  const row = s.page.locator('section.card').first().locator('tbody tr').filter({ has: s.page.getByRole('cell', { name: number, exact: true }) });
  await expect(row.locator('.badge')).toHaveText('draft');
  let answered = false;
  s.page.on('response', r => { if (r.url().includes('/api/workspace') && r.request().method() === 'POST') answered = true; });
  const sent = s.page.waitForRequest(r => r.url().includes('/api/workspace') && r.method() === 'POST');
  await row.getByRole('button', { name: 'Submit', exact: true }).click();
  const request = await sent;
  expect(request.postDataJSON()).toMatchObject({ type: 'submit_document', payload: { id: ids.draftInv } });
  await s.page.waitForTimeout(150); // the request is on the wire; the server has not answered yet
  expect(answered, 'closed before the server answered').toBe(false);
  await s.context.close();
  // A fresh browser: the server should have finished the command on its own.
  // Actual: the handler reads the session and workspace before it reads the request body, so a browser that goes away in
  // that window aborts the body and the command is dropped; the invoice stays a draft.
  const again = await signedInPage(browser, { viewport: DESKTOP });
  await expect.poll(async () => (await readWorkspaceApi(again.context.request)).documents.find(d => d.id === ids.draftInv)?.status, { timeout: 30_000 }).toBe('submitted');
  await gotoApp(again.page);
  await openModule(again.page, 'Sales');
  await expect(again.page.locator('section.card').first().locator('tbody tr').filter({ has: again.page.getByRole('cell', { name: number, exact: true }) }).locator('.badge')).toHaveText('submitted');
  const after = await readWorkspaceApi(again.context.request);
  expect(after.documents.filter(d => d.number === number)).toHaveLength(1); // applied once
  await again.context.close();
});

test('DAT-088 Playwright suites pass in any order [documented: re-runs this pack\'s UI file and then its print file, each alone in a child Playwright run (the reverse of the default 16 → 19 order), and compares every outcome with its tag: defect-tagged tests fail, manual-tagged tests skip, the rest pass]', async () => {
  test.skip(!!process.env.QA_NESTED, 'already inside the order check');
  test.setTimeout(45 * 60_000);
  const outcomes: Record<string, string> = {};
  const mismatches: string[] = [];
  for (const file of ['tests/qa-browser/19-ui-accessibility.spec.ts', 'tests/qa-browser/16-printing.spec.ts']) {
    const json = join(tmpdir(), `qa-order-${QA_TENANT}-${file.split('/').pop()}.json`);
    rmSync(json, { force: true });
    spawnSync('npx', ['playwright', 'test', '--config', 'playwright.qa.config.ts', '--output', 'test-results/qa-browser-print-ui-order', '--trace', 'off', file], {
      cwd: process.cwd(), stdio: 'ignore', timeout: 40 * 60_000,
      env: { ...process.env, QA_NESTED: '1', QA_PW_JSON: json },
    });
    expect(existsSync(json), `${file} produced results`).toBe(true);
    type Suite = { specs?: { title: string; tests: { status: string }[] }[]; suites?: Suite[] };
    const walk = (suite: Suite) => { for (const spec of suite.specs ?? []) outcomes[spec.title] = spec.tests[0].status; for (const child of suite.suites ?? []) walk(child); };
    for (const suite of JSON.parse(readFileSync(json, 'utf8')).suites as Suite[]) walk(suite);
  }
  for (const [title, status] of Object.entries(outcomes)) {
    const want = /\[manual\]/.test(title) ? 'skipped' : /\[defect\]/.test(title) ? 'unexpected' : 'expected';
    if (status !== want) mismatches.push(`${title.slice(0, 60)}: ${status}, expected ${want}`);
  }
  saveEvidence('dat-088-order.json', { outcomes, mismatches });
  expect(Object.keys(outcomes).length).toBeGreaterThan(45);
  expect(mismatches).toEqual([]);
});

test('DAT-089 global warm-up hits the compile-prone routes so no request gets a 500 [documented: the server under test is a production build, so there is no on-demand compile to provoke; the warm-up is wired in the config and every route it touches answers below 500]', async ({ browser, request }, testInfo) => {
  const config = readFileSync('playwright.qa.config.ts', 'utf8');
  expect(config).toContain("globalSetup: './tests/e2e/global-setup.ts'");
  const source = readFileSync('tests/e2e/global-setup.ts', 'utf8');
  const routes = [...source.matchAll(/'(\/[^']*)'/g)].map(m => m[1]);
  expect(routes).toEqual(expect.arrayContaining(['/', '/api/workspace', '/account/reset', '/api/branding/logo']));
  expect(routes.some(r => r.startsWith('/print/'))).toBe(true);
  const baseURL = testInfo.project.use.baseURL!;
  await globalSetup({ projects: [{ use: { baseURL } }] } as unknown as FullConfig);
  const statuses: Record<string, number> = {};
  for (const route of routes) statuses[route] = (await request.get(route, { maxRedirects: 0 })).status();
  saveEvidence('dat-089-warmup.json', statuses);
  for (const [route, status] of Object.entries(statuses)) expect(status, route).toBeLessThan(500);
  // The first signed-in command after warm-up is applied, not lost to a 500.
  await writeQaWorkspace(richWorkspace().w);
  const s = await signedInPage(browser);
  const w = await readWorkspaceApi(s.context.request);
  const result = await post(s.context.request, 'save_settings', { ...w.settings });
  expect(result.status).toBe(200);
  expect(result.body.success).toBe(true);
  await s.context.close();
});

