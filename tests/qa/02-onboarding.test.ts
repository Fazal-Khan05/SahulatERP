import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/utils', () => import('../../src/lib/utils'));
vi.mock('@/modules/erp/modules', () => import('../../src/modules/erp/modules'));
vi.mock('@/modules/erp/documents', () => import('../../src/modules/erp/documents'));
vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/modules/erp/types', () => import('../../src/modules/erp/types'));
vi.mock('@/lib/branding-store', () => import('../../src/lib/branding-store'));
const storage = vi.hoisted(() => ({ uploads: [] as { path: string; contentType: string }[], removed: [] as string[][] }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminSupabase: () => ({ storage: { from: () => ({
    upload: async (path: string, _bytes: Uint8Array, options: { contentType: string }) => { storage.uploads.push({ path, contentType: options.contentType }); return { error: null }; },
    remove: async (paths: string[]) => { storage.removed.push(paths); return { error: null }; },
    createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.example/${path}` } }),
  }) } }),
}));
vi.mock('@/lib/workspace-store', () => ({ requireMember: vi.fn(async () => { throw new Error('ACCESS_DENIED'); }), readWorkspace: vi.fn(), commitWorkspace: vi.fn() }));
import { SetupWizard } from '../../src/components/setup-wizard';
import { ModulePicker } from '../../src/components/module-picker';
import { DocumentPreview } from '../../src/components/document-preview';
import { storeBrandingFile } from '../../src/lib/branding-store';
import { documentView, sampleInvoiceView } from '../../src/modules/erp/documents';
import { decodeWorkspace } from '../../src/modules/erp/codec';
import { dependentsOf, moduleCatalogue, moduleEnabled, presets, toggleModules, withRequirements } from '../../src/modules/erp/modules';
import { accountNames, type Actor, type ToggleModule, type Workspace } from '../../src/modules/erp/types';
import { blankWorkspace, buildDemoWorkspace, expectInvariants, firstWarehouse, freshCompany, owner, actor, refused, run, today, withDocument, withItem, withParty } from './helpers';

const wizardStart = (): Workspace => ({ ...blankWorkspace(false), tenantId: 'qa-tenant' });
const company = (extra: Record<string, unknown> = {}) => ({ name: 'Rashid Traders', address: '12 Jodia Bazar, Karachi', phone: '', email: '', taxId: '', ...extra });
const me: Actor = { id: 'u-1', name: 'Fazal', role: 'Owner', branchIds: [], email: 'fazal@qa.example' };
const wizardHtml = (w: Workspace, who: Actor = me, memberships: { tenantId: string; name: string }[] = []) =>
  renderToStaticMarkup(createElement(SetupWizard, { workspace: w, actor: who, memberships, onWorkspace: () => {}, command: async () => ({ ok: true, message: '' }) }));
const pickerHtml = (selected: ToggleModule[]) => renderToStaticMarkup(createElement(ModulePicker, { selected, onChange: () => {} }));
const preview = (w: Workspace, view = sampleInvoiceView(), assets: { logoUrl?: string; letterheadUrl?: string } = {}) =>
  renderToStaticMarkup(createElement(DocumentPreview, { view, company: w.company, branding: w.branding, assets }));
const companyBlock = (html: string) => html.slice(0, html.indexOf('doc-parties'));
const png = (size = 64) => { const b = new Uint8Array(size); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]); return b; };
const jpg = (size = 64) => { const b = new Uint8Array(size); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
const file = (bytes: Uint8Array, name: string, type: string) => new File([bytes as BlobPart], name, { type });
const basics = presets.find(p => p.key === 'basics')!.modules;

describe('02 onboarding (ONB)', () => {
  it('ONB-001 fresh company starts incomplete at step 1; wizard renders "Step 1 of 4" with Company current [browser part: centred card over blur]', () => {
    const w = wizardStart();
    expect(w.setup).toEqual({ complete: false, step: 1 });
    const html = wizardHtml(w);
    expect(html).toContain('Step 1 of 4.');
    expect(html).toMatch(/<li class="current" aria-current="step"><span class="setup-step-index">1<\/span><span class="setup-step-title">Company<\/span>/);
  });

  it('ONB-002 company saved then step 2 saved; wizard shows Documents with 50% progress', () => {
    let w = run(wizardStart(), 'save_company', company()).workspace;
    w = run(w, 'save_setup_step', { step: 2 }).workspace;
    expect(w.company.name).toBe('Rashid Traders');
    expect(w.setup.step).toBe(2);
    const html = wizardHtml(w);
    expect(html).toContain('Step 2 of 4.');
    expect(html).toContain('style="width:50%"');
  });

  it('ONB-003 empty company name refused by the engine (wizard shows "Enter the company name and address." client-side)', () => {
    refused(wizardStart(), 'save_company', company({ name: '' }), /too_small|>=2/);
    refused(wizardStart(), 'complete_setup', {}, 'Enter the company name and address first.');
  });

  it('ONB-004 one-character company name refused', () => {
    refused(wizardStart(), 'save_company', company({ name: 'R' }), />=2 characters/);
    refused(wizardStart(), 'save_company', company({ name: '  R  ' }), />=2 characters/);
  });

  it('ONB-005 name filled, address empty: save_company accepts it, complete_setup refuses [documented: the wizard refuses client-side with "Enter the company name and address."; the API only refuses at complete_setup]', () => {
    const w = run(wizardStart(), 'save_company', company({ address: '' })).workspace;
    expect(w.company.address).toBe('');
    const ready = run(w, 'set_modules', { enabled: ['sales'] }).workspace;
    refused(ready, 'complete_setup', {}, 'Enter the company name and address first.');
  });

  it('ONB-006 two-character company name accepted', () => {
    expect(run(wizardStart(), 'save_company', company({ name: 'AB' })).workspace.company.name).toBe('AB');
  });

  it('ONB-007 120-character name accepted, 121 refused with max-length validation [browser part: preview overflow]', () => {
    expect(run(wizardStart(), 'save_company', company({ name: 'N'.repeat(120) })).workspace.company.name).toHaveLength(120);
    refused(wizardStart(), 'save_company', company({ name: 'N'.repeat(121) }), /<=120 characters/);
  });

  it('ONB-008 emoji and Urdu company name saved and printed in the template', () => {
    const name = 'رشید ٹریڈرز ✨';
    const w = run(wizardStart(), 'save_company', company({ name })).workspace;
    expect(w.company.name).toBe(name);
    expect(companyBlock(preview(w))).toContain(name);
  });

  it('ONB-009 leading/trailing spaces in company name are trimmed', () => {
    const w = run(wizardStart(), 'save_company', company({ name: '   Rashid Traders   ' })).workspace;
    expect(w.company.name).toBe('Rashid Traders');
    expect(w.company.logo).toBe('R');
  });

  it('ONB-010 multi-line address preserved in the company record and printed [browser part: line breaks visible in print]', () => {
    const address = 'Shop 4, Jodia Bazar\nKarachi 74000';
    const w = run(wizardStart(), 'save_company', company({ address })).workspace;
    expect(w.company.address).toBe(address);
    expect(companyBlock(preview(w))).toContain(address);
  });

  it('ONB-011 email field prefilled with the signed-in email when the company has none [browser part: editable]', () => {
    expect(wizardHtml(wizardStart())).toContain('name="email" value="fazal@qa.example"');
    const saved = run(wizardStart(), 'save_company', company({ email: 'office@rashid.example' })).workspace;
    expect(wizardHtml(saved)).toContain('name="email" value="office@rashid.example"');
  });

  it('ONB-012 invalid email "abc" refused by validation [documented: input type=email blocks in the browser; API refuses "Invalid email address"]', () => {
    refused(wizardStart(), 'save_company', company({ email: 'abc' }), 'Invalid email address');
    expect(wizardHtml(wizardStart())).toContain('type="email"');
  });

  it('ONB-013 phone "+92 300 1234567" saved and shown in the invoice header', () => {
    const w = run(wizardStart(), 'save_company', company({ phone: '+92 300 1234567' })).workspace;
    expect(w.company.phone).toBe('+92 300 1234567');
    expect(companyBlock(preview(w))).toContain('+92 300 1234567');
  });

  it('ONB-014 NTN left blank is allowed and no company "NTN / STRN" line prints', () => {
    const w = run(wizardStart(), 'save_company', company({ taxId: '' })).workspace;
    expect(companyBlock(preview(w))).not.toContain('NTN / STRN');
    const withNtn = run(w, 'save_company', company({ taxId: '1234567-8' })).workspace;
    expect(companyBlock(preview(withNtn))).toContain('NTN / STRN: 1234567-8');
  });

  it('ONB-015 progress persists: after step 1 the saved workspace reopens the wizard at step 2 with the company kept', () => {
    let w = run(wizardStart(), 'save_company', company()).workspace;
    w = run(w, 'save_setup_step', { step: 2 }).workspace;
    const reopened = decodeWorkspace(JSON.stringify(w));
    expect(reopened.setup).toEqual({ complete: false, step: 2 });
    expect(reopened.company.name).toBe('Rashid Traders');
    expect(wizardHtml(reopened)).toContain('Step 2 of 4.');
  });

  it.todo('ONB-016 [browser] Back from step 2 shows saved step-1 values with slide-left transition');

  it('ONB-017 PNG logo under 1 MB stored at <tenant>/logo.png and saved on branding [browser part: preview, "Replace logo" button]', async () => {
    const stored = await storeBrandingFile('qa-tenant', 'logo', file(png(500 * 1024), 'logo.png', 'image/png'));
    expect(stored).toEqual({ path: 'qa-tenant/logo.png' });
    const w = run(freshCompany(), 'save_branding', { accent: '#087f69', footer: '', logoPath: 'qa-tenant/logo.png' }).workspace;
    expect(w.branding.logoPath).toBe('qa-tenant/logo.png');
    expect(preview(w, sampleInvoiceView(), { logoUrl: '/api/branding/logo?tenant=qa-tenant' })).toContain('class="doc-logo"');
  });

  it('ONB-018 JPG logo accepted and stored as logo.jpg', async () => {
    expect(await storeBrandingFile('qa-tenant', 'logo', file(jpg(), 'logo.jpeg', 'image/jpeg'))).toEqual({ path: 'qa-tenant/logo.jpg' });
  });

  it('ONB-019 3 MB PNG logo refused with size message', async () => {
    expect(await storeBrandingFile('qa-tenant', 'logo', file(png(3 * 1024 * 1024), 'big.png', 'image/png'))).toEqual({ error: 'Logo must be under 1 MB.' });
  });

  it('ONB-020 PDF logo refused by type', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj');
    expect(await storeBrandingFile('qa-tenant', 'logo', file(pdf, 'logo.pdf', 'application/pdf'))).toEqual({ error: 'Upload a PNG or JPG image.' });
  });

  it('ONB-021 SVG logo refused', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await storeBrandingFile('qa-tenant', 'logo', file(svg, 'logo.svg', 'image/svg+xml'))).toEqual({ error: 'Upload a PNG or JPG image.' });
  });

  it('ONB-022 text file renamed .png with an image/png MIME is refused by byte sniffing', async () => {
    const text = new TextEncoder().encode('just some text pretending to be a png');
    expect(await storeBrandingFile('qa-tenant', 'logo', file(text, 'fake.png', 'image/png'))).toEqual({ error: 'Upload a PNG or JPG image.' });
  });

  it('ONB-023 letterhead up to 2 MB accepted and replaces the whole header in the template', async () => {
    expect(await storeBrandingFile('qa-tenant', 'letterhead', file(png(2 * 1024 * 1024), 'head.png', 'image/png'))).toEqual({ path: 'qa-tenant/letterhead.png' });
    const w = run(freshCompany(), 'save_branding', { accent: '#087f69', footer: '', letterheadPath: 'qa-tenant/letterhead.png' }).workspace;
    const html = preview(w, sampleInvoiceView(), { letterheadUrl: '/api/branding/letterhead', logoUrl: '/api/branding/logo' });
    expect(html).toContain('class="doc-letterhead"');
    expect(html).not.toContain('doc-identity');
  });

  it('ONB-024 5 MB letterhead refused', async () => {
    expect(await storeBrandingFile('qa-tenant', 'letterhead', file(png(5 * 1024 * 1024), 'head.png', 'image/png'))).toEqual({ error: 'Letterhead must be under 2 MB.' });
  });

  it('ONB-025 every accent swatch is accepted and drives the template accent variable [browser part: live preview update]', () => {
    for (const accent of ['#087f69', '#1f5fa8', '#7a3fa0', '#b94145', '#c2611a', '#2f3e4e', '#0e7490', '#4d7c0f']) {
      const w = run(freshCompany(), 'save_branding', { accent, footer: '' }).workspace;
      expect(preview(w)).toContain(`--doc-accent:${accent}`);
    }
  });

  it('ONB-026 custom hex colour saved', () => {
    expect(run(freshCompany(), 'save_branding', { accent: '#12AB9f', footer: '' }).workspace.branding.accent).toBe('#12AB9f');
  });

  it('ONB-027 custom colour "zzzzzz" refused with "Choose a colour."', () => {
    refused(freshCompany(), 'save_branding', { accent: 'zzzzzz', footer: '' }, 'Choose a colour.');
    refused(freshCompany(), 'save_branding', { accent: '#zzzzzz', footer: '' }, 'Choose a colour.');
  });

  it('ONB-028 footer with bank details appears at the bottom of the template', () => {
    const footer = 'Bank: Meezan · Account 0101-2233445';
    const html = preview(run(freshCompany(), 'save_branding', { accent: '#087f69', footer }).workspace);
    expect(html.slice(html.indexOf('doc-footer'))).toContain(footer);
  });

  it('ONB-029 500-character footer accepted (limit 1000) [browser part: wraps without overflow]', () => {
    expect(run(freshCompany(), 'save_branding', { accent: '#087f69', footer: 'F'.repeat(500) }).workspace.branding.footer).toHaveLength(500);
    refused(freshCompany(), 'save_branding', { accent: '#087f69', footer: 'F'.repeat(1001) }, /<=1000 characters/);
  });

  it('ONB-030 footer with <script> is rendered as escaped text', () => {
    const html = preview(run(freshCompany(), 'save_branding', { accent: '#087f69', footer: '<script>alert(1)</script>' }).workspace);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('ONB-031 continuing step 2 with nothing changed saves the standard template', () => {
    const w = wizardStart();
    const saved = run(w, 'save_branding', { ...w.branding }).workspace;
    expect(saved.branding).toEqual({ template: 'standard', accent: '#087f69', footer: '' });
  });

  it('ONB-032 replacing the logo overwrites the same tenant path and removes the other-format file', async () => {
    storage.uploads.length = 0; storage.removed.length = 0;
    await storeBrandingFile('qa-tenant', 'logo', file(png(), 'a.png', 'image/png'));
    await storeBrandingFile('qa-tenant', 'logo', file(jpg(), 'b.jpg', 'image/jpeg'));
    expect(storage.uploads.map(u => u.path)).toEqual(['qa-tenant/logo.png', 'qa-tenant/logo.jpg']);
    expect(storage.removed).toEqual([['qa-tenant/logo.jpg'], ['qa-tenant/logo.png']]);
  });

  it('ONB-033 a member of another tenant requesting this logo URL gets 401', async () => {
    const { GET } = await import('../../src/app/api/branding/[kind]/route');
    const response = await GET(new Request('http://localhost/api/branding/logo?tenant=qa-tenant'), { params: Promise.resolve({ kind: 'logo' }) });
    expect(response.status).toBe(401);
  });

  it('ONB-034 three presets with descriptions are rendered as pills on the Features step [browser part: desktop layout]', () => {
    expect(presets.map(p => p.label)).toEqual(['All features', 'Importer-distributor', 'Just the basics']);
    const html = pickerHtml(basics);
    for (const p of presets) expect(html).toContain(`<strong>${p.label}</strong><small>${p.description}</small>`);
  });

  it('ONB-035 "All features" turns on every module including Payroll', () => {
    const all = withRequirements(presets.find(p => p.key === 'all')!.modules);
    expect(all).toEqual(toggleModules);
    expect(all).toContain('payroll');
  });

  it('ONB-036 "Importer-distributor" turns on 8 modules without Payroll', () => {
    const d = withRequirements(presets.find(p => p.key === 'distributor')!.modules);
    expect(d).toHaveLength(8);
    expect(d).not.toContain('payroll');
  });

  it('ONB-037 "Just the basics" is Sales, Purchasing, Inventory, Cash & bank, Reports', () => {
    expect(withRequirements(basics)).toEqual(['sales', 'purchasing', 'inventory', 'cashbank', 'reports']);
  });

  it('ONB-038 basics + Commissions turns Collections on automatically (client and server)', () => {
    expect(withRequirements([...basics, 'commissions'])).toContain('collections');
    let w = run(wizardStart(), 'save_company', company()).workspace;
    w = run(w, 'set_modules', { enabled: [...basics, 'commissions'] }).workspace;
    expect(w.modules).toEqual(['sales', 'purchasing', 'inventory', 'collections', 'cashbank', 'commissions', 'reports']);
  });

  it('ONB-039 turning on Imports & costing turns on Purchasing and Inventory', () => {
    expect(withRequirements(['imports'])).toEqual(['purchasing', 'inventory', 'imports']);
  });

  it('ONB-040 turning off Sales while Commissions is on also turns off Collections and Commissions; cards warn', () => {
    expect(dependentsOf('sales', toggleModules)).toEqual(['collections', 'commissions']);
    expect(pickerHtml(toggleModules)).toContain('Turning this off also turns off Collections &amp; PDCs, Commissions');
  });

  it('ONB-041 everything off then finish: "Turn on at least one feature."', () => {
    const w = run(wizardStart(), 'save_company', company()).workspace;
    refused(w, 'complete_setup', {}, 'Turn on at least one feature.');
  });

  it('ONB-042 preset pill is active only when the selection matches exactly [browser part: deselect on change]', () => {
    expect(pickerHtml(basics).match(/module-preset active/g)).toHaveLength(1);
    expect(pickerHtml([...basics, 'payroll'])).not.toContain('module-preset active');
  });

  it('ONB-043 every module tile has icon, benefit line, description and "Will set up" line [browser part: colours]', () => {
    const html = pickerHtml([]);
    for (const m of moduleCatalogue) {
      const tile = html.slice(html.indexOf(`data-module="${m.key}"`)).split('</label>')[0];
      expect(tile).toContain('module-tile"><svg');
      expect(tile).toMatch(new RegExp(`${m.label.replace('&', '&amp;')}<small>[^<]+</small>`));
      expect(tile).toContain(`<p>${m.description}</p>`);
      expect(tile).toContain(`Will set up: ${m.setsUp.replace('&', '&amp;')}`);
    }
  });

  it.todo('ONB-044 [browser] selected tile has violet outline and lifted shadow');

  it('ONB-045 each switch is role=switch with aria-label "<Module> module" [browser part: Tab/Space keyboard]', () => {
    const html = pickerHtml([]);
    for (const m of moduleCatalogue) expect(html).toContain(`role="switch" aria-label="${m.label.replace('&', '&amp;')} module"`);
  });

  it('ONB-046 Review step lists company, documents and features with Edit buttons and a correct "N turned on" count', () => {
    let w = run(wizardStart(), 'save_company', company()).workspace;
    w = run(w, 'set_modules', { enabled: basics }).workspace;
    w = run(w, 'save_setup_step', { step: 4 }).workspace;
    const html = wizardHtml(w);
    expect(html).toContain('<h2>Company</h2>');
    expect(html).toContain('<h2>Documents</h2>');
    expect(html).toContain('<p>5 turned on</p>');
    expect(html.match(/>Edit<\/button>/g)).toHaveLength(3);
  });

  it.todo('ONB-047 [browser] Edit from Review → step 1, change name, continue through; Review shows the change');
  it.todo('ONB-048 [browser] "Create my workspace" shows provisioning ring, "Setting up {company}", staggered lines for ≥2.6 s');

  it('ONB-049 after complete_setup the company is set up and the enabled modules equal the selection [browser part: unblur, sidebar]', () => {
    const w = freshCompany(basics);
    expect(w.setup.complete).toBe(true);
    expect(w.setup.completedAt).toBeTruthy();
    expect(toggleModules.filter(m => moduleEnabled(w, m))).toEqual(basics);
  });

  it('ONB-050 accounts named in "Sets up" exist in the chart [case-corrected: the chart is a fixed list (accountNames) present for every company regardless of modules; nothing is provisioned per module]', () => {
    const w = freshCompany(['reports']);
    for (const code of ['1100', '4000', '2100', '2000', '1300', '1200', '5000']) expect(accountNames[code]).toBeTruthy();
    expect(w.bankAccounts).toEqual([]);
    expect(freshCompany(['cashbank']).bankAccounts.map(a => a.code)).toEqual(['1001', '1002']);
  });

  it('ONB-051 number series QUO/SO/DN/INV/CN and PO/GRN/BILL/PR start at 0001 for the document year [case-corrected: series are derived from existing documents on first use, not provisioned records]', () => {
    let w = freshCompany();
    let item: string, cust: string, supp: string;
    [w, item] = withItem(w, {}, { quantity: '20', cost: '50' });
    [w, cust] = withParty(w, 'customer');
    [w, supp] = withParty(w, 'supplier');
    const year = today().slice(0, 4);
    const line = [{ itemId: item, quantity: '1', price: '100' }];
    const numbers: string[] = [];
    for (const kind of ['quotation', 'sales_order', 'delivery', 'purchase_order', 'goods_receipt']) {
      let id: string;
      [w, id] = withDocument(w, kind, ['purchase_order', 'goods_receipt'].includes(kind) ? supp : cust, line, {}, false);
      numbers.push(w.documents.find(d => d.id === id)!.number);
    }
    let inv: string, bill: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, line);
    [w, bill] = withDocument(w, 'supplier_invoice', supp, line);
    const cn = run(w, 'return_document', { id: inv, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '1' }] });
    w = cn.workspace;
    const pr = run(w, 'return_document', { id: bill, lines: [{ lineId: w.documents.find(d => d.id === bill)!.lines[0].id, quantity: '1' }] });
    w = pr.workspace;
    numbers.push(...[inv, bill, cn.recordId, pr.recordId].map(id => w.documents.find(d => d.id === id)!.number));
    expect(numbers).toEqual(['QUO', 'SO', 'DN', 'PO', 'GRN', 'INV', 'BILL', 'CN', 'PR'].map(p => `${p}-${year}-0001`));
    expectInvariants(w);
  });

  it('ONB-052 Inventory on with no warehouse creates "Main branch" and "Main store"', () => {
    const w = freshCompany(['inventory']);
    expect(w.branches).toEqual([{ id: 'main', name: 'Main branch' }]);
    expect(w.warehouses).toEqual([{ id: 'main-store', name: 'Main store', branchId: 'main' }]);
  });

  it('ONB-053 Cash & bank on creates one main bank account and one cash-in-hand account', () => {
    expect(freshCompany(['cashbank']).bankAccounts).toEqual([
      { id: 'main-bank', code: '1001', name: 'Main bank account', type: 'bank', details: '' },
      { id: 'cash', code: '1002', name: 'Cash in hand', type: 'cash', details: '' },
    ]);
  });

  it('ONB-054 Commissions on creates a "Standard plan (edit me)" at 0%', () => {
    const plans = freshCompany(['sales', 'collections', 'commissions']).plans;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ name: 'Standard plan (edit me)', type: 'flat', rate: '0', effectiveTo: '2099-12-31' });
  });

  it('ONB-055 calling complete_setup twice: "Setup is already complete."', () => {
    refused(freshCompany(), 'complete_setup', {}, 'Setup is already complete.');
  });

  it('ONB-056 complete_setup via API with no modules: "Turn on at least one feature."', () => {
    refused(run(wizardStart(), 'save_company', company()).workspace, 'complete_setup', {}, 'Turn on at least one feature.');
  });

  it('ONB-057 complete_setup via API with blank company: "Enter the company name and address first."', () => {
    const w = { ...wizardStart(), company: { ...wizardStart().company, name: '', address: '' }, modules: ['sales'] as ToggleModule[] };
    refused(w, 'complete_setup', {}, 'Enter the company name and address first.');
  });

  it('ONB-058 a failed complete_setup leaves no partial module state (no warehouse/bank/plan provisioned) [browser part: card returns to Review on network drop]', () => {
    const w = { ...wizardStart(), modules: [...toggleModules] as ToggleModule[], company: { ...wizardStart().company, address: '' } };
    refused(w, 'complete_setup', {}, 'Enter the company name and address first.');
    expect(w.warehouses).toEqual([]);
    expect(w.bankAccounts).toEqual([]);
    expect(w.plans).toEqual([]);
  });

  it('ONB-059 double "Create my workspace": a retried key is a no-op and a second call is refused [case-corrected: a replay returns the original recordId and message (D-17)] [browser part: button disabled while busy]', () => {
    let w = run(wizardStart(), 'save_company', company()).workspace;
    w = run(w, 'set_modules', { enabled: ['inventory'] }).workspace;
    const first = run(w, 'complete_setup', {}, owner, 'qa-onb-059-key');
    const retry = run(first.workspace, 'complete_setup', {}, owner, 'qa-onb-059-key');
    expect([retry.recordId, retry.message]).toEqual([first.recordId, first.message]);
    expect(retry.workspace).toBe(first.workspace);
    expect(first.workspace.warehouses).toHaveLength(1);
    refused(first.workspace, 'complete_setup', {}, 'Setup is already complete.');
  });

  it.todo('ONB-060 [browser] provisioning lines = selected modules + "Opening your books" + "Preparing your workspace"');
  it.todo('ONB-061 [browser] reduced motion: provisioning lines without stagger, slow ring');

  it('ONB-062 Payroll off: create_payroll refused "Payroll is turned off for this company. Turn it on in Settings → Features."', () => {
    refused(freshCompany(basics), 'create_payroll', { month: '2026-10' }, 'Payroll is turned off for this company. Turn it on in Settings → Features.');
  });

  it('ONB-063 Imports off: create_shipment refused with the module-off message', () => {
    refused(freshCompany(basics), 'create_shipment', { documentId: 'x' }, 'Imports & costing is turned off for this company. Turn it on in Settings → Features.');
  });

  it('ONB-064 after basics, Commissions/Imports/Payroll/Collections are disabled for navigation [browser part: sidebar entries absent]', () => {
    const w = freshCompany(basics);
    for (const m of ['commissions', 'imports', 'payroll', 'collections'] as const) expect(moduleEnabled(w, m)).toBe(false);
    for (const m of ['dashboard', 'accounting', 'settings', 'sales'] as const) expect(moduleEnabled(w, m)).toBe(true);
  });

  it('ONB-065 Collections off: the receipt command for customers is refused [browser part: no "Record receipt" header button]', () => {
    let w = freshCompany(basics);
    let cust: string;
    [w, cust] = withParty(w, 'customer');
    refused(w, 'create_receipt', { partyId: cust, date: today(), amount: '1', method: 'cash', dueDate: today(), allocations: [{ invoiceId: 'x', amount: '1' }] }, 'Collections & PDCs is turned off for this company.');
  });

  it.todo('ONB-066 [browser] global search excludes records of modules that are off');
  it.todo('ONB-067 [browser] setup card at 390px: full screen, numbered steps, sticky footer, no horizontal scroll');
  it.todo('ONB-068 [browser] setup card on iPad portrait: centred with scrim, two columns on Documents');
  it.todo('ONB-069 [browser] Documents step on phone: preview below form, scrollable in card');
  it.todo('ONB-070 [browser] backdrop blurred, not clickable, not focusable (inert)');

  it('ONB-071 footer under the card says "Setting up {company} as {name}" with switch-company links and Sign out', () => {
    const html = wizardHtml(run(wizardStart(), 'save_company', company()).workspace, me, [{ tenantId: 'qa-tenant', name: 'Rashid Traders' }, { tenantId: 'other', name: 'Other Co' }]);
    expect(html).toContain('Setting up <strong>Rashid Traders</strong> as Fazal.');
    expect(html).toContain('<a href="/?tenant=other">Switch to Other Co</a>');
    expect(html).not.toContain('Switch to Rashid Traders');
    expect(html).toContain('action="/auth/signout"');
  });

  it.todo('ONB-072 [browser] switch company from the wizard footer keeps the first company\'s wizard state');
  it.todo('ONB-073 [browser] Sign out from the wizard returns to the login screen');
  it.todo('ONB-074 [browser] Escape on the setup card does nothing');

  it('ONB-075 save_setup_step out of order (4 then 2) is accepted and the wizard opens at the last saved step [documented: any step 1-4 is accepted in any order]', () => {
    let w = run(wizardStart(), 'save_setup_step', { step: 4 }).workspace;
    w = run(w, 'save_setup_step', { step: 2 }).workspace;
    expect(w.setup.step).toBe(2);
    expect(wizardHtml(w)).toContain('Step 2 of 4.');
  });

  it('ONB-076 save_setup_step 9 is a validation error', () => {
    refused(wizardStart(), 'save_setup_step', { step: 9 }, /invalid_union|Invalid input/);
  });

  it('ONB-077 set_modules with unknown key "crypto" is a validation error [defect]', () => {
    let error: unknown;
    try { run(freshCompany(), 'set_modules', { enabled: ['sales', 'crypto'] }); } catch (e) { error = e; }
    expect(error, 'unknown module key should be refused, not silently dropped').toBeInstanceOf(Error);
  });

  it('ONB-078 set_modules ["commissions"] on a new company adds Sales and Collections', () => {
    const r = run(wizardStart(), 'set_modules', { enabled: ['commissions'] });
    expect(r.workspace.modules).toEqual(['sales', 'collections', 'commissions']);
    expect(r.message).toBe('Turned on Sales, Collections & PDCs, Commissions (Sales, Collections & PDCs required)');
  });

  it('ONB-079 Continue on step 1 is disabled before hydration/while busy [browser part: spinner, disabled inputs while saving]', () => {
    expect(wizardHtml(wizardStart())).toMatch(/<button class="button button-primary" disabled="">Continue/);
  });

  it('ONB-080 Continue is rendered disabled until hydrated so an early click is not lost [browser part: real click timing]', () => {
    expect(wizardHtml(run(wizardStart(), 'save_setup_step', { step: 3 }).workspace)).toMatch(/disabled="">Continue/);
  });

  it('ONB-081 reload during step 3 shows the last saved module set, not unsaved toggles [browser part: reload]', () => {
    let w = run(wizardStart(), 'set_modules', { enabled: basics }).workspace;
    w = run(w, 'save_setup_step', { step: 3 }).workspace;
    const html = wizardHtml(decodeWorkspace(JSON.stringify(w)));
    expect(html.match(/role="switch" aria-label="[^"]+" checked=""/g)).toHaveLength(5);
    expect(html).toContain('aria-label="Payroll module"/>');
  });

  it('ONB-082 company name change after setup is not blocked by setup state', () => {
    const w = run(freshCompany(), 'save_company', company({ name: 'Renamed Co' })).workspace;
    expect(w.company.name).toBe('Renamed Co');
    expect(w.setup.complete).toBe(true);
  });

  it('ONB-083 progress bar widths are 25/50/75/100% per step [browser part: animation]', () => {
    for (const step of [1, 2, 3, 4] as const) expect(wizardHtml(run(wizardStart(), 'save_setup_step', { step }).workspace)).toContain(`style="width:${step * 25}%"`);
  });

  it('ONB-084 stepper shows check marks for done steps [browser part: visual]', () => {
    const html = wizardHtml(run(wizardStart(), 'save_setup_step', { step: 3 }).workspace);
    expect(html.match(/<li class="done"><span class="setup-step-index"><svg[^>]*lucide-check/g)).toHaveLength(2);
  });

  it.todo('ONB-085 [browser] step transition forward slides from right, back from left');

  it('ONB-086 audit after the wizard has save_company, save_setup_step, save_branding, set_modules, complete_setup', () => {
    let w = wizardStart();
    w = run(w, 'save_company', company()).workspace;
    w = run(w, 'save_setup_step', { step: 2 }).workspace;
    w = run(w, 'save_branding', { accent: '#1f5fa8', footer: 'Thanks' }).workspace;
    w = run(w, 'save_setup_step', { step: 3 }).workspace;
    w = run(w, 'set_modules', { enabled: basics }).workspace;
    w = run(w, 'save_setup_step', { step: 4 }).workspace;
    w = run(w, 'complete_setup', {}).workspace;
    expect(w.audit.map(a => a.action)).toEqual(['save_company', 'save_setup_step', 'save_branding', 'save_setup_step', 'set_modules', 'save_setup_step', 'complete_setup']);
    expect(w.audit.every(a => a.actor === 'QA Owner' && a.role === 'Owner')).toBe(true);
  });

  it('ONB-087 revision increments by exactly one per saved command', () => {
    let w = wizardStart();
    const start = w.revision;
    w = run(w, 'save_company', company()).workspace;
    expect(w.revision).toBe(start + 1);
    w = run(w, 'save_setup_step', { step: 2 }).workspace;
    expect(w.revision).toBe(start + 2);
  });

  it.todo('ONB-088 [browser] owner finishes setup while a second member is on the card; the second member\'s next action shows the workspace');

  it('ONB-089 Auditor cannot drive setup (complete_setup / save_setup_step refused) [browser part: "… is being set up" screen]', () => {
    let w = run(wizardStart(), 'save_company', company()).workspace;
    w = run(w, 'set_modules', { enabled: ['sales'] }).workspace;
    refused(w, 'complete_setup', {}, 'Your role does not permit this action.', actor('Auditor'));
    refused(w, 'save_setup_step', { step: 2 }, 'Your role does not permit this action.', actor('Auditor'));
  });

  it('ONB-090 2,000-character address is refused [case-corrected: the address limit is 500 characters (form maxLength 500, API max 500)]', () => {
    expect(run(wizardStart(), 'save_company', company({ address: 'A'.repeat(500) })).workspace.company.address).toHaveLength(500);
    refused(wizardStart(), 'save_company', company({ address: 'A'.repeat(2000) }), /<=500 characters/);
  });

  it('ONB-091 tax id "ABC-123-X" saved as typed', () => {
    expect(run(wizardStart(), 'save_company', company({ taxId: 'ABC-123-X' })).workspace.company.taxId).toBe('ABC-123-X');
  });

  it('ONB-092 footer of only spaces [case-corrected: stored as typed (not trimmed); prints an empty-looking footer paragraph]', () => {
    const w = run(freshCompany(), 'save_branding', { accent: '#087f69', footer: '   ' }).workspace;
    expect(w.branding.footer).toBe('   ');
    expect(preview(w)).toContain('<p>   </p>');
  });

  it.todo('ONB-093 [browser] logo upload while offline shows a clear error and can be retried');

  it('ONB-094 path-traversal filename is ignored: stored at <tenant>/logo.png; a foreign logoPath is refused', async () => {
    expect(await storeBrandingFile('qa-tenant', 'logo', file(png(), '../../x.png', 'image/png'))).toEqual({ path: 'qa-tenant/logo.png' });
    refused(freshCompany(), 'save_branding', { accent: '#087f69', footer: '', logoPath: '../../x.png' }, 'Branding files must belong to this company.');
    refused(freshCompany(), 'save_branding', { accent: '#087f69', footer: '', logoPath: 'other-tenant/logo.png' }, 'Branding files must belong to this company.');
  });

  it('ONB-095 branding saved in the wizard is the same record Settings → Company & documents reads [browser part: Settings screen]', () => {
    let w = run(wizardStart(), 'save_branding', { accent: '#7a3fa0', footer: 'Bank: HBL' }).workspace;
    w = run(run(w, 'save_company', company()).workspace, 'set_modules', { enabled: ['sales'] }).workspace;
    w = run(w, 'complete_setup', {}).workspace;
    expect(w.branding).toMatchObject({ accent: '#7a3fa0', footer: 'Bank: HBL' });
  });

  it('ONB-096 invoice printed after setup carries logo, accent, footer and NTN as entered', () => {
    let w = freshCompany(undefined, { taxId: '7654321-0' });
    w = run(w, 'save_branding', { accent: '#b94145', footer: 'Bank: Meezan 0101', logoPath: 'qa-tenant/logo.png' }).workspace;
    let item: string, cust: string, inv: string;
    [w, item] = withItem(w, {}, { quantity: '5', cost: '60' });
    [w, cust] = withParty(w);
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    const html = preview(w, documentView(w, w.documents.find(d => d.id === inv)!), { logoUrl: '/api/branding/logo?tenant=qa-tenant' });
    expect(html).toContain('--doc-accent:#b94145');
    expect(html).toContain('class="doc-logo"');
    expect(html).toContain('Bank: Meezan 0101');
    expect(companyBlock(html)).toContain('NTN / STRN: 7654321-0');
  });

  it.todo('ONB-097 [manual] company reset by script while signed in; next navigation shows the setup card (needs hosted Supabase)');

  it('ONB-098 demo company is always seeded complete (and decodes as complete) so no setup card shows', () => {
    expect(buildDemoWorkspace().setup.complete).toBe(true);
    expect(blankWorkspace(true).setup.complete).toBe(true);
    const { setup: _setup, ...legacy } = blankWorkspace(true);
    expect(decodeWorkspace(legacy).setup.complete).toBe(true);
  });

  it.todo('ONB-099 [browser] All features on a slow connection: provisioning completes, no half-provisioned sidebar');

  it('ONB-100 end to end: fresh tenant → four steps → create → first invoice renders [browser part: no console errors, real print]', () => {
    let w = wizardStart();
    w = run(w, 'save_company', company({ taxId: '1234567-8', phone: '+92 300 1234567' })).workspace;
    w = run(w, 'save_setup_step', { step: 2 }).workspace;
    w = run(w, 'save_branding', { accent: '#1f5fa8', footer: 'Thank you' }).workspace;
    w = run(w, 'save_setup_step', { step: 3 }).workspace;
    w = run(w, 'set_modules', { enabled: presets.find(p => p.key === 'distributor')!.modules }).workspace;
    w = run(w, 'save_setup_step', { step: 4 }).workspace;
    w = run(w, 'complete_setup', {}).workspace;
    expect(w.setup.complete).toBe(true);
    let item: string, cust: string, inv: string;
    [w, item] = withItem(w, {}, { quantity: '10', cost: '60', warehouseId: firstWarehouse(w) });
    [w, cust] = withParty(w);
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '2', price: '100' }]);
    const doc = w.documents.find(d => d.id === inv)!;
    expect(doc.number).toBe(`INV-${today().slice(0, 4)}-0001`);
    const html = preview(w, documentView(w, doc));
    expect(html).toContain('Rashid Traders');
    expect(html).toContain(doc.number);
    expectInvariants(w);
  });
});
