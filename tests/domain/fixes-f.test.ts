/**
 * Agent F (shell) regression tests for the QA defect register (reports/qa-run/DEFECTS.md).
 * Static checks of globals.css/tokens.css plus the server-rendered Workbench.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    expect(css).toContain('.table-scroll:focus-visible,.branding-preview-frame:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}');
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
});
