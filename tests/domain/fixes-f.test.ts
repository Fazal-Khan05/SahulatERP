/**
 * Agent F (shell) regression tests for the QA defect register (reports/qa-run/DEFECTS.md).
 * Static checks of globals.css/tokens.css plus the server-rendered Workbench.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { scopeWorkspace } from '../../src/modules/erp/access';
import type { Actor, Workspace } from '../../src/modules/erp/types';

// The domain vitest config has no "@/" alias; point the Workbench imports at the sources.
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
const css = readFileSync(resolve(root, 'src/app/globals.css'), 'utf8');
const tokensCss = readFileSync(resolve(root, 'src/app/tokens.css'), 'utf8');
const token = (name: string): string => {
  const v = tokensCss.match(new RegExp(`--${name}:\\s*([^;]+);`))![1].trim();
  return v.startsWith('var(') ? token(v.slice(6, -1)) : v;
};
const rgb = (h: string) => [0, 2, 4].map(i => parseInt(h.replace('#', '').slice(i, i + 2), 16));
const lum = (c: number[]) => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: string, b: string) => { const x = lum(rgb(a)), y = lum(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const member = (role: Actor['role'], branchIds: string[] = []): Actor => ({ id: 'f-member', name: 'F Member', role, branchIds });
/** The Workbench as the server renders it for a member, from the workspace the server would send them. */
const shell = (w: Workspace, a: Actor) => renderToStaticMarkup(createElement(Workbench, { initialWorkspace: scopeWorkspace(w, a), actor: a, memberships: [{ tenantId: w.tenantId, role: a.role, branchIds: a.branchIds, name: w.company.name, isDemo: w.demo }] }));
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('agent F shell fixes', () => {
  it('D-35 the phone top bar shrinks instead of widening the page', () => {
    expect(css).toContain('.breadcrumb strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}');
    expect(css).toContain('.topbar-right{flex-shrink:0}');
    expect(css).toMatch(/@media\(max-width:760px\)\{[^@]*\.breadcrumb>span,\.breadcrumb>svg,\.topbar-divider,\.mini-avatar\{display:none\}/);
    // Metric figures scale with their tile so a long amount cannot push a phone page sideways.
    expect(css).toContain('.metric-card{container-type:inline-size;min-width:0}');
    expect(css).toContain('.metric-card>strong{font-size:clamp(1rem,17cqi,var(--text-2xl));overflow-wrap:anywhere}');
  });
  it('D-62 tablet metric tiles wrap two per row below 960 px', () => {
    expect(css).toContain('@media(max-width:960px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}');
  });
  it('D-47 danger text, the setup footer and scroll regions meet contrast and focus rules', () => {
    expect(ratio(token('danger'), token('danger-soft'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#ffffff', token('danger'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#ffffff', token('danger-hover'))).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/\.setup-foot\{[^}]*background:rgba\(16,31,82,\.7\)/);
    // Owners mark scroll wrappers tabIndex={0} role="region" aria-label=…; any such region gets the ring too.
    expect(css).toContain('.table-scroll:focus-visible,.branding-preview-frame:focus-visible,[role=region][tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}');
  });
  it('D-61 the search input is 16px on touch and phone so iOS does not zoom', () => {
    expect(css).toContain('@media(pointer:coarse),(max-width:760px){.search-dialog .search-input{font-size:16px}}');
    expect(css.indexOf('@media(pointer:coarse),(max-width:760px){.search-dialog .search-input')).toBeGreaterThan(css.indexOf('.search-dialog .search-input{min-height:48px;font-size:var(--text-md)}'));
  });
  it('D-63 phone bottom sheets have square bottom corners', () => {
    const sheet = '@media(max-width:760px){.dialog-content{border-radius:20px 20px 0 0}}';
    expect(css).toContain(sheet);
    // It must come after the colour layer's .dialog-content{border-radius:20px}, which would otherwise win.
    expect(css.indexOf(sheet)).toBeGreaterThan(css.indexOf('.dialog-content{border-radius:20px;box-shadow:var(--shadow-xl)}'));
  });
  it('D-64 card hover styles only apply with a mouse, and the entrance animation does not pin the transform', () => {
    const fine = css.slice(css.indexOf('@media(hover:hover) and (pointer:fine){'), css.indexOf('@media(hover:none)'));
    expect(fine).toContain('.metric-card:hover{border-color:var(--border-strong);box-shadow:var(--shadow-sm)}');
    expect(css.replace(fine, '')).not.toMatch(/\.metric-card:hover\{[^}]*box-shadow:var\(--shadow/);
    expect(css).toMatch(/\.metric-grid>\.metric-card\{animation:view-in [^;}]* backwards;/);
  });
  it('D-53 under reduced motion the provisioning ring turns slowly instead of freezing', () => {
    expect(css).toContain('@media(prefers-reduced-motion:reduce){.provision-ring{animation-duration:3s!important;animation-iteration-count:infinite!important}');
  });
  it('D-71 every border radius in globals.css is on the 6/10/14/20 scale (or a pill/circle)', () => {
    const ok = (v: string) => /^(0|0px|6px|10px|14px|20px|999px|50%|100%|var\(--[\w-]+\))$/.test(v);
    const stray = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, sel, body]) => [...body.matchAll(/border-radius:([^;]+)/g)].map(m => [sel.trim().split('\n').pop()!.trim(), m[1].trim()] as const))
      .filter(([sel]) => !sel.includes('::before')) // the 3px active-nav bar is a pseudo-element
      .filter(([sel, v]) => !(sel === '.skeleton' && v === '8px')) // legacy rule pinned by UIX-088; overridden by the token rule below it
      .filter(([, v]) => !v.split(/\s+/).every(ok));
    expect(stray).toEqual([]);
  });
  it('D-58 the sidebar switcher truncates a long company name with an ellipsis', () => {
    expect(css).toContain('.workspace-picker>span:not(.company-icon){min-width:0;flex:1}');
    expect(css).toContain('.workspace-picker strong,.workspace-picker small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}');
  });
  it('D-56 each metric card carries its stagger index', () => {
    const wb = readFileSync(resolve(root, 'src/components/workbench.tsx'), 'utf8');
    expect(wb).toContain("<section className=\"metric-card\" key={name} style={{'--i':index} as CSSProperties}>");
    expect(css).toContain('animation-delay:calc(var(--i,0) * 40ms)');
  });
  it('D-13 a branch-limited Accountant or Owner gets the scoped Overview, not company ledger figures built from no journals', () => {
    const w = buildDemoWorkspace();
    for (const role of ['Accountant', 'Owner'] as const) {
      const limited = text(shell(w, member(role, ['karachi'])));
      expect(limited, role).toContain('Figures cover the records your role and branch can see.');
      expect(limited, role).toContain('Invoiced sales (net)');
      expect(limited, role).not.toContain('Total sales');
    }
    const full = text(shell(w, member('Accountant')));
    expect(full).toContain('Every figure comes from your posted records.');
    expect(full).toContain('Total sales');
  });
  it('D-34 a 401 from a command (session ended elsewhere) sends the member to sign in instead of showing AUTH_REQUIRED', async () => {
    const wb = readFileSync(resolve(root, 'src/components/workbench.tsx'), 'utf8');
    const helperAt = wb.indexOf('const sessionEnded=');
    const helper = wb.slice(helperAt, wb.indexOf('\n', helperAt));
    const body = wb.slice(wb.indexOf('  async function command('), wb.indexOf('\n  async function resetDemo('));
    /** command() and signInAgain() from workbench.tsx, type-stripped, with the component state replaced by recorders. */
    async function send(status: number, json: Record<string, unknown>) {
      const seen = { notices: [] as string[], errors: [] as boolean[], assigned: [] as string[] };
      const response = new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
      const make = new Function('postCommand', 'setBusy', 'setNotice', 'setNoticeError', 'setWorkspace', 'setModal', 'setStockTransferOpen', 'workspace', 'window', 'crypto',
        `${stripTypeScriptTypes(helper)}\n${stripTypeScriptTypes(body)}\nreturn command;`);
      const command = make(async () => ({ response, result: json }), () => undefined, (n: string) => seen.notices.push(n), (e: boolean) => seen.errors.push(e), () => undefined, () => undefined, () => undefined,
        { tenantId: 'qa tenant/1' }, { location: { assign: (url: string) => seen.assigned.push(url) } }, { randomUUID: () => 'k' }) as (type: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; message: string }>;
      return { result: await command('save_branch', { name: 'After sign-out' }), ...seen };
    }
    const ended = await send(401, { success: false, message: 'AUTH_REQUIRED' });
    expect(ended.assigned).toEqual(['/?tenant=qa%20tenant%2F1']);
    expect(ended.notices.filter(Boolean)).toEqual(['Your session has ended. Taking you to sign in…']);
    expect(ended.errors).not.toContain(true);
    expect(ended.result.ok).toBe(false);
    // A wrong confirmation password is also a 401, but the member stays signed in and the dialog shows it.
    const password = await send(401, { success: false, message: 'Incorrect password.', passwordRequired: true });
    expect(password.assigned).toEqual([]);
    expect(password.notices.filter(Boolean)).toEqual([]);
    // Other refusals still show the red error notice.
    const denied = await send(403, { success: false, message: 'ACCESS_DENIED' });
    expect(denied.assigned).toEqual([]);
    expect(denied.notices.filter(Boolean)).toEqual(['ACCESS_DENIED']);
    expect(denied.errors).toContain(true);
  });
});
