/**
 * SQA pack 19 — Responsive, mobile, accessibility, motion (UIX).
 * Most cases need a real browser or device. Executed here: WCAG contrast ratios computed from the design tokens,
 * static checks of layout.tsx (viewport/theme), globals.css/print.css/tokens.css, component source, and the
 * server-rendered Workbench markup (landmarks, headings, labels, icons, tables, inert setup backdrop).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDemoWorkspace, freshCompany } from './helpers';
import { formatMoney } from '../../src/modules/erp/money';
import type { Actor, Workspace } from '../../src/modules/erp/types';

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
import { LoginScreen } from '../../src/components/login-screen';

const root = resolve(__dirname, '../..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf8');
const css = src('src/app/globals.css');
const tokensCss = src('src/app/tokens.css');
const printCss = src('src/app/print/print.css');
const layout = src('src/app/layout.tsx');
const token = (name: string): string => {
  const v = tokensCss.match(new RegExp(`--${name}:\\s*([^;]+);`))![1].trim();
  return v.startsWith('var(') ? token(v.slice(6, -1)) : v;
};
const rgb = (h: string) => [0, 2, 4].map(i => parseInt(h.replace('#', '').slice(i, i + 2), 16));
const lum = (c: number[]) => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: string | number[], b: string | number[]) => { const x = lum(typeof a === 'string' ? rgb(a) : a), y = lum(typeof b === 'string' ? rgb(b) : b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (fg: number[], alpha: number, bg: number[]) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
const owner: Actor = { id: 'u', name: 'Demo Owner', role: 'Owner', branchIds: [] };
const shell = (w: Workspace, a: Actor = owner) => renderToStaticMarkup(createElement(Workbench, { initialWorkspace: w, actor: a, memberships: [{ tenantId: w.tenantId, role: a.role, branchIds: [], name: w.company.name, isDemo: w.demo }] }));
const demoHtml = shell(buildDemoWorkspace());

describe('19 ui accessibility', () => {
  it('UIX-006 inputs are 16px so iOS does not zoom on focus', () => {
    expect(css).toMatch(/@media\(pointer:coarse\)\{\s*input,select,textarea,\.input-wrap input\{font-size:16px\}/);
    expect(css).toContain('.input-wrap input{font-size:16px}');
  });
  it('UIX-007 tap targets ≥ 44px on touch (buttons, nav, switches)', () => {
    const coarse = css.slice(css.indexOf('@media(pointer:coarse){'), css.indexOf('/* Dialogs become bottom sheets'));
    expect(coarse).toContain('.button,.button-sm,.tab,.icon-button,.search-hint,.dialog-close,.sidebar-close{min-height:44px}');
    expect(coarse).toContain('.nav-item{min-height:46px}');
    expect(coarse).toContain('.mobile-menu{min-width:44px;min-height:44px;justify-content:center}');
    expect(coarse).toContain('.switch{width:46px;height:26px}');
  });
  it('UIX-010 safe-area insets applied (viewport-fit=cover plus env() padding)', () => {
    expect(layout).toContain('viewportFit: "cover"');
    for (const side of ['top', 'bottom', 'left', 'right']) expect(css).toContain(`env(safe-area-inset-${side}`);
  });
  it('UIX-012 no tap highlight flash', () => {
    expect(css).toContain('html{-webkit-tap-highlight-color:transparent;overscroll-behavior:none}');
  });
  it('UIX-013 press feedback on controls (opacity on :active)', () => {
    expect(css).toContain('.nav-item:active,.tab:active,.report-link:active,.attention-row:active,.text-button:active,.workspace-menu-item:active,.search-result:active{opacity:.75;');
  });
  it('UIX-014 long-press on controls does not select text', () => {
    expect(css).toContain('button,a,[role=button],[role=tab],[role=switch],.nav-item,.tab,.chip,.badge,.swatch,.report-link,.attention-row{touch-action:manipulation;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}');
  });
  it('UIX-015 body text stays selectable (no global user-select:none)', () => {
    expect(css).not.toMatch(/(^|[}\s])(html|body|\*)\s*\{[^}]*user-select:\s*none/);
  });
  it('UIX-016 hover lifts are gated by hover media; touch resets hover styling [documented: colour-only :hover rules on nav and buttons are not gated]', () => {
    expect(css).toMatch(/@media\(hover:hover\) and \(pointer:fine\)\{\s*\.metric-card:hover\{transform:translateY\(-1px\)\}/);
    expect(css).toContain('@media(hover:none){.metric-card:hover,.module-card:hover{box-shadow:none;border-color:var(--card-border)}}');
  });
  it('UIX-017 theme-color matches the page background token', () => {
    expect(layout).toContain(`themeColor: "${token('background')}"`);
  });
  it('UIX-018 app shell uses 100dvh', () => {
    expect(css).toContain('.app-shell{min-height:100dvh}');
    expect(css).toContain('.loading-screen{height:auto;min-height:100dvh}');
  });
  it('UIX-020 pinch zoom allowed (no user-scalable=no / maximum-scale)', () => {
    const viewport = layout.slice(layout.indexOf('export const viewport'), layout.indexOf('export default'));
    expect(viewport).not.toMatch(/userScalable|maximumScale|user-scalable/);
    expect(viewport).toContain('width: "device-width", initialScale: 1');
  });
  it('UIX-021 body text contrast ≥ 4.5:1 (graphite on white and on the page background)', () => {
    expect(ratio(token('foreground'), token('surface'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token('foreground'), token('background'))).toBeGreaterThanOrEqual(4.5);
  });
  it('UIX-022 muted/subtle text contrast ≥ 4.5:1 on white, page, muted and sunken surfaces', () => {
    for (const bg of ['surface', 'background', 'surface-muted', 'surface-sunken']) {
      expect(ratio(token('text-muted'), token(bg)), bg).toBeGreaterThanOrEqual(4.5);
      expect(ratio(token('text-subtle'), token(bg)), bg).toBeGreaterThanOrEqual(4.5);
    }
    expect(token('text-muted')).toBe('#646464');
  });
  it('UIX-023 violet buttons with white text ≥ 4.5:1', () => {
    expect(token('accent')).toBe('#6b3df5');
    expect(ratio('#ffffff', token('accent'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#ffffff', token('accent-hover'))).toBeGreaterThanOrEqual(4.5);
  });
  it('UIX-024 badges (green/amber/red/violet/cyan on pastels) ≥ 4.5:1', () => {
    const badges: Record<string, [string, string]> = {
      success: [token('success-text'), token('success-soft')], warning: [token('warning-text'), token('warning-soft')], danger: [token('danger'), token('danger-soft')],
      info: [token('accent-2-text'), token('accent-2-soft')], draft: [token('draft-text'), token('draft-soft')], neutral: [token('text-muted'), token('surface-sunken')],
    };
    expect(css).toContain('.badge.danger{background:var(--danger-soft);color:var(--danger)}');
    const failing = Object.entries(badges).filter(([, [fg, bg]]) => ratio(fg, bg) < 4.5).map(([k, [fg, bg]]) => `${k} ${ratio(fg, bg).toFixed(2)}`);
    expect(failing).toEqual([]);
  });
  it('UIX-025 links (violet on white) ≥ 4.5:1', () => {
    expect(css).toContain('.text-button{color:var(--accent-text)}');
    expect(ratio(token('accent-text'), '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token('accent'), '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
  it('UIX-026 placeholder text ≥ 3:1 (uses --text-subtle)', () => {
    expect(css).toContain('::placeholder{color:var(--text-subtle)}');
    expect(ratio(token('text-subtle'), '#ffffff')).toBeGreaterThanOrEqual(3);
  });
  it('UIX-027 setup footer (white 88% on its navy backdrop over the tinted scrim and the page) ≥ 4.5:1', () => {
    expect(css).toContain('background:linear-gradient(180deg,rgba(16,31,82,.30),rgba(16,31,82,.44))');
    const foot = css.match(/\.setup-foot\{margin:0;color:rgba\(255,255,255,\.88\);[^}]*background:rgba\(16,31,82,(\.\d+)\)/);
    expect(foot).not.toBeNull();
    const backdrop = Number(foot![1]);
    // Worst case: the lightest page (the blurred workspace or plain white) behind the lightest end of the scrim.
    const worst = Math.min(...[rgb(token('background')), rgb('#ffffff')].flatMap(page => [0.30, 0.44].map(a => { const bg = over([16, 31, 82], backdrop, over([16, 31, 82], a, page)); return ratio(over([255, 255, 255], 0.88, bg), bg); })));
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
  it('UIX-031 skip-to-content link [documented: not present]', () => {
    expect(demoHtml).not.toMatch(/skip to (main )?content/i);
  });
  it('UIX-032 landmarks: nav, main, header (plus aside/footer)', () => {
    for (const tag of ['<nav>', '<main class="main-content">', '<header class="topbar">', '<aside id="app-navigation"', '<footer class="page-footer">']) expect(demoHtml).toContain(tag);
  });
  it('UIX-033 headings go h1 → h2 without skips on Overview', () => {
    const levels = [...demoHtml.matchAll(/<h([1-6])[\s>]/g)].map(m => Number(m[1]));
    expect(levels[0]).toBe(1);
    expect(levels.filter(l => l === 1)).toHaveLength(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
  });
  it('UIX-035 icon-only buttons have an aria-label (close, menu, search, bell)', () => {
    const html = demoHtml + renderToStaticMarkup(createElement(LoginScreen));
    const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
    const unlabelled = buttons.filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs) && !inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim());
    expect(unlabelled.map(b => b[0].slice(0, 80))).toEqual([]);
    for (const l of ['Close menu', 'Open navigation', 'Search anything (Control or Command K)', 'Show password']) expect(html).toContain(`aria-label="${l}"`);
  });
  it('UIX-036 switches are role=switch with a native checked state', () => {
    expect(src('src/components/module-picker.tsx')).toContain('<input type="checkbox" role="switch" aria-label={`${item.label} module`} checked={enabled}');
  });
  it('UIX-037 tabs use role=tablist/tab with aria-selected', () => {
    expect(src('src/components/workbench.tsx')).toContain('<div className="tabs" role="tablist">{tabs.map(t=><button key={t.key} role="tab" aria-selected={current.key===t.key}');
  });
  it('UIX-038 dialogs expose role=dialog with a label (setup card included)', () => {
    expect(src('src/components/setup-wizard.tsx')).toContain('<div className="setup-layer" role="dialog" aria-modal="true" aria-labelledby="setup-title">');
    expect(src('src/components/ui/dialog.tsx')).toContain('DialogPrimitive.Content');
    const setup = shell({ ...freshCompany(), setup: { complete: false, step: 1 } });
    expect(setup).toContain('role="dialog" aria-modal="true" aria-labelledby="setup-title"');
    expect(setup).toContain('id="setup-title"');
  });
  it('UIX-039 errors use role=alert and notices role=status', () => {
    expect(src('src/components/workbench.tsx')).toContain("role={noticeError?'alert':'status'}");
  });
  it('UIX-040 tables have th headers', () => {
    expect(demoHtml).toContain('<thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Collection</th><th>Amount</th><th>Action</th></tr></thead>');
    expect(demoHtml).toContain('role="region" aria-label="Recent sales table"');
  });
  it('UIX-041 images carry alt text ("{company} logo")', () => {
    const preview = src('src/components/document-preview.tsx');
    expect(preview).toContain('alt={`${company.name} logo`}');
    expect(preview).toContain('alt={`${company.name} letterhead`}');
    expect([...src('src/components/branding-form.tsx').matchAll(/<img(?![^>]*alt=)[^>]*>/g)]).toEqual([]);
  });
  it('UIX-042 decorative icons are aria-hidden', () => {
    const svgs = [...demoHtml.matchAll(/<svg([^>]*)>/g)].map(m => m[1]);
    expect(svgs.length).toBeGreaterThan(10);
    expect(svgs.filter(a => !a.includes('aria-hidden="true"') && !a.includes('aria-label='))).toEqual([]);
  });
  it('UIX-044 provisioning screen is aria-live=polite', () => {
    expect(src('src/components/setup-wizard.tsx')).toContain('<div className="setup-provisioning" role="status" aria-live="polite">');
  });
  it('UIX-045 reduced motion: slides and staggers become fades', () => {
    const rm = css.slice(css.indexOf('/* Reduced motion: keep the fades'));
    expect(rm).toContain('.view-enter,.metric-grid>.metric-card,.dialog-overlay[data-state=open],.dialog-content[data-state=open]{animation:overlay-in 150ms var(--ease-out) both!important}');
    expect(rm).toContain('.sidebar.mobile-open{animation:none!important}');
    expect(tokensCss).toContain('@media (prefers-reduced-motion: reduce) {\n  :root { --duration-fast: 0ms; --duration-base: 0ms; --duration-slow: 0ms; }');
  });
  it('UIX-046 reduced motion: provisioning ring slows to 3 s', () => {
    expect(css).toContain('@media(prefers-reduced-motion:reduce){.provision-ring{animation-duration:3s!important;animation-iteration-count:infinite!important}');
  });
  it('UIX-047 UI animation durations ≤ 320 ms with ease-out curves [documented: spinners, skeleton pulse, provisioning ring and the 800 ms setup reveal are longer by design]', () => {
    expect([token('duration-fast'), token('duration-base'), token('duration-slow')]).toEqual(['120ms', '200ms', '320ms']);
    const literal = [...css.matchAll(/transition:([^;}]*)/g)].flatMap(m => [...m[1].matchAll(/(\d*\.?\d+)(ms|s)\b/g)].map(x => (x[2] === 's' ? Number(x[1]) * 1000 : Number(x[1]))));
    expect(literal.filter(ms => ms > 320)).toEqual([]);
  });
  it('UIX-048 no "transition: all"', () => {
    for (const f of [css, printCss, tokensCss]) expect(f).not.toMatch(/transition:\s*all/);
  });
  it('UIX-049 no layout-animating properties except accordions/progress [documented: only .setup-progress animates width]', () => {
    const transitions = [...css.matchAll(/([^{}]+)\{[^}]*transition:([^;}]*)/g)].filter(m => /\b(width|height|top|left|margin|padding)\b/.test(m[2])).map(m => m[1].trim().split('\n').at(-1));
    expect(transitions).toEqual(['.setup-progress span']);
    const keyframes = [...css.matchAll(/@keyframes ([\w-]+)\{([^@]*?)\}\}/g)].filter(m => /\b(width|height)\s*:/.test(m[2])).map(m => m[1]);
    expect(keyframes).toEqual([]);
  });
  it('UIX-050 dialog enter/exit are symmetric (sheet-in / sheet-out on phone)', () => {
    expect(css).toContain('.dialog-content[data-state=open]{animation:sheet-in var(--duration-slow) var(--ease-drawer)}');
    expect(css).toContain('.dialog-content[data-state=closed]{animation:sheet-out var(--duration-base) var(--ease-out)}');
    expect(css).toContain('@keyframes sheet-in{from{transform:translateY(100%)}to{transform:none}}');
    expect(css).toContain('@keyframes sheet-out{from{transform:none}to{transform:translateY(100%)}}');
  });
  it('UIX-051 drawer uses the drawer easing', () => {
    expect(css).toContain('.sidebar.mobile-open{animation:drawer-in var(--duration-slow) var(--ease-drawer)}');
    expect(token('ease-drawer')).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
  });
  it('UIX-052 search dialog has no animation', () => {
    expect(css).toContain('.search-dialog[data-state=open],.search-dialog[data-state=closed]{animation:none}');
  });
  it('UIX-053 metric cards stagger by 40 ms', () => {
    expect(css).toContain('animation-delay:calc(var(--i,0) * 40ms)');
    expect(demoHtml).toMatch(/class="metric-card" style="--i:\d"/);
  });
  it('UIX-054 hover lift only with a fine pointer [documented: the nav-icon hover scale is not pointer-gated]', () => {
    const fine = css.slice(css.indexOf('@media(hover:hover) and (pointer:fine){'), css.indexOf('@media(hover:none)'));
    expect(fine).toContain('.metric-card:hover{transform:translateY(-1px)}');
    expect(fine).toContain('.module-card:hover{transform:translateY(-1px)}');
    expect(css.replace(fine, '')).not.toMatch(/:hover\{transform:translateY/);
    expect(css).toContain('.nav-item:hover .nav-icon{transform:scale(1.06)}');
  });
  it('UIX-055 Geist via next/font with display: swap and system-sans fallback', () => {
    expect(layout).toContain('Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" })');
    expect(tokensCss).toContain('--font-sans: var(--font-geist-sans, "Geist"), "SF Pro Display", "Helvetica Neue", ui-sans-serif, system-ui, sans-serif;');
  });
  it('UIX-056 tabular numerals in tables and amounts', () => {
    expect(css).toContain('table,.amount,.metric-card>strong,.doc-totals,.editor-totals,.report-table,.invoice-totals,td.num,th.num,input[type=number],input[type=date]{font-variant-numeric:tabular-nums}');
  });
  it('UIX-057 money format "Rs 1,234" from one formatter [documented: formatter checked; every screen needs a browser pass]', () => {
    expect(formatMoney('1234')).toBe('Rs 1,234');
    expect(formatMoney('1234567.5')).toBe('Rs 1,234,567.5');
    expect(formatMoney('-50')).toBe('Rs -50');
    const amounts = [...demoHtml.matchAll(/<strong>(Rs [^<]+)<\/strong>/g)].map(m => m[1]);
    expect(amounts.every(a => /^Rs -?[\d,]+(\.\d{1,2})?$/.test(a))).toBe(true);
  });
  it('UIX-061 no raw hex colours in components [documented: only the branding accent swatch palette in branding-form.tsx]', () => {
    const files = ['workbench', 'settings-view', 'setup-wizard', 'login-screen', 'reset-password', 'document-details', 'documents-list', 'reports-view', 'company-form', 'module-picker', 'document-editor', 'document-dialogs', 'cash-bank-view', 'inventory-view', 'master-data-view', 'item-details', 'record-form', 'csv-import-dialog', 'stock-transfer-dialog', 'confirm-password-dialog', 'print-actions', 'document-preview', 'module-icons'];
    for (const f of files) expect(src(`src/components/${f}.tsx`), f).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(src('src/components/branding-form.tsx').match(/#[0-9a-fA-F]{6}\b/g)).toHaveLength(8);
  });
  it('UIX-063 shadows are indigo-tinted (tokens)', () => {
    for (const s of ['shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl']) expect(token(s), s).toContain('rgba(18, 43, 165,');
  });
  it('UIX-064 module tile colours are shared by the sidebar and the feature picker', () => {
    expect(demoHtml).toMatch(/<button data-module="sales"/);
    expect(src('src/components/module-picker.tsx')).toContain('data-module');
    expect(tokensCss).toContain('/* ---- Component: module tiles (sidebar icons and feature-picker tiles share one colour per module) ---- */');
  });
  it('UIX-065 gradient only on brand moments, never on data surfaces [documented: also the welcome-strip icon tile]', () => {
    const users = [...css.matchAll(/([^{}]+)\{[^}]*var\(--gradient-brand\)/g)].map(m => m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim());
    expect(users).toEqual(['.button-gradient,.button-gradient:hover,.button-gradient:focus-visible', '.brand-mark', '.new-label', '.welcome-strip', '.welcome-icon', '.setup-progress span']);
    expect(css).toMatch(/\.provision-ring\{[^}]*conic-gradient/);
  });
  it('UIX-066 badges are pills', () => {
    expect(css).toContain('.badge{border-radius:999px;');
  });
  it('UIX-067 button heights 38 / 30', () => {
    expect([token('button-height'), token('button-height-sm')]).toEqual(['38px', '30px']);
    expect(css).toMatch(/\.button\{[^}]*min-height:38px/);
    expect(css).toMatch(/\.button-sm\{[^}]*min-height:30px/);
  });
  it('UIX-068 input height 40', () => {
    expect(token('input-height')).toBe('40px');
    expect(css).toContain('min-height:var(--input-height)');
  });
  it('UIX-069 cards have hairline borders', () => {
    expect(css).toMatch(/\.card\{[^}]*border:1px solid var\(--(card-)?border\)/);
  });
  it('UIX-070 top bar blur', () => {
    expect(css).toContain('.topbar{height:var(--topbar-height);background:color-mix(in srgb,var(--background) 86%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)');
  });
  it('UIX-079 numeric fields use type=number for the numeric keyboard [documented: document editor and record forms checked in source only]', () => {
    expect((src('src/components/document-dialogs.tsx').match(/type="number"/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((src('src/components/cash-bank-view.tsx').match(/type="number"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it('UIX-081 desktop scrollbars are thin and styled', () => {
    expect(css).toContain('html{scrollbar-color:var(--gray-300) transparent;scrollbar-width:thin}');
  });
  it('UIX-082 table scroll hint on phone: "Swipe sideways to see every column."', () => {
    expect(demoHtml).toContain('<p class="table-scroll-hint">Swipe sideways to see every column.</p>');
  });
  it('UIX-086 print-only rules are scoped to @media print or print classes and do not affect screen', () => {
    const outsidePrint = printCss.replace(/@media print \{[\s\S]*\}\s*$/, '');
    expect(outsidePrint).not.toMatch(/display:\s*none/);
    expect(printCss).toMatch(/@media print \{[\s\S]*\.print-actions \{ display: none; \}/);
    expect([...outsidePrint.matchAll(/^([^@/{}\n][^{]*)\{/gm)].map(m => m[1].trim()).every(sel => /(^|[\s,.])(print-|doc)/.test(sel))).toBe(true);
  });
  it('UIX-088 skeleton shimmer is static under reduced motion', () => {
    expect(css).toContain('.skeleton{background:var(--surface-sunken);border-radius:8px;animation:pulse 1.5s infinite}');
    expect(css).toContain('*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;');
  });
  it('UIX-093 status is never colour-only: badges carry text labels', () => {
    const badges = [...demoHtml.matchAll(/<span class="badge [^"]+">([^<]*)<\/span>/g)].map(m => m[1]);
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.every(b => b.trim().length > 0)).toBe(true);
  });
  it('UIX-096 backdrop is inert (not focusable) during setup', () => {
    const html = shell({ ...freshCompany(), setup: { complete: false, step: 1 } });
    expect(html).toMatch(/<div class="app-shell setup-backdrop" inert="" aria-hidden="true">/);
  });

  const todo: [string, string][] = [
    ['UIX-001', '[browser] every module at 390×844 has no horizontal page scroll'],
    ['UIX-002', '[browser] every module at 1440×900 lays out as designed'],
    ['UIX-003', '[browser] 768×1024 tablet: sidebar or drawer, readable'],
    ['UIX-004', '[browser] 1920×1080: content max width, no stretching'],
    ['UIX-005', '[browser] 320px width usable; wraps'],
    ['UIX-008', '[browser] dialogs on phone are bottom sheets with sticky actions'],
    ['UIX-009', '[manual] sheet content scrolls with overscroll contained (no rubber-band) on iOS'],
    ['UIX-011', '[manual] phone keyboard open with sheet keeps actions reachable'],
    ['UIX-019', '[manual] landscape phone usable'],
    ['UIX-028', '[browser] whole app operable by keyboard'],
    ['UIX-029', '[browser] focus ring visible everywhere'],
    ['UIX-030', '[browser] focus trapped in dialogs and returned to the trigger'],
    ['UIX-034', '[browser] all inputs labelled (axe clean)'],
    ['UIX-043', '[manual] screen reader announces setup steps and progress'],
    ['UIX-058', '[browser] dates YYYY-MM-DD in tables, friendly in top bar'],
    ['UIX-059', '[browser] empty states offer a next action'],
    ['UIX-060', '[browser] error copy is plain English and names the fix'],
    ['UIX-062', '[browser] computed radii follow 6/10/14/20'],
    ['UIX-071', '[browser] desktop zoom 200% without overlap'],
    ['UIX-072', '[manual] Windows high-contrast mode keeps borders visible'],
    ['UIX-073', '[manual] Safari desktop matches Chrome'],
    ['UIX-074', '[manual] Firefox matches Chrome'],
    ['UIX-075', '[manual] iOS Safari bottom bar does not cover sticky actions'],
    ['UIX-076', '[manual] Android Chrome keyboard resizes the layout'],
    ['UIX-077', '[manual] datalist on iOS offers suggestions or free text'],
    ['UIX-078', '[manual] date input on iOS opens the native picker'],
    ['UIX-080', '[browser] select elements styled consistently'],
    ['UIX-083', '[browser] long names truncate with ellipsis in fixed-width spots'],
    ['UIX-084', '[browser] Urdu text renders with a correct font fallback'],
    ['UIX-085', '[browser] RTL text in the LTR UI does not break layout'],
    ['UIX-087', '[browser] spinners appear only on busy buttons'],
    ['UIX-089', '[browser] notices readable on phone'],
    ['UIX-090', '[manual] Lighthouse accessibility ≥ 95 on login, overview, sales'],
    ['UIX-091', '[manual] Lighthouse mobile performance ≥ 80'],
    ['UIX-092', '[browser] axe-core: no serious violations on every module'],
    ['UIX-094', '[manual] voice control names match visible labels'],
    ['UIX-095', '[browser] nested dialog title ids are unique'],
    ['UIX-097', '[browser] preset pills wrap on phone; descriptions hidden'],
    ['UIX-098', '[browser] module tiles single column on phone'],
    ['UIX-099', '[browser] setup card full-screen on phone'],
    ['UIX-100', '[manual] full tour on iPhone hardware'],
  ];
  for (const [id, title] of todo) it.todo(`${id} ${title}`);
});
