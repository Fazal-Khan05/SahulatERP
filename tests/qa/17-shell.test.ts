/**
 * SQA pack 17 — Shell: navigation, search, notifications, switcher, Overview (NAV).
 * Executed here: the real Workbench server-rendered to static HTML (initial Overview state, before hydration) for
 * several roles and workspaces, the client command-retry function (postCommand) extracted from workbench.tsx and
 * run against a fake fetch, and static checks of the shell source and CSS.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDemoWorkspace, freshCompany, run, today, withDocument, withItem, withParty } from './helpers';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { summary } from '../../src/modules/erp/engine';
import { formatMoney } from '../../src/modules/erp/money';
import type { Actor, Role, Workspace } from '../../src/modules/erp/types';

vi.mock('@/lib/utils', () => import('../../src/lib/utils'));
vi.mock('@/lib/supabase/client', () => ({ createBrowserSupabase: () => ({ auth: {} }) }));
vi.mock('@/modules/erp/access', () => import('../../src/modules/erp/access'));
vi.mock('@/modules/erp/dates', () => import('../../src/modules/erp/dates'));
vi.mock('@/modules/erp/demo', () => import('../../src/modules/erp/demo'));
vi.mock('@/modules/erp/documents', () => import('../../src/modules/erp/documents'));
vi.mock('@/modules/erp/engine', () => import('../../src/modules/erp/engine'));
vi.mock('@/modules/erp/master-data', () => import('../../src/modules/erp/master-data'));
vi.mock('@/modules/erp/modules', () => import('../../src/modules/erp/modules'));
vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/modules/erp/reports', () => import('../../src/modules/erp/reports'));
vi.mock('@/modules/erp/types', () => import('../../src/modules/erp/types'));
vi.mock('@/components/document-preview', () => import('../../src/components/document-preview'));
import { Workbench } from '../../src/components/workbench';

const root = resolve(__dirname, '../..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf8');
const css = src('src/app/globals.css');
const wbSource = src('src/components/workbench.tsx');
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const demo = buildDemoWorkspace();
function shell(w: Workspace, role: Role = 'Owner', extra: Partial<Actor> = {}, name = 'Demo Owner') {
  const a: Actor = { id: 'u', name, role, branchIds: [], ...extra };
  return renderToStaticMarkup(createElement(Workbench, { initialWorkspace: scopeWorkspace(w, a), actor: a, memberships: [{ tenantId: w.tenantId, role, branchIds: a.branchIds, name: w.company.name, isDemo: w.demo }] }));
}
const navLabels = (html: string) => [...html.matchAll(/<button data-module="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map(m => [m[1], m[2].replace('&amp;', '&')]);
const attention = (html: string) => [...html.matchAll(/<button class="attention-row">[\s\S]*?<strong>([^<]+)<\/strong><small>(\d+) records<\/small>/g)].map(m => [m[1], Number(m[2])]);
const owner = shell(demo);

/** postCommand from workbench.tsx, type-stripped and bound to a fake fetch and an immediate timer. */
function postCommandWith(responses: (() => Response)[]) {
  const start = wbSource.indexOf('async function postCommand(');
  const fn = wbSource.slice(start, wbSource.indexOf('\n  async function command(', start));
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, init: { body: string; headers: Record<string, string> }) => { calls.push({ url, body: init.body, headers: init.headers }); return responses[Math.min(calls.length - 1, responses.length - 1)](); };
  const post = new Function('fetch', 'workspace', 'setTimeout', `${stripTypeScriptTypes(fn)}; return postCommand;`)(fetch, { tenantId: 'qa-tenant' }, (r: () => void) => r()) as (body: string) => Promise<{ response: Response; result: Record<string, unknown> }>;
  return { post, calls };
}

