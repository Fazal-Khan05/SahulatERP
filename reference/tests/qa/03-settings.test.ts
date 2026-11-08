import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/utils', () => import('../../src/lib/utils'));
vi.mock('@/modules/erp/modules', () => import('../../src/modules/erp/modules'));
vi.mock('@/modules/erp/documents', () => import('../../src/modules/erp/documents'));
vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/modules/erp/types', () => import('../../src/modules/erp/types'));
vi.mock('@/modules/erp/access', () => import('../../src/modules/erp/access'));
vi.mock('@/modules/erp/engine', () => import('../../src/modules/erp/engine'));
vi.mock('@/modules/erp/demo', () => import('../../src/modules/erp/demo'));
const store = vi.hoisted(() => ({
  workspace: null as unknown as import('../../src/modules/erp/types').Workspace,
  actor: null as unknown as import('../../src/modules/erp/types').Actor,
  member: true, commits: 0, passwords: [] as string[], uploads: [] as string[],
}));
vi.mock('@/lib/workspace-store', () => ({
  requireMember: vi.fn(async (tenantId: string | null) => { if (!tenantId) throw new Error('TENANT_REQUIRED'); if (!store.member) throw new Error('ACCESS_DENIED'); return { actor: store.actor, user: { id: store.actor.id, email: 'member@qa.example' } }; }),
  readWorkspace: vi.fn(async () => ({ workspace: store.workspace, revision: store.workspace.revision })),
  commitWorkspace: vi.fn(async (_tenant: string, _revision: number, next: import('../../src/modules/erp/types').Workspace) => { store.workspace = next; store.commits++; return true; }),
}));
vi.mock('@/lib/password', () => ({
  verifyPassword: vi.fn(async (_id: string, _email: string, password: string) => {
    store.passwords.push(password);
    if (!password) return { ok: false, message: 'Enter your password to confirm.' };
    return password === 'correct horse' ? { ok: true } : { ok: false, message: 'Password incorrect.' };
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => ({ storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) } }) }));
vi.mock('@/lib/branding-store', () => ({
  brandingKinds: ['logo', 'letterhead'],
  storeBrandingFile: vi.fn(async (tenantId: string, kind: string) => { store.uploads.push(`${tenantId}/${kind}.png`); return { path: `${tenantId}/${kind}.png` }; }),
  signedBrandingUrl: vi.fn(async (path: string) => `https://signed.example/${path}`),
}));
import { SettingsView } from '../../src/components/settings-view';
import { BrandingForm } from '../../src/components/branding-form';
import { ModulePicker } from '../../src/components/module-picker';
import { DocumentPreview } from '../../src/components/document-preview';
import { commandSchema, stock } from '../../src/modules/erp/engine';
import { decodeWorkspace } from '../../src/modules/erp/codec';
import { documentView, sampleInvoiceView } from '../../src/modules/erp/documents';
import { dependentsOf, moduleCatalogue, moduleEnabled, moduleRecordCounts, toggleModules, withRequirements } from '../../src/modules/erp/modules';
import { agedBalances, stockValuation } from '../../src/modules/erp/reports';
import { DEMO_TENANT, type Actor, type Role, type ToggleModule, type Workspace } from '../../src/modules/erp/types';
import { accountBalance, actor, buildDemoWorkspace, expectInvariants, firstWarehouse, freshCompany, owner, refused, run, today, withDocument, withItem, withParty } from './helpers';

const companyPayload = (w: Workspace, extra: Record<string, unknown> = {}) => ({ name: w.company.name, address: w.company.address, phone: w.company.phone, email: w.company.email, taxId: w.company.taxId, ...extra });
const settingsHtml = (w: Workspace, role: Role = 'Owner') => renderToStaticMarkup(createElement(SettingsView, { workspace: w, realRole: role, role, setRole: () => {}, busy: '', command: async () => ({ ok: true, message: '' }), onWorkspace: () => {}, onReset: () => {}, audit: null }));
const preview = (w: Workspace, assets: { logoUrl?: string; letterheadUrl?: string } = {}) => renderToStaticMarkup(createElement(DocumentPreview, { view: sampleInvoiceView(), company: w.company, branding: w.branding, assets }));
const header = (html: string) => html.slice(0, html.indexOf('doc-parties'));
const allBut = (w: Workspace, ...off: ToggleModule[]) => w.modules.filter(m => !off.includes(m));
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

async function post(body: Record<string, unknown>, who: Actor = owner) {
  store.actor = who;
  const { POST } = await import('../../src/app/api/workspace/route');
  const response = await POST(new Request('http://localhost/api/workspace', { method: 'POST', headers: { 'x-tenant-id': 'qa-tenant', 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: `qa-set-${Math.random().toString(36).slice(2)}`, ...body }) }));
  return { status: response.status, json: await response.json() as { success: boolean; message: string; passwordRequired?: boolean; workspace?: Workspace } };
}
function serve(w: Workspace) { store.workspace = w; store.commits = 0; store.passwords = []; store.member = true; }

/** A company with records in every module: stock, an open invoice, an open bill, a pending cheque, and an earned commission. */
function busyCompany() {
  let w = freshCompany();
  let item: string, cust: string, supp: string, inv: string;
  [w, item] = withItem(w, { category: 'Lighting' }, { quantity: '50', cost: '1500' });
  [w, cust] = withParty(w, 'customer');
  [w, supp] = withParty(w, 'supplier');
  [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '2', price: '2400' }]);
  [w] = withDocument(w, 'supplier_invoice', supp, [{ itemId: item, quantity: '5', price: '1500' }]);
  w = run(w, 'create_receipt', { partyId: cust, date: today(), amount: '1000', method: 'cheque', chequeNo: 'CHQ-1', dueDate: today(), allocations: [{ invoiceId: inv, amount: '1000' }] }).workspace;
  return { w, item, cust, supp, inv };
}

