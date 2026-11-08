/**
 * Shared harness for the browser pass of the SQA pack (docs/qa/cases). Every test title starts with its case ID.
 *
 * Data: only the disposable QA tenant (QA_TENANT). Fixtures are built in-process with the same engine the
 * server runs (execute), then written as the QA tenant's snapshot exactly like scripts/create-qa-tenant.ts
 * does, so a spec starts from a known company in about a second. Nothing outside the QA tenant is written.
 *
 * Auth: one signed-in storage state is shared by every spec (kept outside the repo in the OS temp dir) and
 * re-created when it stops working (for example after a sign-out test, because Supabase signs out globally).
 */
import { expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { QA_TENANT, resetQaTenant } from '../../scripts/create-qa-tenant';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { execute } from '../../src/modules/erp/engine';
import { toggleModules } from '../../src/modules/erp/modules';
import type { Actor, ToggleModule, Workspace } from '../../src/modules/erp/types';

export { QA_TENANT, resetQaTenant };
export const EMAIL = process.env.BOOTSTRAP_OWNER_EMAIL || '';
export const PASSWORD = process.env.BOOTSTRAP_OWNER_PASSWORD || '';
export const AUTH_FILE = join(tmpdir(), `sahulat-qa-browser-auth-${QA_TENANT}.json`);
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };
export const evidenceDir = join(process.cwd(), 'reports', 'qa-run', 'evidence');
mkdirSync(evidenceDir, { recursive: true });

// ---------------------------------------------------------------- auth
export async function signInOnPage(page: Page, email = EMAIL, password = PASSWORD) {
  await page.goto(`/?tenant=${QA_TENANT}`);
  await page.waitForLoadState('networkidle');
  if (await page.getByRole('heading', { name: 'Welcome back' }).isVisible()) {
    await page.getByLabel('Email address').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole('button', { name: 'Sign in securely' }).click();
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor({ state: 'detached', timeout: 60_000 });
  }
  await page.waitForLoadState('networkidle');
}

async function stateWorks(browser: Browser) {
  if (!existsSync(AUTH_FILE)) return false;
  const context = await browser.newContext({ storageState: AUTH_FILE });
  try { return (await context.request.get(`/api/workspace?tenant=${QA_TENANT}`, { timeout: 60_000 })).status() === 200; }
  catch { return false; }
  finally { await context.close(); }
}

/** A storage-state file for a signed-in owner session; signs in again only when the saved one stopped working. */
export async function authState(browser: Browser) {
  if (await stateWorks(browser)) return AUTH_FILE;
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInOnPage(page);
  await expect.poll(async () => (await context.request.get(`/api/workspace?tenant=${QA_TENANT}`)).status(), { timeout: 60_000 }).toBe(200);
  await context.storageState({ path: AUTH_FILE });
  await context.close();
  return AUTH_FILE;
}

/**
 * Re-signs an existing context in when its session died (Supabase sign-out is global, so a sign-out test in
 * any parallel run ends every session of the owner). Copies the fresh cookies into the context and, when a
 * page is given, reloads it so later steps never fail for a lost session.
 */
export async function keepSignedIn(browser: Browser, context: BrowserContext, page?: Page) {
  const ok = async () => (await context.request.get(`/api/workspace?tenant=${QA_TENANT}`, { timeout: 60_000 }).catch(() => null))?.status() === 200;
  if (await ok()) return false;
  const file = await authState(browser);
  const state = JSON.parse(readFileSync(file, 'utf8')) as { cookies: Parameters<BrowserContext['addCookies']>[0] };
  await context.clearCookies();
  await context.addCookies(state.cookies);
  if (page && !page.isClosed()) await gotoApp(page);
  return true;
}

/** True when another browser context holding the saved owner session can still read the workspace. */
export async function savedSessionAlive(browser: Browser, file: string) {
  const context = await browser.newContext({ storageState: file });
  try { return (await context.request.get(`/api/workspace?tenant=${QA_TENANT}`)).status() === 200; } finally { await context.close(); }
}