describe('17 shell', () => {
  it('NAV-001 sidebar lists every enabled module in order with module tiles; LIVE on Commissions', () => {
    expect(navLabels(owner).map(x => x[1])).toEqual(['Overview', 'Sales', 'Purchasing', 'Imports & costing', 'Inventory', 'Collections', 'Cash & bank', 'Commissions', 'Payroll', 'Accounting', 'Reports', 'Settings']);
    expect(owner).toContain('<span>Commissions</span><span class="new-label">LIVE</span>');
    for (const [key] of navLabels(owner)) expect(src('src/app/tokens.css')).toContain(`[data-module="${key}"] { --tile-bg:`);
  });
  it('NAV-003 active item has lilac fill and violet bar', () => {
    expect(owner).toMatch(/<button data-module="dashboard" class="nav-item active"/);
    expect(css).toContain('.nav-item.active{background:var(--accent-soft);color:var(--accent-text)}');
    expect(css).toContain('.nav-item.active::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}');
  });
  it('NAV-004 nav is disabled until hydrated so a pre-hydration click is not lost', () => {
    const buttons = [...owner.matchAll(/<button data-module="[^"]+" class="[^"]*"( disabled="")?/g)];
    expect(buttons.length).toBe(12);
    expect(buttons.every(b => b[1])).toBe(true);
  });
  it('NAV-006 role hides modules: Salesperson has no Purchasing, Cash & bank, Accounting, Payroll', () => {
    expect(navLabels(shell(demo, 'Salesperson', { employeeId: 'e-4' })).map(x => x[0])).toEqual(['dashboard', 'sales', 'collections', 'commissions']);
  });
  it('NAV-007 a module hidden in Settings → Features removes its nav item', () => {
    const w = { ...demo, modules: demo.modules.filter(m => m !== 'payroll') };
    const keys = navLabels(shell(w)).map(x => x[0]);
    expect(keys).not.toContain('payroll');
    expect(keys).toContain('settings');
  });
  it('NAV-011 switcher lists only the signed-in member\'s own memberships (built server-side from memberContext)', () => {
    const page = src('src/app/[[...path]]/page.tsx');
    expect(page).toContain('memberships={memberships.map(item => {');
    expect(src('src/lib/workspace-store.ts')).toContain(".eq('user_id', user.id).eq('active', true)");
    expect(wbSource).toContain('{memberships.map(item=>{');
  });
  it('NAV-012 top bar: date (Asia/Karachi), search, bell, avatar', () => {
    const date = new Date().toLocaleDateString('en-PK', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Karachi' });
    expect(owner).toContain(`<span class="topbar-date">${date}</span>`);
    expect(owner).toContain('aria-label="Search anything (Control or Command K)"');
    expect(owner).toMatch(/class="icon-button" aria-label="Notifications, \d+ items need attention"/);
    expect(owner).toContain('<span class="mini-avatar" aria-hidden="true">DO</span>');
  });
  it('NAV-013 date shows "Wed, 14 Oct" style and is hidden on phone', () => {
    expect(text(owner)).toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Z][a-z]{2}\b/);
    expect(css).toContain('@media(max-width:900px){.topbar-date{display:none}}');
  });
  it('NAV-024 search with regex characters is literal (substring includes, no RegExp)', () => {
    const search = wbSource.slice(wbSource.indexOf('function SearchDialog'), wbSource.indexOf('export function Workbench'));
    expect(search).toContain('.toLocaleLowerCase().includes(needle)');
    expect(search).not.toMatch(/new RegExp|\.match\(|\.test\(/);
  });
  it('NAV-029 bell badge count equals the attention items', () => {
    const items = attention(owner);
    const total = items.reduce((n, [, c]) => n + (c as number), 0);
    expect(total).toBeGreaterThan(0);
    expect(owner).toContain(`aria-label="Notifications, ${total} items need attention"`);
    expect(owner).toContain(`<span class="bell-count">${total}</span>`);
  });
  it('NAV-031 attention queues appear when relevant [case-corrected: queues are commission awaiting approval, unallocated shipment costs, open customer invoices, cheques due, follow-ups due and draft sales; there is no low-stock or overdue supplier-bill queue]', () => {
    const queues = [...wbSource.slice(wbSource.indexOf('function attentionItems'), wbSource.indexOf('function WorkspaceSwitcher')).matchAll(/\['(\w+)','([A-Z][^']+)'/g)].map(m => m[2]);
    expect(queues).toEqual(['Commission awaiting approval', 'Shipment costs unallocated', 'Open customer invoices', 'Cheques due for deposit or clearing', 'Recovery follow-ups due', 'Draft sales documents to submit']);
    let w = freshCompany(); let item: string, cust: string; [w, item] = withItem(w, {}, { quantity: '5', cost: '1' }); [w, cust] = withParty(w);
    [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '10' }], {}, false);
    expect(attention(shell(w))).toEqual([['Draft sales documents to submit', 1]]);
  });
  it('NAV-032 attention clears after the action', () => {
    let w = freshCompany(); let item: string, cust: string, doc: string; [w, item] = withItem(w, {}, { quantity: '5', cost: '1' }); [w, cust] = withParty(w);
    [w, doc] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '10' }], {}, false);
    w = run(w, 'submit_document', { id: doc }).workspace;
    expect(attention(shell(w))).toEqual([['Open customer invoices', 1]]);
    w = run(w, 'create_receipt', { partyId: cust, date: today(), amount: '10', method: 'cash', dueDate: today(), allocations: [{ invoiceId: doc, amount: '10' }] }).workspace;
    expect(attention(shell(w))).toEqual([]);
    expect(text(shell(w))).toContain('Nothing needs attention.');
  });
  it('NAV-033 attention respects role and module', () => {
    expect(attention(shell(demo, 'Warehouse Manager')).map(x => x[0])).toEqual(['Shipment costs unallocated']);
    const noImports = { ...demo, modules: demo.modules.filter(m => m !== 'imports') };
    expect(attention(shell(noImports)).map(x => x[0])).not.toContain('Shipment costs unallocated');
  });
  it('NAV-034 avatar initials come from the name', () => {
    expect(shell(demo, 'Owner', {}, 'Fazal Ahmed Khan')).toContain('<span class="avatar">FA</span>');
  });
  it('NAV-035 sign out from the profile posts to /auth/signout', () => {
    expect(owner).toMatch(/<form action="\/auth\/signout" method="post"><button class="profile">/);
  });
  it('NAV-036 Overview metrics equal the posted-record summary', () => {
    const s = summary(demo);
    const values = [...owner.matchAll(/<div class="metric-label">([^<]+)<span[\s\S]*?<\/span><\/div><strong>([^<]+)<\/strong>/g)].map(m => [m[1], m[2]]);
    expect(values).toEqual([['Total sales', formatMoney(s.sales)], ['Collections', formatMoney(s.collections)], ['Outstanding receivables', formatMoney(s.receivables)], ['Inventory value', formatMoney(s.inventory)]]);
  });
  it('NAV-037 metric cards stagger in by 40ms; reduced motion has no stagger [defect: cards never set --i, so every delay is 0]', () => {
    expect(css).toContain('.metric-grid>.metric-card{animation:view-in var(--duration-slow) var(--ease-out) backwards;animation-delay:calc(var(--i,0) * 40ms)}');
    expect(owner).toMatch(/class="metric-card" style="--i:1"/);
  });
  it('NAV-038 sales & collections chart [case-corrected: weekly totals up to 12 weeks ending at the latest activity, not 6 months; bars violet (accent) and cyan (accent-2) with legend]', () => {
    expect(owner).toMatch(/<p>Weekly totals, \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}<\/p>/);
    expect(owner).toContain('<span><i class="legend-sales"></i>Invoiced</span><span><i class="legend-collections"></i>Cleared</span>');
    expect(css).toContain('.bar.sales,.legend-sales,.legend-square.green{background:var(--accent)}');
    expect(css).toContain('.bar.collections,.legend-collections,.legend-square.mint{background:var(--accent-2)}');
    expect(wbSource).toContain('const weeks=Math.min(12,Math.max(1,span));');
  });
  it('NAV-039 chart empty state copy', () => {
    expect(text(shell(freshCompany()))).toContain('Submit an invoice or clear a receipt to see activity here.');
  });
  it('NAV-040 "Needs your attention" lists queues with counts; empty state "Nothing needs attention."', () => {
    expect(text(owner)).toContain('Needs your attention');
    expect(attention(owner).length).toBeGreaterThan(0);
    expect(text(shell(freshCompany()))).toContain('Nothing needs attention.');
  });
  it('NAV-041 recent sales shows the last 5 invoices with walk-in names and View buttons', () => {
    let w = freshCompany(); let item: string, cust: string, walk: string; [w, item] = withItem(w, {}, { quantity: '50', cost: '1' }); [w, cust] = withParty(w); [w, walk] = withParty(w, 'customer', { name: 'Walk-in customer' });
    for (let i = 0; i < 5; i++) [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '10' }]);
    [w] = withDocument(w, 'sales_invoice', walk, [{ itemId: item, quantity: '1', price: '10' }], { partyName: 'Bilal Walk' });
    const html = shell(w);
    const rows = [...html.matchAll(/<tr><td><button class="text-button">([^<]+)<\/button><\/td><td>([^<]+)<\/td>/g)].map(m => [m[1], m[2]]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual([w.documents.at(-1)!.number, 'Bilal Walk']);
    expect(html.match(/aria-label="View invoice [^"]+">View<\/button>/g)).toHaveLength(5);
  });
  it('NAV-042 welcome strip copy for ledger roles and role-limited users', () => {
    expect(text(owner)).toContain('A clear view of your day. Every figure comes from your posted records.');
    expect(text(shell(demo, 'Sales Manager'))).toContain('A clear view of your day. Figures cover the records your role and branch can see.');
  });
  it('NAV-043 no "Design partner", "Revision" or "prototype" copy anywhere in the UI', () => {
    const files = ['workbench', 'settings-view', 'setup-wizard', 'login-screen', 'reset-password', 'document-details', 'documents-list', 'reports-view', 'branding-form', 'company-form', 'module-picker'];
    for (const f of files) {
      const s = src(`src/components/${f}.tsx`);
      expect(s, f).not.toMatch(/design partner|prototype/i);
      expect(s, f).not.toMatch(/>Revision</);
    }
  });
  it('NAV-044 sidebar shows "All changes saved / Saved as you work"', () => {
    expect(owner).toContain('<strong>All changes saved</strong><small>Saved as you work</small>');
  });
  it('NAV-045 page heading description per module', () => {
    expect(owner).toContain('<p>A live view of money, stock and today’s work.</p>');
    const block = wbSource.slice(wbSource.indexOf('const descriptions'), wbSource.indexOf('// Each module'));
    const keys = [...block.matchAll(/(\w+):'[^']{10,}'/g)].map(m => m[1]);
    expect(keys).toEqual(['dashboard', 'sales', 'purchasing', 'imports', 'inventory', 'collections', 'cashbank', 'commissions', 'payroll', 'accounting', 'reports', 'settings']);
  });
  it('NAV-046 header action per module only with edit permission', () => {
    expect(wbSource).toContain("const headerActions:Partial<Record<Module,{modal:Exclude<Modal,null>;label:string}>>={sales:{modal:'sale',label:'New sales invoice'},purchasing:{modal:'purchase',label:'New purchase order'},collections:{modal:'receipt',label:'Record receipt'}};");
    expect(wbSource).toContain('{headerAction&&canEdit(role,active)&&<Button');
  });
  it('NAV-047 branch picker only with ≥2 branches', () => {
    expect(owner).toContain('aria-label="Branch filter, showing all branches"');
    expect(shell(freshCompany())).not.toContain('Branch filter');
  });
  it('NAV-049 notice: success neutral (role=status) vs error red (role=alert)', () => {
    expect(wbSource).toContain("{notice&&<div className={noticeError?'error-note':'form-note'} role={noticeError?'alert':'status'}>{notice}</div>}");
  });
  it('NAV-055 drawer applies safe-area padding', () => {
    expect(css).toContain('.sidebar.mobile-open{padding-bottom:calc(14px + env(safe-area-inset-bottom,0px))}');
    expect(css).toContain('.sidebar{padding-top:calc(22px + env(safe-area-inset-top))}');
  });
  it('NAV-056 drawer toggle has aria-expanded/aria-controls; labels unique', () => {
    expect(owner).toContain('class="mobile-menu" aria-label="Open navigation" aria-expanded="false" aria-controls="app-navigation"');
    expect(owner).toContain('<aside id="app-navigation"');
    expect(wbSource).toContain("aria-label={mobile?'Close navigation':'Open navigation'}");
    const labels = [...owner.matchAll(/aria-label="([^"]+)"/g)].map(m => m[1]).filter(l => /navigation|menu/i.test(l));
    expect(new Set(labels).size).toBe(labels.length);
  });
  it('NAV-064 footer [case-corrected: reads "SAHULAT ERP  Made for the way you do business." and "PKR · Asia/Karachi" without the extra dots]', () => {
    expect(owner).toContain('<footer class="page-footer"><span>SAHULAT ERP <span>Made for the way you do business.</span></span><span>PKR · Asia/Karachi</span></footer>');
  });
  it('NAV-065 dialogs auto-close only after follow_up and stock_transfer', () => {
    const cmd = wbSource.slice(wbSource.indexOf('async function command('), wbSource.indexOf('async function resetDemo'));
    expect(cmd).toContain("if(type==='follow_up')setModal(null);if(type==='stock_transfer')setStockTransferOpen(false);");
    expect(cmd.match(/setModal\(/g)).toHaveLength(1);
  });
  it('NAV-067 dialog close X is labelled "Close dialog"', () => {
    expect(src('src/components/ui/dialog.tsx')).toContain('<DialogPrimitive.Close className="dialog-close" aria-label="Close dialog">');
  });
  it('NAV-077 metric subtext "From posted records"', () => {
    expect(owner.match(/<small>From posted records<\/small>/g)).toHaveLength(4);
  });
  it('NAV-078 role-limited Overview says the figures cover their scope', () => {
    expect(text(shell(demo, 'Salesperson', { employeeId: 'e-4' }))).toContain('Figures cover the records your role and branch can see.');
  });
  it('NAV-079 Overview after company reset: all zero; welcome strip', () => {
    const t = text(shell(freshCompany()));
    expect(t).toContain('A clear view of your day.');
    expect([...t.matchAll(/(Total sales|Collections|Outstanding receivables|Inventory value) (Rs [\d,]+)/g)].map(m => m[2])).toEqual(['Rs 0', 'Rs 0', 'Rs 0', 'Rs 0']);
  });
  it('NAV-086 LIVE label on Commissions is a gradient pill', () => {
    expect(owner).toContain('<span class="new-label">LIVE</span>');
    expect(css).toContain('.new-label{background:var(--gradient-brand);color:#fff}');
  });
  it('NAV-087 Auditor navigation is read-only: no action buttons', () => {
    expect(wbSource).toContain("const canEdit=(role:Role,module:Module)=>role!=='Auditor'&&");
    const html = shell(demo, 'Auditor');
    expect(navLabels(html)).toHaveLength(12);
    expect(text(html)).not.toMatch(/New sales invoice|Record receipt|New purchase order|Approve/);
  });
  it('NAV-088 Salesperson gets the "New sales invoice" header action (can create)', () => {
    expect(wbSource).toContain("'Salesperson':['sales']");
    expect(wbSource).toContain("sales:{modal:'sale',label:'New sales invoice'}");
  });
  it('NAV-089 period chip removed', () => {
    expect(owner).not.toContain('period-chip');
    for (const f of ['workbench', 'settings-view', 'reports-view']) expect(src(`src/components/${f}.tsx`)).not.toContain('period-chip');
  });
  it('NAV-090 breadcrumb "Workspace" is not a link [documented]', () => {
    expect(owner).toMatch(/<span>Workspace<\/span>(<svg[\s\S]*?<\/svg>)?<strong>Overview<\/strong>/);
  });
  it('NAV-091 title tag is constant "SahulatERP · Your business, connected"', () => {
    expect(src('src/app/layout.tsx')).toContain('title: "SahulatERP · Your business, connected"');
    expect(wbSource).not.toContain('document.title');
  });
  it('NAV-092 theme-color meta is #f6f7fb', () => {
    expect(src('src/app/layout.tsx')).toContain('themeColor: "#f6f7fb"');
  });
  it('NAV-093 demo company tag appears in heading and switcher only', () => {
    expect(owner.match(/Demo workspace/g)).toHaveLength(2);
    expect(owner).toContain('<h1>Overview<span class="live-tag">Demo workspace</span></h1>');
    expect(owner).toContain('<strong>Sahulat Trading Co.</strong><small>Demo workspace</small>');
  });
  it('NAV-094 non-demo company has no tag', () => {
    expect(shell(freshCompany())).not.toContain('Demo workspace');
  });
  it('NAV-098 dev compile race (500 HTML): client retries once with the same body (same idempotency key)', async () => {
    const { post, calls } = postCommandWith([() => new Response('<html>compiling</html>', { status: 500 }), () => Response.json({ success: true, message: 'Saved' })]);
    const body = JSON.stringify({ type: 'save_company', payload: {}, idempotencyKey: 'nav-098-key' });
    const { response, result } = await post(body);
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toBe(body);
    expect(calls[1].body).toBe(body);
    expect(calls[0].headers['x-tenant-id']).toBe('qa-tenant');
    expect(response.status).toBe(200);
    expect(result).toEqual({ success: true, message: 'Saved' });
  });

  const todo: [string, string][] = [
    ['NAV-002', '[browser] clicking each item changes the view; breadcrumb "Workspace › {Module}"; URL unchanged'],
    ['NAV-005', '[browser] Tab through nav; Enter activates'],
    ['NAV-008', '[browser] switcher menu lists memberships with demo tag; current highlighted'],
    ['NAV-009', '[browser] switching company navigates with ?tenant= and shows the other company'],
    ['NAV-010', '[browser] switcher with one company shows only that company'],
    ['NAV-014', '[browser] ⌘K / Ctrl+K opens search instantly'],
    ['NAV-015', '[browser] search "INV-2026" lists documents; Enter opens the first'],
    ['NAV-016', '[browser] search customer name lists customer and documents'],
    ['NAV-017', '[browser] search walk-in typed name finds the document'],
    ['NAV-018', '[browser] search product SKU finds the product'],
    ['NAV-019', '[browser] search employee only for allowed roles'],
    ['NAV-020', '[browser] search respects module gating'],
    ['NAV-021', '[browser] search respects role scoping (Salesperson sees own docs)'],
    ['NAV-022', '[browser] empty search shows prompt text'],
    ['NAV-023', '[browser] 2-char search shows results or "type more"'],
    ['NAV-025', '[browser] Urdu search matches'],
    ['NAV-026', '[browser] arrow keys move selection; Escape closes'],
    ['NAV-027', '[browser] result click navigates to module and opens record'],
    ['NAV-028', '[browser] search with 20k records < 100 ms per keystroke'],
    ['NAV-030', '[browser] bell menu lists grouped items; click goes to module'],
    ['NAV-048', '[browser] branch picker filters views'],
    ['NAV-050', '[browser] notice clears on next command'],
    ['NAV-051', '[browser] phone: hamburger opens drawer with blurred scrim and close X'],
    ['NAV-052', '[browser] tap scrim closes drawer'],
    ['NAV-053', '[browser] tap item closes drawer and navigates'],
    ['NAV-054', '[browser] Escape closes drawer'],
    ['NAV-057', '[browser] tabbed modules (Sales, Inventory) switch tabs with aria-selected'],
    ['NAV-058', '[browser] tab state resets when switching module without crash'],
    ['NAV-059', '[browser] view transition fade/slide on module change'],
    ['NAV-060', '[browser] browser back/forward leaves no broken state'],
    ['NAV-061', '[browser] reload keeps company but returns to Overview'],
    ['NAV-062', '[browser] deep link ?tenant reload keeps the company'],
    ['NAV-063', '[browser] preview-as-role chip and Exit only for demo + Owner'],
    ['NAV-066', '[browser] stacked editor + confirm dialogs trap focus in the top one'],
    ['NAV-068', '[browser] Escape closes dialogs'],
    ['NAV-069', '[browser] overlay click behaviour consistent'],
    ['NAV-070', '[manual] first load TTI < 3 s on 4G (Lighthouse)'],
    ['NAV-071', '[browser] module switch < 100 ms'],
    ['NAV-072', '[browser] console free of errors on every module'],
    ['NAV-073', '[browser] no hydration warnings'],
    ['NAV-074', '[browser] workspace menu animates from trigger origin'],
    ['NAV-075', '[manual] touch device: no stuck hover after tap'],
    ['NAV-076', '[browser] "Draft sales documents to submit" opens Sales filtered to drafts (source navigates to Sales only)'],
    ['NAV-080', '[browser] search dialog on phone full-width with 16px input'],
    ['NAV-081', '[browser] bell menu fits on phone'],
    ['NAV-082', '[browser] long company name truncated with ellipsis in switcher'],
    ['NAV-083', '[browser] 10 companies in switcher scroll'],
    ['NAV-084', '[browser] sidebar scrolls on small height; profile visible'],
    ['NAV-085', '[browser] "Imports & costing" wraps on narrow sidebar'],
    ['NAV-095', '[manual] idle 1 hour then act: works or clean re-login'],
    ['NAV-096', '[browser] two tabs: command in one, other tab updates on its next command without data loss'],
    ['NAV-097', '[browser] offline command shows error notice; retry works'],
    ['NAV-099', '[browser] desktop zoom 200% usable without overlap'],
    ['NAV-100', '[browser] docs/DEMO-TOUR.md end to end at desktop and phone without console errors'],
  ];
  for (const [id, title] of todo) it.todo(`${id} ${title}`);
});
