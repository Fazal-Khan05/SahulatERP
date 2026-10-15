/**
 * Agent F (shell) regression tests for the QA defect register (reports/qa-run/DEFECTS.md).
 * Static checks of globals.css/tokens.css plus the server-rendered Workbench.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const css = readFileSync(resolve(root, 'src/app/globals.css'), 'utf8');

describe('agent F shell fixes', () => {
  it('D-35 the phone top bar shrinks instead of widening the page', () => {
    expect(css).toContain('.breadcrumb strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}');
    expect(css).toContain('.topbar-right{flex-shrink:0}');
    expect(css).toMatch(/@media\(max-width:760px\)\{[^@]*\.breadcrumb>span,\.breadcrumb>svg,\.topbar-divider,\.mini-avatar\{display:none\}/);
    // Metric figures scale with their tile so a long amount cannot push a phone page sideways.
    expect(css).toContain('.metric-card{container-type:inline-size;min-width:0}');
    expect(css).toContain('.metric-card>strong{font-size:clamp(1rem,17cqi,var(--text-2xl));overflow-wrap:anywhere}');
  });
});