/** New signed-in context + page at the given viewport, with console/page errors collected. */
export async function signedInPage(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}) {
  const storageState = await authState(browser);
  const context = await browser.newContext({ viewport: DESKTOP, ...options, storageState });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  return { context, page, errors };
}

// ---------------------------------------------------------------- API commands (real server path)
export async function post(request: APIRequestContext, type: string, payload: Record<string, unknown>, options: { confirmPassword?: string } = {}) {
  const data = { type, payload, idempotencyKey: `qab-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...options };
  let response = await request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data });
  if (response.status() >= 500 || !(response.headers()['content-type'] ?? '').includes('json')) {
    await new Promise(r => setTimeout(r, 800));
    response = await request.post('/api/workspace', { headers: { 'x-tenant-id': QA_TENANT }, data });
  }
  const body = await response.json().catch(() => ({}));
  return { status: response.status(), body: body as { success?: boolean; message?: string; recordId?: string; workspace?: Workspace } };
}
export async function readWorkspaceApi(request: APIRequestContext) {
  return (await (await request.get(`/api/workspace?tenant=${QA_TENANT}`)).json()).workspace as Workspace;
}

// ---------------------------------------------------------------- navigation helpers
export async function gotoApp(page: Page, path = `/?tenant=${QA_TENANT}`) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
  // Nav buttons stay disabled until hydration; wait for that so clicks are not lost.
  const nav = page.locator('button.nav-item').first();
  if (await nav.count()) await expect(nav).toBeEnabled({ timeout: 60_000 });
}
export const APP = `/?tenant=${QA_TENANT}`;
export type Session = Awaited<ReturnType<typeof signedInPage>>;
/** Seeds the rich fixture (or a given workspace), opens a signed-in desktop page on the app. */
export async function sharedSession(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}, workspace?: Workspace) {
  const seeded = workspace ? (await writeQaWorkspace(workspace), { ids: {} as Record<string, string> }) : await seedRich();
  const session = await signedInPage(browser, options);
  await gotoApp(session.page);
  return { ...session, ids: seeded.ids };
}
/** Closes any open dialog/menu and returns to Overview without a reload. */
export async function home(page: Page) {
  for (let i = 0; i < 3 && await page.locator('[role=dialog]:not(.setup-layer), [role=menu]').count(); i++) await page.keyboard.press('Escape');
  await openModule(page, 'Overview');
}
export const navItem = (page: Page, label: string) => page.locator('button.nav-item').filter({ hasText: new RegExp(`^${label.replace(/[&]/g, '\\&')}`) });
export async function openModule(page: Page, label: string) {
  const mobile = (page.viewportSize()?.width ?? 1440) <= 760;
  if (mobile && !(await page.locator('.sidebar.mobile-open').count())) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('button.nav-item').filter({ hasText: label }).first().click();
  await expect(page.locator('.breadcrumb strong')).toHaveText(label);
}
export const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
export const style = (page: Page, selector: string, prop: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

/** WCAG relative-luminance contrast of two CSS colours (rgb/rgba strings). */
export function contrast(fg: string, bg: string) {
  const parse = (c: string) => (c.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
  const lum = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [a, b] = [lum(parse(fg)), lum(parse(bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// ---------------------------------------------------------------- fixtures built with the engine
const ownerActor = (): Actor => ({ id: process.env.BOOTSTRAP_OWNER_ID || 'qa-owner', name: 'QA Owner', role: 'Owner', branchIds: [], email: EMAIL });
let seq = 0;
export class Builder {
  w: Workspace;
  constructor(w: Workspace) { this.w = w; }
  run(type: string, payload: Record<string, unknown> = {}) {
    const r = execute(this.w, { type, payload, idempotencyKey: `seed-${Date.now()}-${++seq}` }, ownerActor());
    this.w = r.workspace;
    return r.recordId;
  }
  get wh() { return this.w.warehouses[0].id; }
  item(fields: Record<string, unknown>, stock?: string, cost?: string) {
    const id = this.run('save_item', { category: 'General', hsCode: '', unit: 'pcs', price: '100', cost: '60', weight: '1', volume: '1', reorderLevel: 0, ...fields });
    if (stock) this.run('bulk_stock_increase', { warehouseId: this.wh, date: '2026-09-01', purpose: 'opening_stock', reason: 'QA opening stock', lines: [{ itemId: id, quantity: stock, cost: cost ?? String(fields.cost ?? '60') }] });
    return id;
  }
  party(name: string, type: 'customer' | 'supplier', fields: Record<string, unknown> = {}) {
    return this.run('save_party', { name, type, city: 'Karachi', phone: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: type === 'customer' ? 'Retailer' : 'Importer', ...fields });
  }
  doc(kind: string, partyId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, submit = true) {
    const date = String(extra.date ?? '2026-10-01');
    const id = this.run('create_document', { kind, partyId, warehouseId: this.wh, date, dueDate: date, currency: 'PKR', fxRate: '1', notes: '', ...extra, lines: lines.map(l => ({ discount: '0', taxRate: '0', employeeId: '', splits: [], ...l })) });
    if (submit) this.run('submit_document', { id });
    return id;
  }
  number(id: string) { return this.w.documents.find(d => d.id === id)?.number ?? this.w.receipts.find(r => r.id === id)?.number ?? this.w.shipments.find(s => s.id === id)?.number ?? ''; }
}

export function freshBuilder(modules: ToggleModule[] = [...toggleModules], company: Partial<Workspace['company']> = {}, demo = true) {
  const base = blankWorkspace(false);
  const b = new Builder({ ...base, tenantId: QA_TENANT, demo, company: { ...base.company, name: 'QA Company', logo: 'Q' }, settings: { ...base.settings, numbering: 'QA' } });
  b.run('save_company', { name: 'QA Trading Company', address: '12 Jodia Bazar, Karachi', phone: '+92 300 1234567', email: 'office@qa.example', taxId: '1234567-8', ...company });
  b.run('set_modules', { enabled: modules });
  b.run('complete_setup', {});
  return b;
}

/** A company part-way through the setup wizard: steps before `step` are saved, the card opens at `step`. */
export function setupWorkspace(step: 1 | 2 | 3 | 4, modules: ToggleModule[] = ['sales', 'purchasing', 'inventory', 'imports', 'collections', 'cashbank', 'commissions', 'reports']) {
  const base = blankWorkspace(false);
  const b = new Builder({ ...base, tenantId: QA_TENANT, company: { ...base.company, name: 'QA Company', logo: 'Q' }, settings: { ...base.settings, numbering: 'QA' } });
  if (step >= 2) b.run('save_company', { name: 'QA Trading Company', address: '12 Jodia Bazar, Karachi', phone: '+92 300 1234567', email: 'office@qa.example', taxId: '' });
  if (step >= 3) b.run('save_branding', { ...b.w.branding, accent: '#1f5fa8', footer: 'Bank: QA Bank · Account 000-111' });
  if (step >= 4) b.run('set_modules', { enabled: modules });
  if (step > 1) b.run('save_setup_step', { step });
  return b.w;
}

/** Fixed names used by the specs. */
export const F = {
  customer: 'Ali Traders', customerLtd: 'Ali Traders Ltd', metro: 'Metro Home Stores', urduCustomer: 'علی ٹریڈرز',
  supplier: 'Ningbo Exports', localSupplier: 'Karachi Packaging', walkIn: 'Counter Sale Bilal',
  led: 'LED Panel Light', fan: 'Rechargeable Desk Fan', kettle: 'Electric Kettle', freebie: 'Free Sample Pack',
  salesperson: 'Hamza Khan',
};

/**
 * A busy importer-distributor: customers incl. near-duplicate and Urdu names, suppliers, four products
 * (available / low / out of stock / zero price), a full sales chain, a walk-in invoice, a return, a cancelled
 * draft, a USD purchase chain with an overdue bill and a part payment, two shipments (one with unallocated
 * cost), cheques in every state, follow-ups, a transfer, an expense, commission and a draft payroll run.
 */
export function richWorkspace(options: { demo?: boolean; modules?: ToggleModule[]; hide?: ToggleModule[] } = {}) {
  const b = freshBuilder(options.modules ?? [...toggleModules], {}, options.demo ?? true);
  b.run('save_settings', { ...b.w.settings, taxRate: '18' });
  const ids: Record<string, string> = {};
  ids.hamza = b.run('save_employee', { name: F.salesperson, role: 'Order Booker', territory: 'Karachi', salary: '45000', allowance: '5000', deduction: '0', attendance: 30, active: true });
  b.run('save_plan', { ...b.w.plans[0], name: 'Standard 2%', rate: '2' });
  ids.led = b.item({ sku: 'QA-LED', name: F.led, category: 'Lighting', price: '2400', cost: '1450', reorderLevel: 10 }, '100', '1450');
  ids.fan = b.item({ sku: 'QA-FAN', name: F.fan, category: 'Home', price: '4500', cost: '2750', reorderLevel: 20 }, '12', '2750');
  ids.kettle = b.item({ sku: 'QA-KET', name: F.kettle, category: 'Home', price: '1000', cost: '600', reorderLevel: 5 });
  ids.free = b.item({ sku: 'QA-FREE', name: F.freebie, category: 'Promotional', price: '0', cost: '10', reorderLevel: 0 }, '40', '10');
  ids.ali = b.party(F.customer, 'customer', { city: 'Lahore', phone: '+92 300 1111111', terms: 30 });
  ids.aliLtd = b.party(F.customerLtd, 'customer', { city: 'Karachi', phone: '+92 321 2222222', terms: 45 });
  ids.metro = b.party(F.metro, 'customer', { city: 'Lahore', phone: '+92 42 3333333', terms: 15 });
  ids.urdu = b.party(F.urduCustomer, 'customer', { city: 'کراچی', phone: '', terms: 30 });
  ids.ningbo = b.party(F.supplier, 'supplier', { city: 'Ningbo', terms: 60 });
  ids.pack = b.party(F.localSupplier, 'supplier', { city: 'Karachi', terms: 30 });
  const sp = { employeeId: ids.hamza };
  // Sales: overdue invoice with a part receipt and a return; a second invoice; a walk-in invoice; a draft; a cancelled draft; a chain.
  ids.inv1 = b.doc('sales_invoice', ids.ali, [{ itemId: ids.led, quantity: '10', price: '2400', ...sp }], { date: '2026-09-01', dueDate: '2026-10-01' });
  ids.inv2 = b.doc('sales_invoice', ids.metro, [{ itemId: ids.fan, quantity: '2', price: '4500', ...sp }], { date: '2026-10-02', dueDate: '2026-10-17' });
  const walk = b.w.parties.find(p => p.name === 'Walk-in customer')?.id ?? b.party('Walk-in customer', 'customer');
  ids.walkInv = b.doc('sales_invoice', walk, [{ itemId: ids.led, quantity: '1', price: '2400' }], { date: '2026-10-03', dueDate: '2026-10-03', partyName: F.walkIn });
  ids.draftInv = b.doc('sales_invoice', ids.aliLtd, [{ itemId: ids.led, quantity: '3', price: '2400' }], { date: '2026-10-04', dueDate: '2026-11-18' }, false);
  ids.cancelled = b.doc('sales_invoice', ids.metro, [{ itemId: ids.fan, quantity: '1', price: '4500' }], { date: '2026-10-04' }, false);
  b.run('cancel_document', { id: ids.cancelled, reason: 'Customer changed mind' });
  ids.quo = b.doc('quotation', ids.metro, [{ itemId: ids.led, quantity: '5', price: '2400', ...sp }], { date: '2026-10-05' });
  b.run('convert_document', { id: ids.quo, date: '2026-10-05', lines: [{ itemId: ids.led, quantity: '5', price: '2400', discount: '0', taxRate: '0', employeeId: ids.hamza, splits: [] }] });
  ids.so = b.w.documents.at(-1)!.id; b.run('submit_document', { id: ids.so });
  b.run('convert_document', { id: ids.so, date: '2026-10-06', lines: [{ itemId: ids.led, quantity: '5', price: '2400', discount: '0', taxRate: '0', employeeId: ids.hamza, splits: [] }] });
  ids.dn = b.w.documents.at(-1)!.id; b.run('submit_document', { id: ids.dn });
  b.run('convert_document', { id: ids.dn, date: '2026-10-06', lines: [{ itemId: ids.led, quantity: '5', price: '2400', discount: '0', taxRate: '0', employeeId: ids.hamza, splits: [] }] });
  ids.chainInv = b.w.documents.at(-1)!.id; b.run('submit_document', { id: ids.chainInv });
  // Receipts: bank part-payment, cheques received (due), deposited, cleared, bounced.
  ids.bankRcpt = b.run('create_receipt', { partyId: ids.ali, date: '2026-10-05', amount: '10000', method: 'bank', chequeNo: '', dueDate: '2026-10-05', allocations: [{ invoiceId: ids.inv1, amount: '10000' }], employeeId: '', note: 'Part payment', accountId: 'main-bank' });
  ids.chqReceived = b.run('create_receipt', { partyId: ids.metro, date: '2026-10-06', amount: '3000', method: 'cheque', chequeNo: 'CHQ-1001', dueDate: '2026-10-10', allocations: [{ invoiceId: ids.inv2, amount: '3000' }], employeeId: '', note: 'PDC' });
  ids.chqDeposited = b.run('create_receipt', { partyId: ids.metro, date: '2026-10-06', amount: '2000', method: 'cheque', chequeNo: 'CHQ-1002', dueDate: '2026-10-08', allocations: [{ invoiceId: ids.inv2, amount: '2000' }], employeeId: '', note: 'PDC' });
  b.run('update_cheque', { id: ids.chqDeposited, status: 'deposited', date: '2026-10-08', accountId: 'main-bank' });
  ids.chqCleared = b.run('create_receipt', { partyId: ids.metro, date: '2026-10-06', amount: '1000', method: 'cheque', chequeNo: 'CHQ-1003', dueDate: '2026-10-07', allocations: [{ invoiceId: ids.chainInv, amount: '1000' }], employeeId: '', note: 'PDC' });
  b.run('update_cheque', { id: ids.chqCleared, status: 'deposited', date: '2026-10-07', accountId: 'main-bank' });
  b.run('update_cheque', { id: ids.chqCleared, status: 'cleared', date: '2026-10-08' });
  ids.chqBounced = b.run('create_receipt', { partyId: ids.ali, date: '2026-10-06', amount: '500', method: 'cheque', chequeNo: 'CHQ-1004', dueDate: '2026-10-07', allocations: [{ invoiceId: ids.inv1, amount: '500' }], employeeId: '', note: 'PDC' });
  b.run('update_cheque', { id: ids.chqBounced, status: 'bounced', date: '2026-10-08' });
  // A return on the first invoice.
  const line = b.w.documents.find(d => d.id === ids.inv1)!.lines[0];
  b.run('return_document', { id: ids.inv1, date: '2026-10-07', reason: 'Damaged in transit', lines: [{ lineId: line.id, quantity: '1' }] });
  ids.creditNote = b.w.documents.at(-1)!.id;
  // Follow-ups: one due, one later.
  b.run('follow_up', { partyId: ids.ali, note: 'Called; promised payment Friday', nextDate: '2026-10-10' });
  b.run('follow_up', { partyId: ids.ali, note: 'Visited shop; owner away', nextDate: '2026-12-01' });
  // Purchasing: USD PO -> GRN -> bill (overdue), part payment; a local GRN for a second shipment.
  ids.po = b.doc('purchase_order', ids.ningbo, [{ itemId: ids.kettle, quantity: '50', price: '2' }], { date: '2026-08-01', dueDate: '2026-08-15', currency: 'USD', fxRate: '280' });
  b.run('convert_document', { id: ids.po, date: '2026-08-10', lines: [{ itemId: ids.kettle, quantity: '50', price: '2', discount: '0', taxRate: '0', employeeId: '', splits: [] }] });
  ids.grn = b.w.documents.at(-1)!.id; b.run('submit_document', { id: ids.grn });
  b.run('convert_document', { id: ids.grn, date: '2026-08-12', lines: [{ itemId: ids.kettle, quantity: '50', price: '2', discount: '0', taxRate: '0', employeeId: '', splits: [] }] });
  ids.bill = b.w.documents.at(-1)!.id;
  b.w.documents.find(d => d.id === ids.bill)!.dueDate = '2026-09-11';
  b.run('submit_document', { id: ids.bill });
  ids.supPay = b.run('create_receipt', { partyId: ids.ningbo, date: '2026-09-20', amount: '14000', method: 'bank', chequeNo: '', dueDate: '2026-09-20', allocations: [{ invoiceId: ids.bill, amount: '50' }], employeeId: '', note: 'Supplier payment', accountId: 'main-bank' });
  ids.grn2 = b.doc('goods_receipt', ids.pack, [{ itemId: ids.fan, quantity: '10', price: '2750' }], { date: '2026-09-15' });
  // Imports: SHP-1 costed and allocated, SHP-2 with an unallocated cost.
  ids.shp1 = b.run('create_shipment', { documentId: ids.grn, container: 'MSKU1234567', gdNumber: 'KPPI-HC-1001', eta: '2026-08-11' });
  b.run('add_shipment_cost', { id: ids.shp1, label: 'Freight', amount: '7000', classification: 'inventory', basis: 'value' });
  b.run('allocate_shipment', { id: ids.shp1, date: '2026-08-20' });
  ids.shp2 = b.run('create_shipment', { documentId: ids.grn2, container: 'TGHU7654321', gdNumber: 'KPPI-HC-2002', eta: '2026-09-14' });
  b.run('add_shipment_cost', { id: ids.shp2, label: 'Customs duty', amount: '5000', classification: 'inventory', basis: 'value' });
  // Cash & bank: a transfer and an expense.
  b.run('bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '2000', date: '2026-10-08', memo: 'Cash float for the counter' });
  b.run('record_expense', { accountId: 'cash', amount: '350', date: '2026-10-08', memo: 'Courier to Lahore for the Metro Home Stores order, including packing material and a long description that should truncate', expenseAccount: '5300' });
  // Commission approvals and a payroll draft.
  const releasable = b.w.commissions.filter(c => Number(c.released) > Number(c.paid));
  if (releasable.length) b.run('approve_commission', { ids: [releasable[0].id] });
  b.run('save_settings', { ...b.w.settings, employerEobi: '5', employeeEobi: '1', eobiBase: '37000', incomeTaxRate: '5' });
  ids.payroll = b.run('create_payroll', { month: '2026-09', date: '2026-09-30' });
  // Purchasing extras: a part-received PO and two open PKR bills for one supplier.
  ids.po2 = b.doc('purchase_order', ids.pack, [{ itemId: ids.led, quantity: '10', price: '1400' }], { date: '2026-09-20', dueDate: '2026-10-20' });
  b.run('convert_document', { id: ids.po2, date: '2026-09-25', lines: [{ itemId: ids.led, quantity: '4', price: '1400', discount: '0', taxRate: '0', employeeId: '', splits: [] }] });
  ids.grn3 = b.w.documents.at(-1)!.id; b.run('submit_document', { id: ids.grn3 });
  b.run('convert_document', { id: ids.grn2, date: '2026-09-16', lines: [{ itemId: ids.fan, quantity: '10', price: '2750', discount: '0', taxRate: '0', employeeId: '', splits: [] }] });
  ids.billA = b.w.documents.at(-1)!.id; b.w.documents.find(d => d.id === ids.billA)!.dueDate = '2026-10-16'; b.run('submit_document', { id: ids.billA });
  ids.billB = b.doc('supplier_invoice', ids.pack, [{ itemId: ids.free, quantity: '100', price: '10' }], { date: '2026-10-01', dueDate: '2026-10-31' });
  // Cash & bank extras: account details, an archived account and an overdrawn petty-cash account.
  b.run('save_bank_account', { id: 'main-bank', name: 'Main bank account', type: 'bank', details: 'HBL · Saddar branch · 0012-3456789' });
  ids.petty = b.run('save_bank_account', { name: 'Petty cash', type: 'cash', details: '' });
  b.run('record_expense', { accountId: ids.petty, amount: '500', date: '2026-10-09', memo: 'Tea and snacks', expenseAccount: '5300' });
  ids.oldBank = b.run('save_bank_account', { name: 'Closed MCB account', type: 'bank', details: 'MCB · closed' });
  b.w.bankAccounts.find(a => a.id === ids.oldBank)!.archived = true;
  // A second salesperson with her own invoice (role-preview filtering).
  ids.sara = b.run('save_employee', { name: 'Sara Malik', role: 'Area Sales Manager', territory: 'Lahore', salary: '95000', allowance: '0', deduction: '0', attendance: 30, active: true });
  ids.saraInv = b.doc('sales_invoice', ids.aliLtd, [{ itemId: ids.led, quantity: '2', price: '2400', employeeId: ids.sara }], { date: '2026-10-08', dueDate: '2026-11-22' });
  if (options.hide?.length) b.run('set_modules', { enabled: b.w.modules.filter(m => !options.hide!.includes(m)) });
  return { w: b.w, ids, b };
}

// ---------------------------------------------------------------- write the snapshot (QA tenant only)
export async function writeQaWorkspace(workspace: Workspace) {
  if (workspace.tenantId !== QA_TENANT) throw new Error('Refusing to write a workspace that is not the QA tenant.');
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  const ownerId = process.env.BOOTSTRAP_OWNER_ID;
  if (!url || !ownerId) throw new Error('DATABASE_URL and BOOTSTRAP_OWNER_ID are required.');
  const sql = postgres(url, { ssl: 'require', prepare: false, max: 1, connect_timeout: 20 });
  try {
    await sql.begin(async tx => {
      await tx`select set_config('app.demo_reset', 'on', true)`;
      await tx`delete from public.tenants where id = ${QA_TENANT}`;
      await tx`insert into public.tenants (id, name, is_demo) values (${QA_TENANT}, ${workspace.company.name}, true)`;
      await tx`insert into public.memberships (tenant_id, user_id, role, branch_ids) values (${QA_TENANT}, ${ownerId}, 'Owner', '{}')`;
      await tx`insert into public.workspace_snapshots (tenant_id, revision, schema_version, data) values (${QA_TENANT}, ${workspace.revision}, 1, ${tx.json(workspace as never)})`;
      await tx`select private.sync_projection(${QA_TENANT}, data, true) from public.workspace_snapshots where tenant_id = ${QA_TENANT}`;
    });
  } finally { await sql.end({ timeout: 3 }); }
}

/** Seeds the rich fixture and returns its ids. */
export async function seedRich(options: Parameters<typeof richWorkspace>[0] = {}) {
  const r = richWorkspace(options);
  await writeQaWorkspace(r.w);
  return r;
}

export function saveEvidence(name: string, data: unknown) { writeFileSync(join(evidenceDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2)); }