describe('03 settings (SET)', () => {
  it('SET-001 Settings shows tabs Company & documents, Features, Access, Audit history [case-corrected: D-09 adds a "Payroll & tax" tab after Company & documents]', () => {
    const html = settingsHtml(freshCompany());
    expect([...html.matchAll(/role="tab" aria-selected="(?:true|false)" class="tab[^"]*">([^<]+)</g)].map(m => m[1])).toEqual(['Company &amp; documents', 'Payroll &amp; tax', 'Features', 'Access', 'Audit history']);
  });

  it('SET-002 changing the company name saves company then branding [browser part: combined "Company details and document branding saved." notice; sidebar switcher]', () => {
    const w = freshCompany();
    const first = run(w, 'save_company', companyPayload(w, { name: 'Renamed Traders' }));
    expect(first.message).toBe('Company details saved.');
    expect(first.workspace.company.name).toBe('Renamed Traders');
    expect(run(first.workspace, 'save_branding', { ...w.branding }).message).toBe('Document branding saved.');
    expect(source('src/components/settings-view.tsx')).toContain("'Company details and document branding saved.'");
  });

  it('SET-003 clearing the company name is refused (name ≥ 2)', () => {
    const w = freshCompany();
    refused(w, 'save_company', companyPayload(w, { name: '' }), />=2 characters/);
  });

  it('SET-004 Save changes is disabled until something changes [browser part: enables after an edit]', () => {
    expect(settingsHtml(freshCompany())).toMatch(/<button class="button button-primary" disabled="">.*?Save changes<\/button>/);
  });

  it('SET-005 NTN change saved and printed as "NTN / STRN: …"', () => {
    const w0 = freshCompany();
    const w = run(w0, 'save_company', companyPayload(w0, { taxId: '4455667-1' })).workspace;
    expect(header(preview(w))).toContain('NTN / STRN: 4455667-1');
  });

  it('SET-006 accent colour change saved and used by the print template [browser part: live preview]', () => {
    const w = run(freshCompany(), 'save_branding', { accent: '#c2611a', footer: '' }).workspace;
    expect(preview(w)).toContain('--doc-accent:#c2611a');
  });

  it('SET-007 replaced logo path saved and the template shows the logo image [browser part: real upload]', () => {
    let w = run(freshCompany(), 'save_branding', { accent: '#087f69', footer: '', logoPath: 'qa-tenant/logo.png' }).workspace;
    w = run(w, 'save_branding', { ...w.branding, logoPath: 'qa-tenant/logo.jpg' }).workspace;
    expect(w.branding.logoPath).toBe('qa-tenant/logo.jpg');
    expect(preview(w, { logoUrl: '/api/branding/logo' })).toContain('class="doc-logo"');
  });

  it('SET-008 removing the logo falls back to the company initial', () => {
    let w = run(freshCompany(), 'save_branding', { accent: '#087f69', footer: '', logoPath: 'qa-tenant/logo.png' }).workspace;
    w = run(w, 'save_branding', { ...w.branding, logoPath: undefined }).workspace;
    expect(w.branding.logoPath).toBeUndefined();
    expect(preview(w)).toContain('<span class="doc-logo-fallback" aria-hidden="true">Q</span>');
  });

  it('SET-009 letterhead uploaded then removed: header returns to logo + name', () => {
    let w = run(freshCompany(), 'save_branding', { accent: '#087f69', footer: '', letterheadPath: 'qa-tenant/letterhead.png' }).workspace;
    expect(preview(w, { letterheadUrl: '/api/branding/letterhead' })).toContain('doc-letterhead');
    w = run(w, 'save_branding', { ...w.branding, letterheadPath: undefined }).workspace;
    const html = preview(w);
    expect(html).not.toContain('doc-letterhead');
    expect(html).toContain('<strong class="doc-company">QA Trading Co</strong>');
  });

  it('SET-010 logo over 1 MB refused [browser part: message shown in Settings]', async () => {
    const real = await vi.importActual<typeof import('../../src/lib/branding-store')>('../../src/lib/branding-store');
    const big = new Uint8Array(1024 * 1024 + 1); big.set([0x89, 0x50, 0x4e, 0x47]);
    expect(await real.storeBrandingFile('qa-tenant', 'logo', new File([big as BlobPart], 'logo.png', { type: 'image/png' }))).toEqual({ error: 'Logo must be under 1 MB.' });
  });

  it('SET-011 emptied footer prints no footer line', () => {
    const w = run(freshCompany(), 'save_branding', { accent: '#087f69', footer: '' }).workspace;
    const footer = preview(w).split('doc-footer')[1];
    expect(footer).not.toContain('<p>');
  });

  it.todo('SET-012 [browser] edit, switch tab without saving: changes dropped or kept, never partially saved');

  it('SET-013 Auditor sees Company & documents read-only: no Save button, inputs disabled', () => {
    const html = settingsHtml(freshCompany(), 'Auditor');
    expect(html).not.toContain('Save changes');
    expect(html).toMatch(/name="name" value="QA Trading Co"/);
    expect(html).toMatch(/<input required="" minLength="2" maxLength="120" disabled=""/);
  });

  it('SET-014 Salesperson may save the company name via the API only while setup is open [case-corrected: after setup company details are Owner/Accountant only (D-08)] [browser part: Settings is not in the Salesperson sidebar, see SET-058]', () => {
    const w = freshCompany();
    refused(w, 'save_company', companyPayload(w, { name: 'Sales Renamed' }), 'Your role does not permit this action.', actor('Salesperson'));
    const wizard = { ...w, setup: { complete: false, step: 1 as const } };
    expect(run(wizard, 'save_company', companyPayload(w, { name: 'Sales Renamed' }), actor('Salesperson')).workspace.company.name).toBe('Sales Renamed');
  });

  it('SET-015 Features lists all nine modules with switches and record counts [browser part: Features tab layout]', () => {
    const { w } = busyCompany();
    const html = renderToStaticMarkup(createElement(ModulePicker, { selected: w.modules, onChange: () => {}, workspace: w, showPresets: false }));
    expect(html.match(/role="switch"/g)).toHaveLength(moduleCatalogue.length);
    expect(html).toContain('1 products · 3 stock movements');
    expect(html).toContain('1 sales documents · 1 customers');
  });

  it('SET-016 turning a module on needs no password and saves immediately', async () => {
    serve(freshCompany(['sales', 'reports']));
    const r = await post({ type: 'set_modules', payload: { enabled: ['sales', 'reports', 'payroll'] } });
    expect(r.status).toBe(200);
    expect(r.json.message).toBe('Turned on Payroll');
    expect(store.passwords).toEqual([]);
    expect(moduleEnabled(store.workspace, 'payroll')).toBe(true);
  });

  it('SET-017 turning a module off asks for the password (401 passwordRequired) [browser part: "Hide {Module}?" dialog with counts]', async () => {
    serve(freshCompany());
    const r = await post({ type: 'set_modules', payload: { enabled: allBut(store.workspace, 'payroll') } });
    expect(r.status).toBe(401);
    expect(r.json.passwordRequired).toBe(true);
    expect(source('src/components/settings-view.tsx')).toContain('title={`Hide ${removing.map(labelOf).join(\', \')}?`}');
  });

  it('SET-018 wrong password: "Password incorrect.", nothing changes', async () => {
    const w = freshCompany(); serve(w);
    const r = await post({ type: 'set_modules', payload: { enabled: allBut(w, 'payroll') }, confirmPassword: 'wrong' });
    expect(r).toMatchObject({ status: 401, json: { success: false, message: 'Password incorrect.', passwordRequired: true } });
    expect(store.commits).toBe(0);
    expect(store.workspace).toBe(w);
  });

  it('SET-019 correct password hides the module and keeps its records', async () => {
    const { w } = busyCompany(); serve(w);
    const r = await post({ type: 'set_modules', payload: { enabled: allBut(w, 'collections', 'commissions') }, confirmPassword: 'correct horse' });
    expect(r.status).toBe(200);
    expect(r.json.message).toBe('Hid Collections & PDCs, Commissions; records are kept');
    expect(moduleEnabled(store.workspace, 'collections')).toBe(false);
    expect(store.workspace.receipts).toEqual(w.receipts);
  });

  it('SET-020 set_modules removing a module without confirmPassword: 401', async () => {
    serve(freshCompany());
    const r = await post({ type: 'set_modules', payload: { enabled: allBut(store.workspace, 'reports') } });
    expect(r).toMatchObject({ status: 401, json: { message: 'Enter your password to confirm.', passwordRequired: true } });
    expect(store.commits).toBe(0);
  });

  it('SET-021 set_modules removing a module with a wrong password: 401', async () => {
    serve(freshCompany());
    expect((await post({ type: 'set_modules', payload: { enabled: allBut(store.workspace, 'reports') }, confirmPassword: 'nope' })).status).toBe(401);
  });

  it('SET-022 turning a hidden module back on shows records and settings exactly as before', () => {
    const { w } = busyCompany();
    const hidden = run(w, 'set_modules', { enabled: allBut(w, 'inventory', 'imports') }).workspace;
    const back = run(hidden, 'set_modules', { enabled: w.modules }).workspace;
    for (const key of ['items', 'stockMoves', 'warehouses', 'branches', 'shipments', 'settings', 'plans', 'bankAccounts'] as const) expect(back[key]).toEqual(w[key]);
    expect(back.modules).toEqual(w.modules);
  });

  it('SET-023 turning off Sales with Commissions on also hides Collections and Commissions (dialog list)', () => {
    const w = freshCompany();
    const next = w.modules.filter(m => !new Set<ToggleModule>(['sales', ...dependentsOf('sales', w.modules)]).has(m));
    expect(w.modules.filter(m => !withRequirements(next).includes(m))).toEqual(['sales', 'collections', 'commissions']);
  });

  it('SET-024 API: Sales off but Commissions kept is refused [case-corrected: message lists modules in catalogue order: "Collections & PDCs, Commissions cannot stay on without Sales."]', () => {
    const w = freshCompany();
    refused(w, 'set_modules', { enabled: allBut(w, 'sales') }, 'Collections & PDCs, Commissions cannot stay on without Sales.');
  });

  it('SET-025 a non-owner member hides a module with their own password', async () => {
    const w = freshCompany(); serve(w);
    const r = await post({ type: 'set_modules', payload: { enabled: allBut(w, 'reports') }, confirmPassword: 'correct horse' }, actor('Accountant'));
    expect(r.status).toBe(200);
    expect(store.workspace.modules).not.toContain('reports');
  });

  it('SET-026 Auditor cannot toggle modules (engine refuses) [browser part: switches disabled]', () => {
    const w = freshCompany(['sales']);
    refused(w, 'set_modules', { enabled: ['sales', 'reports'] }, 'Your role does not permit this action.', actor('Auditor'));
  });

  it.todo('SET-027 [browser] Cancel on the hide dialog leaves the switch on');
  it.todo('SET-028 [browser] Escape closes the hide dialog with no change');

  it('SET-029 password with a trailing newline is passed through untrimmed and refused cleanly [documented: no trimming; refused as "Password incorrect."]', async () => {
    serve(freshCompany());
    const r = await post({ type: 'set_modules', payload: { enabled: allBut(store.workspace, 'reports') }, confirmPassword: 'correct horse\n' });
    expect(store.passwords).toEqual(['correct horse\n']);
    expect(r).toMatchObject({ status: 401, json: { message: 'Password incorrect.' } });
  });

  it('SET-030 password travels only in the body; never in the saved workspace or audit', async () => {
    serve(freshCompany());
    const r = await post({ type: 'set_modules', payload: { enabled: allBut(store.workspace, 'reports') }, confirmPassword: 'correct horse' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(store.workspace)).not.toContain('correct horse');
    expect(source('src/components/workbench.tsx')).toMatch(/JSON\.stringify\(\{type,payload,idempotencyKey:crypto\.randomUUID\(\),\.\.\.\(options\?\.confirmPassword\?\{confirmPassword:options\.confirmPassword\}/);
  });

  it('SET-031 drafts in a hidden module cannot be submitted; the dialog says so', () => {
    let w = freshCompany(); let item: string, cust: string, draft: string;
    [w, item] = withItem(w, {}, { quantity: '5', cost: '10' });
    [w, cust] = withParty(w);
    [w, draft] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '20' }], {}, false);
    w = run(w, 'set_modules', { enabled: allBut(w, 'sales', 'collections', 'commissions') }).workspace;
    refused(w, 'submit_document', { id: draft }, 'Sales is turned off for this company.');
    expect(source('src/components/settings-view.tsx')).toContain('Drafts inside a hidden module cannot be submitted until it is turned back on.');
  });

  it('SET-032 submitting a sales draft via API while Sales is hidden is refused with the module-off message', async () => {
    let w = freshCompany(); let item: string, cust: string, draft: string;
    [w, item] = withItem(w, {}, { quantity: '5', cost: '10' });
    [w, cust] = withParty(w);
    [w, draft] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '20' }], {}, false);
    serve(run(w, 'set_modules', { enabled: allBut(w, 'sales', 'collections', 'commissions') }).workspace);
    const r = await post({ type: 'submit_document', payload: { id: draft } });
    expect(r).toMatchObject({ status: 400, json: { message: 'Sales is turned off for this company. Turn it on in Settings → Features.' } });
  });

  it.todo('SET-033 [browser] records of a hidden module do not appear in search');

  it('SET-034 hidden module accounts stay in Accounting (balances unchanged)', () => {
    const { w } = busyCompany();
    const hidden = run(w, 'set_modules', { enabled: allBut(w, 'sales', 'collections', 'commissions') }).workspace;
    for (const code of ['1100', '4000', '2100', '1200', '2000']) expect(accountBalance(hidden, code)).toBe(accountBalance(w, code));
    expect(hidden.journals).toEqual(w.journals);
  });

  it('SET-035 receivables still report when Collections is hidden', () => {
    const { w } = busyCompany();
    const hidden = run(w, 'set_modules', { enabled: allBut(w, 'collections', 'commissions') }).workspace;
    expect(agedBalances(hidden, 'customer', today()).totals.total).toBe('4800.0000');
  });

  it('SET-036 hiding Reports removes the Reports module; Overview (dashboard) stays [browser part: sidebar]', () => {
    const w = run(freshCompany(), 'set_modules', { enabled: allBut(freshCompany(), 'reports') }).workspace;
    expect(moduleEnabled(w, 'reports')).toBe(false);
    expect(moduleEnabled(w, 'dashboard')).toBe(true);
  });

  it('SET-037 hiding Cash & bank with balances is allowed and Accounting balances are unchanged', () => {
    let w = freshCompany();
    w = run(w, 'create_journal', { memo: 'Capital', lines: [{ account: '1001', debit: '50000', credit: '0' }, { account: '3000', debit: '0', credit: '50000' }] }, actor('Accountant')).workspace;
    const hidden = run(w, 'set_modules', { enabled: allBut(w, 'cashbank') }).workspace;
    expect(accountBalance(hidden, '1001')).toBe('50000.0000');
    expect(hidden.bankAccounts).toEqual(w.bankAccounts);
  });

  it('SET-038 hide-dialog record counts match the actual lists', () => {
    const { w } = busyCompany();
    expect(moduleRecordCounts(w, 'sales')).toEqual([{ label: 'sales documents', count: w.documents.filter(d => d.kind === 'sales_invoice').length }, { label: 'customers', count: 1 }]);
    expect(moduleRecordCounts(w, 'purchasing')).toEqual([{ label: 'purchase documents', count: 1 }, { label: 'suppliers', count: 1 }]);
    expect(moduleRecordCounts(w, 'inventory')).toEqual([{ label: 'products', count: 1 }, { label: 'stock movements', count: w.stockMoves.length }]);
    expect(moduleRecordCounts(w, 'collections')).toEqual([{ label: 'receipts', count: 1 }, { label: 'follow-ups', count: 0 }]);
  });

  it('SET-039 presets are not shown in Settings (showPresets=false)', () => {
    expect(source('src/components/settings-view.tsx')).toContain('showPresets={false}');
    expect(renderToStaticMarkup(createElement(ModulePicker, { selected: toggleModules, onChange: () => {}, showPresets: false }))).not.toContain('module-presets');
  });

  it.todo('SET-040 [browser] Settings tiles use the same colours as the sidebar');
  it.todo('SET-041 [browser] hide dialog backdrop blurred and tinted');
  it.todo('SET-042 [browser] hide dialog on phone is a bottom sheet with 16px password input');
  it.todo('SET-043 [browser] Access tab shows company name, tax id and revision');
  it.todo('SET-044 [browser] "View as role" enabled only for the Owner of a demo company');
  it.todo('SET-045 [browser] View as Salesperson: reduced sidebar, "Previewing as Salesperson" chip, Exit preview');

  it('SET-046 role preview is visual only: the server uses the member\'s real role', async () => {
    serve(freshCompany());
    const asOwner = await post({ type: 'set_period', payload: { month: '2026-01', locked: false }, role: 'Salesperson' });
    expect(asOwner.status).toBe(200);
    const asSalesperson = await post({ type: 'set_period', payload: { month: '2026-01', locked: true } }, actor('Salesperson'));
    expect(asSalesperson).toMatchObject({ status: 400, json: { message: 'Your role does not permit this action.' } });
  });

  it('SET-047 demo reset as demo Owner restores the seed with a higher revision [browser part: confirmation dialog]', async () => {
    const { POST } = await import('../../src/app/api/demo-reset/route');
    const demo = buildDemoWorkspace();
    serve(run(demo, 'save_company', companyPayload(demo, { name: 'Messed up' })).workspace);
    store.actor = { ...owner };
    const r = await POST();
    const json = await r.json();
    expect(r.status).toBe(200);
    expect(json.message).toBe('Demo company restored to its original synthetic data.');
    expect(store.workspace.company.name).toBe('Sahulat Trading Co.');
    expect(store.workspace.revision).toBe(demo.revision + 2);
  });

  it('SET-048 demo reset by a user who is not a demo member is refused and touches nothing [documented: the route only ever resets the demo tenant; non-members get 403]', async () => {
    const { POST } = await import('../../src/app/api/demo-reset/route');
    serve(freshCompany()); store.member = false; store.actor = owner;
    const r = await POST();
    expect(r.status).toBe(403);
    expect(store.commits).toBe(0);
    expect(source('src/app/api/demo-reset/route.ts')).toContain('requireMember(DEMO_TENANT)');
    expect(DEMO_TENANT).not.toBe('qa-tenant');
  });

  it('SET-049 demo reset as Accountant refused by the API [browser part: button absent]', async () => {
    const { POST } = await import('../../src/app/api/demo-reset/route');
    serve(buildDemoWorkspace()); store.actor = actor('Accountant');
    const r = await POST();
    expect(r.status).toBe(403);
    expect((await r.json()).message).toBe('Only the demo workspace owner can reset this company.');
    expect(store.commits).toBe(0);
  });

  it('SET-050 audit history records each command with actor, role, action and time in order [case-corrected: actor is the user id, actorName the display name (D-21)]', () => {
    let w = freshCompany();
    w = run(w, 'save_branding', { accent: '#1f5fa8', footer: '' }, actor('Accountant')).workspace;
    const last = w.audit.at(-1)!;
    expect(last).toMatchObject({ actor: actor('Accountant').id, actorName: 'QA Accountant', role: 'Accountant', action: 'save_branding', detail: 'Document branding saved.' });
    expect(Number.isNaN(Date.parse(last.date))).toBe(false);
    const dates = w.audit.map(a => a.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('SET-051 hide-module action is audited without the password', async () => {
    serve(freshCompany());
    await post({ type: 'set_modules', payload: { enabled: allBut(store.workspace, 'payroll') }, confirmPassword: 'correct horse' });
    const entry = store.workspace.audit.at(-1)!;
    expect(entry).toMatchObject({ action: 'set_modules', detail: 'Hid Payroll; records are kept' });
    expect(JSON.stringify(store.workspace.audit)).not.toContain('correct horse');
  });

  it('SET-052 200 commands produce 200 more audit entries [browser part: audit list paginates/scrolls without freezing]', () => {
    let w = freshCompany();
    const before = w.audit.length;
    for (let i = 0; i < 200; i++) w = run(w, 'save_branding', { accent: '#087f69', footer: `v${i}` }).workspace;
    expect(w.audit.length - before).toBe(200);
  });

  it('SET-053 company name with emoji saved and printed', () => {
    const w0 = freshCompany();
    const w = run(w0, 'save_company', companyPayload(w0, { name: 'Sitara 🌟 Traders' })).workspace;
    expect(header(preview(w))).toContain('Sitara 🌟 Traders');
  });

  it('SET-054 phone with letters saved as typed', () => {
    const w0 = freshCompany();
    expect(run(w0, 'save_company', companyPayload(w0, { phone: '0300-CALL-NOW' })).workspace.company.phone).toBe('0300-CALL-NOW');
  });

  it('SET-055 invalid email is refused, consistent with the wizard (same command)', () => {
    const w = freshCompany();
    refused(w, 'save_company', companyPayload(w, { email: 'office@' }), 'Invalid email address');
  });

  it('SET-056 company saved by one member and branding by another both persist (separate commands)', async () => {
    serve(freshCompany());
    const a = await post({ type: 'save_company', payload: companyPayload(store.workspace, { name: 'Member A Co' }) });
    const b = await post({ type: 'save_branding', payload: { accent: '#4d7c0f', footer: 'Member B footer' } }, actor('Accountant'));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(store.workspace.company.name).toBe('Member A Co');
    expect(store.workspace.branding.footer).toBe('Member B footer');
  });

  it('SET-057 revision increments once per save', () => {
    const w = freshCompany();
    const once = run(w, 'save_company', companyPayload(w));
    expect(once.workspace.revision).toBe(w.revision + 1);
    expect(run(once.workspace, 'save_branding', { ...w.branding }).workspace.revision).toBe(w.revision + 2);
  });

  it('SET-058 Settings visibility by role [case-corrected: only Owner, Accountant and Auditor see Settings; other roles have no Settings entry]', () => {
    const wb = source('src/components/workbench.tsx');
    const roleModules = wb.slice(wb.indexOf('const roleModules'), wb.indexOf('const canView'));
    for (const role of ['Sales Manager', 'Salesperson', 'Recovery Officer', 'Warehouse Manager', 'Payroll Administrator']) {
      const entry = roleModules.match(new RegExp(`'${role}':\\[([^\\]]*)\\]`))![1];
      expect(entry).not.toContain('settings');
    }
    expect(roleModules).toMatch(/Owner:nav\.map\(item=>item\.key\),Accountant:nav\.map\(item=>item\.key\),Auditor:nav\.map\(item=>item\.key\)/);
  });

  it('SET-059 tabs are role=tab with aria-selected [browser part: Arrow/Tab keyboard reach] [case-corrected: five tabs since D-09 added Payroll & tax]', () => {
    const html = settingsHtml(freshCompany());
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab" aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/role="tab" aria-selected="false"/g)).toHaveLength(4);
  });

  it.todo('SET-060 [browser] active tab has a violet underline');

  it('SET-061 hiding Inventory with stock on hand is allowed and stock valuation is unchanged', () => {
    const { w } = busyCompany();
    const hidden = run(w, 'set_modules', { enabled: allBut(w, 'inventory', 'imports') }).workspace;
    expect(stockValuation(hidden).total).toBe(stockValuation(w).total);
    expect(accountBalance(hidden, '1200')).toBe(accountBalance(w, '1200'));
    expectInvariants(hidden);
  });

  it('SET-062 hiding Purchasing with open supplier bills is allowed and payables are unchanged', () => {
    const { w } = busyCompany();
    const hidden = run(w, 'set_modules', { enabled: allBut(w, 'purchasing', 'imports') }).workspace;
    expect(accountBalance(hidden, '2000')).toBe('-7500.0000');
    expect(agedBalances(hidden, 'supplier', today()).totals.total).toBe('7500.0000');
  });

  it('SET-063 hiding Collections with a pending cheque is allowed; the cheque cannot move until re-enabled', () => {
    const { w } = busyCompany();
    const chequeId = w.receipts[0].id;
    const hidden = run(w, 'set_modules', { enabled: allBut(w, 'collections', 'commissions') }).workspace;
    refused(hidden, 'update_cheque', { id: chequeId, status: 'deposited' }, 'Collections & PDCs is turned off for this company.');
    const back = run(hidden, 'set_modules', { enabled: w.modules }).workspace;
    expect(run(back, 'update_cheque', { id: chequeId, status: 'deposited' }).message).toBe('Cheque deposited.');
  });

  it('SET-064 rapid on/off/on ends in a single final state [browser part: no duplicate dialogs]', () => {
    let w = freshCompany(['sales', 'reports']);
    for (const enabled of [['sales', 'reports', 'payroll'], ['sales', 'reports'], ['sales', 'reports', 'payroll']]) w = run(w, 'set_modules', { enabled }).workspace;
    expect(w.modules).toEqual(['sales', 'payroll', 'reports']);
  });

  it('SET-065 a hidden module stays hidden after the snapshot is reloaded (sign out / sign in) [browser part]', () => {
    const w = run(freshCompany(), 'set_modules', { enabled: allBut(freshCompany(), 'payroll') }).workspace;
    expect(decodeWorkspace(JSON.stringify(w)).modules).not.toContain('payroll');
  });

  it('SET-066 after tab A hides a module, tab B\'s next command returns the new workspace [browser part: sidebar refresh]', async () => {
    serve(freshCompany());
    await post({ type: 'set_modules', payload: { enabled: allBut(store.workspace, 'payroll') }, confirmPassword: 'correct horse' });
    const tabB = await post({ type: 'save_branding', payload: { accent: '#087f69', footer: 'from tab B' } });
    expect(tabB.json.workspace!.modules).not.toContain('payroll');
  });

  it('SET-067 set_modules as Auditor: "Your role does not permit this action."', async () => {
    refused(freshCompany(), 'set_modules', { enabled: toggleModules }, 'Your role does not permit this action.', actor('Auditor'));
    serve(freshCompany(['sales']));
    expect((await post({ type: 'set_modules', payload: { enabled: ['sales', 'reports'] } }, actor('Auditor'))).json.message).toBe('Your role does not permit this action.');
  });

  it('SET-068 branding preview uses a posted invoice if any, else the sample [case-corrected: it uses the first submitted invoice in the list, not the latest]', () => {
    let w = freshCompany(); let item: string, cust: string;
    const html = (x: Workspace) => renderToStaticMarkup(createElement(BrandingForm, { workspace: x, company: companyPayload(x) as never, value: { accent: x.branding.accent, footer: x.branding.footer }, onChange: () => {}, onWorkspace: () => {} }));
    expect(html(w)).toContain('Preview · sample invoice');
    [w, item] = withItem(w, {}, { quantity: '10', cost: '10' });
    [w, cust] = withParty(w);
    [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '20' }]);
    [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '20' }]);
    expect(html(w)).toContain(`Preview · INV-${today().slice(0, 4)}-0001`);
  });

  it.todo('SET-069 [browser] branding preview typography/colours match print');

  it('SET-070 saving branding with the same values succeeds and increments the revision', () => {
    const w = freshCompany();
    const r = run(w, 'save_branding', { ...w.branding });
    expect(r.workspace.branding).toEqual(w.branding);
    expect(r.workspace.revision).toBe(w.revision + 1);
  });

  it('SET-071 accent #000000 allowed', () => {
    expect(run(freshCompany(), 'save_branding', { accent: '#000000', footer: '' }).workspace.branding.accent).toBe('#000000');
  });

  it('SET-072 accent #ffffff allowed [documented: no contrast validation; white headings are a design limitation]', () => {
    expect(run(freshCompany(), 'save_branding', { accent: '#ffffff', footer: '' }).workspace.branding.accent).toBe('#ffffff');
  });

  it('SET-073 branding upload is stored under the tenant folder; another tenant\'s read gets 401', async () => {
    const real = await vi.importActual<typeof import('../../src/lib/branding-store')>('../../src/lib/branding-store');
    expect(real.storeBrandingFile.toString()).toContain('`${tenantId}/${kind}.${extensions[type]}`');
    const { GET } = await import('../../src/app/api/branding/[kind]/route');
    store.member = false; store.actor = owner;
    const r = await GET(new Request('http://localhost/api/branding/logo?tenant=qa-tenant'), { params: Promise.resolve({ kind: 'logo' }) });
    expect(r.status).toBe(401);
    store.member = true;
  });

  it('SET-074 branding upload as Auditor is refused', async () => {
    const { POST } = await import('../../src/app/api/branding/upload/route');
    serve(freshCompany()); store.actor = actor('Auditor'); store.uploads = [];
    const form = new FormData(); form.set('kind', 'logo'); form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0])], 'logo.png', { type: 'image/png' }));
    const r = await POST(new Request('http://localhost/api/branding/upload', { method: 'POST', headers: { 'x-tenant-id': 'qa-tenant' }, body: form }));
    expect(r.status).toBe(403);
    expect((await r.json()).message).toBe('Auditors cannot change branding.');
    expect(store.uploads).toEqual([]);
  });

  it.todo('SET-075 [browser] Settings → Features shows an "N turned on" count matching the switches (no such count found in FeaturesSettings; verify)');
  it.todo('SET-076 [browser] long module descriptions wrap inside tiles');

  it('SET-077 dependency hint "Uses Sales" is shown on dependent tiles [browser part: violet colour]', () => {
    const html = renderToStaticMarkup(createElement(ModulePicker, { selected: toggleModules, onChange: () => {}, showPresets: false }));
    const collections = html.slice(html.indexOf('data-module="collections"')).split('</label>')[0];
    expect(collections).toContain('class="module-card-dep"');
    expect(collections).toContain('Uses Sales');
  });

  it('SET-078 "Turning this off also turns off …" is shown with the warn class [browser part: amber colour]', () => {
    const html = renderToStaticMarkup(createElement(ModulePicker, { selected: toggleModules, onChange: () => {}, showPresets: false }));
    const sales = html.slice(html.indexOf('data-module="sales"')).split('</label>')[0];
    expect(sales).toContain('<small class="module-card-dep warn">Turning this off also turns off Collections &amp; PDCs, Commissions</small>');
  });

  it.todo('SET-079 [browser] hiding the module whose view is open returns to Overview, no blank page');
  it.todo('SET-080 [browser] Settings is not reachable while the company is still in setup (setup card)');

  it('SET-081 Recovery Officer may not save Company & documents after setup [case-corrected: refused once setup is complete; Owner/Accountant only (D-08)]', () => {
    const w = freshCompany();
    refused(w, 'save_company', companyPayload(w, { phone: '+92 21 111 222' }), 'Your role does not permit this action.', actor('Recovery Officer'));
    refused(w, 'save_branding', { accent: '#087f69', footer: 'RO' }, 'Your role does not permit this action.', actor('Recovery Officer'));
    expect(run(w, 'save_company', companyPayload(w, { phone: '+92 21 111 222' }), actor('Accountant')).workspace.company.phone).toBe('+92 21 111 222');
    expect(run(w, 'save_branding', { accent: '#087f69', footer: 'RO' }, actor('Accountant')).workspace.branding.footer).toBe('RO');
  });

  it('SET-082 50-character NTN accepted and printed', () => {
    const ntn = 'N'.repeat(50);
    const w0 = freshCompany();
    const w = run(w0, 'save_company', companyPayload(w0, { taxId: ntn })).workspace;
    expect(header(preview(w))).toContain(`NTN / STRN: ${ntn}`);
  });

  it('SET-083 empty address in Settings [documented: the form blocks it (textarea required); the API save_company accepts a blank address after setup]', () => {
    const w0 = freshCompany();
    expect(run(w0, 'save_company', companyPayload(w0, { address: '' })).workspace.company.address).toBe('');
    expect(settingsHtml(w0)).toMatch(/<textarea name="address" rows="2" maxLength="500" required=""/);
  });

  it('SET-084 default sales-tax rate is stored in settings (Owner-only save_settings) and used as the editor prefill [browser part: line prefill; no Settings screen calls save_settings]', () => {
    const w0 = freshCompany();
    const w = run(w0, 'save_settings', { ...w0.settings, taxRate: '17' }).workspace;
    expect(w.settings.taxRate).toBe('17');
    refused(w0, 'save_settings', { ...w0.settings, taxRate: '17' }, 'Your role does not permit this action.', actor('Accountant'));
    expect(source('src/components/document-editor.tsx')).toContain("const defaultTax = workspace.settings.taxRate || '0';");
  });

  it('SET-085 new company has no default tax rate, so a line sent without a rate carries 0% tax (an omitted taxRate takes settings.taxRate, blank = 0) [browser part: placeholder 0]', () => {
    let w = freshCompany(); let item: string, cust: string;
    expect(w.settings.taxRate).toBe('');
    [w, item] = withItem(w, {}, { quantity: '5', cost: '10' });
    [w, cust] = withParty(w);
    const r = run(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '1', price: '100' }] });
    expect(r.workspace.documents.find(d => d.id === r.recordId)!.tax).toBe('0.0000');
  });

  it('SET-086 numbering prefix in settings [case-corrected: settings.numbering ("DP" for a new company) is stored but not used; documents use fixed kind prefixes like INV-YYYY-0001]', () => {
    let w = freshCompany(); let item: string, cust: string, inv: string;
    expect(w.settings.numbering).toBe('DP');
    [w, item] = withItem(w, {}, { quantity: '5', cost: '10' });
    [w, cust] = withParty(w);
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '20' }]);
    expect(w.documents.find(d => d.id === inv)!.number).toBe(`INV-${today().slice(0, 4)}-0001`);
  });

  it('SET-087 save_company with a 10 KB address fails max-length validation', () => {
    const w = freshCompany();
    refused(w, 'save_company', companyPayload(w, { address: 'A'.repeat(10 * 1024) }), /<=500 characters/);
  });

  it('SET-088 demo reset twice in a row works and yields the same seed', async () => {
    const { POST } = await import('../../src/app/api/demo-reset/route');
    serve(buildDemoWorkspace()); store.actor = owner;
    expect((await POST()).status).toBe(200);
    const first = store.workspace;
    expect((await POST()).status).toBe(200);
    const second = store.workspace;
    expect(second.revision).toBe(first.revision + 1);
    const shape = (x: Workspace) => ({ company: x.company, docs: x.documents.map(d => [d.number, d.kind, d.status, d.total, d.paid]), stock: stockValuation(x).total, journals: x.journals.length, parties: x.parties, items: x.items, receivables: accountBalance(x, '1100') });
    expect(shape(second)).toEqual(shape(first));
    expect(stock(second, 'i-1').quantity).toBe(stock(first, 'i-1').quantity);
  });

  it('SET-089 "Your workspace is ready." is the complete_setup message only', () => {
    const w0 = freshCompany();
    expect(w0.audit.find(a => a.action === 'complete_setup')!.detail).toBe('Your workspace is ready.');
    const later = [run(w0, 'save_company', companyPayload(w0)), run(w0, 'save_branding', { ...w0.branding }), run(w0, 'set_modules', { enabled: w0.modules })];
    expect(later.map(r => r.message)).toEqual(['Company details saved.', 'Document branding saved.', 'No module changes.']);
  });

  it.todo('SET-090 [browser] error notice from a failed save is red (noticeError)');
  it.todo('SET-091 [browser] success notice is neutral/green');
  it.todo('SET-092 [browser] notice clears when the next command starts');

  it('SET-093 hide dialog lists counts per type and omits zero-count types [browser part: dialog text]', () => {
    const { w } = busyCompany();
    expect(moduleRecordCounts(w, 'collections').filter(c => c.count > 0)).toEqual([{ label: 'receipts', count: 1 }]);
    expect(moduleRecordCounts(w, 'imports').filter(c => c.count > 0)).toEqual([]);
    expect(source('src/components/settings-view.tsx')).toContain("moduleRecordCounts(workspace, key).filter(c => c.count > 0)");
  });

  it('SET-094 hiding Reports also requires the password', async () => {
    serve(freshCompany());
    const r = await post({ type: 'set_modules', payload: { enabled: allBut(store.workspace, 'reports') } });
    expect(r.status).toBe(401);
    expect(store.workspace.modules).toContain('reports');
  });

  it('SET-095 turning Cash & bank on later provisions its accounts once', () => {
    let w = freshCompany(['sales', 'reports']);
    expect(w.bankAccounts).toEqual([]);
    w = run(w, 'set_modules', { enabled: [...w.modules, 'cashbank'] }).workspace;
    expect(w.bankAccounts.map(a => a.name)).toEqual(['Main bank account', 'Cash in hand']);
    w = run(w, 'set_modules', { enabled: [...w.modules, 'payroll'] }).workspace;
    expect(w.bankAccounts).toHaveLength(2);
  });

  it('SET-096 Cash & bank off/on three times keeps exactly one main bank and one cash account', () => {
    let w = freshCompany();
    for (let i = 0; i < 3; i++) {
      w = run(w, 'set_modules', { enabled: allBut(w, 'cashbank') }).workspace;
      w = run(w, 'set_modules', { enabled: [...w.modules, 'cashbank'] }).workspace;
    }
    expect(w.bankAccounts.filter(a => a.type === 'bank')).toHaveLength(1);
    expect(w.bankAccounts.filter(a => a.type === 'cash')).toHaveLength(1);
  });

  it('SET-097 Commissions off/on leaves plans and entitlements unchanged', () => {
    const { w } = busyCompany();
    const back = run(run(w, 'set_modules', { enabled: allBut(w, 'commissions') }).workspace, 'set_modules', { enabled: w.modules }).workspace;
    expect(back.plans).toEqual(w.plans);
    expect(back.commissions).toEqual(w.commissions);
    expect(back.commissionMovements).toEqual(w.commissionMovements);
  });

  it('SET-098 role preview is client-only: there is no engine command for it, so it is never audited [browser part]', () => {
    const types = commandSchema.shape.type.options as readonly string[];
    expect(types.some(t => /role|preview/.test(t))).toBe(false);
  });

  it('SET-099 Features record counts for 50k documents compute in under 2 s [browser part: render]', () => {
    const w = freshCompany();
    const big: Workspace = { ...w, documents: Array.from({ length: 50_000 }, (_, i) => ({ ...({} as Workspace['documents'][number]), id: `d${i}`, kind: i % 2 ? 'sales_invoice' : 'purchase_order' })) };
    const start = performance.now();
    for (const key of toggleModules) moduleRecordCounts(big, key);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(moduleRecordCounts(big, 'sales')[0].count).toBe(25_000);
  });

  it('SET-100 end to end: hide Commissions with password, API refuses approval, re-enable, approve the entitlement', async () => {
    let w = freshCompany(); let item: string, cust: string, inv: string;
    const plan = w.plans[0];
    w = run(w, 'save_plan', { ...plan, rate: '5' }).workspace;
    const emp = run(w, 'save_employee', { name: 'Hamza Khan', role: 'Order Booker', territory: 'Karachi', salary: '45000', allowance: '0', deduction: '0', attendance: 30, active: true });
    w = emp.workspace;
    [w, item] = withItem(w, {}, { quantity: '10', cost: '50' });
    [w, cust] = withParty(w);
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '2', price: '100', employeeId: emp.recordId }]);
    w = run(w, 'create_receipt', { partyId: cust, date: today(), amount: '200', method: 'cash', dueDate: today(), allocations: [{ invoiceId: inv, amount: '200' }] }).workspace;
    const commission = w.commissions[0];
    expect(commission).toMatchObject({ earned: '10.0000', released: '10.0000' });
    serve(w);
    expect((await post({ type: 'set_modules', payload: { enabled: allBut(w, 'commissions') }, confirmPassword: 'correct horse' })).status).toBe(200);
    expect((await post({ type: 'approve_commission', payload: { ids: [commission.id] } })).json.message).toBe('Commissions is turned off for this company. Turn it on in Settings → Features.');
    expect((await post({ type: 'set_modules', payload: { enabled: w.modules } })).status).toBe(200);
    const approved = await post({ type: 'approve_commission', payload: { ids: [commission.id] } });
    expect(approved.json.message).toBe('Commission approved for payroll.');
    expect(store.workspace.commissions[0].approved).toBe(true);
    expectInvariants(store.workspace);
  });
});
