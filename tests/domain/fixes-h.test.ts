import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('@/lib/utils', () => import('../../src/lib/utils'));
vi.mock('@/modules/erp/modules', () => import('../../src/modules/erp/modules'));
vi.mock('@/modules/erp/documents', () => import('../../src/modules/erp/documents'));
vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/modules/erp/types', () => import('../../src/modules/erp/types'));
vi.mock('@/modules/erp/engine', () => import('../../src/modules/erp/engine'));
vi.mock('@/modules/erp/dates', () => import('../../src/modules/erp/dates'));
import { ImportsView, costClasses } from '../../src/components/imports-view';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import type { Actor, Role } from '../../src/modules/erp/types';

const actor = (role: Role): Actor => ({ id: `h-${role}`, name: `H ${role}`, role, branchIds: [] });
const command = async () => ({ ok: true, message: '' });
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/g)].map(m => m[1]);

describe('H workspace view fixes', () => {
  it('D-11 Imports offers New shipment, Add cost and Allocate only to the roles the engine allows', () => {
    const w = buildDemoWorkspace();
    expect(w.shipments.some(sh => sh.costs.some(c => !c.allocated))).toBe(true);
    const html = (role: Role, editable = role !== 'Auditor') => renderToStaticMarkup(createElement(ImportsView, { workspace: w, actor: actor(role), editable, busy: '', command }));
    expect(buttons(html('Owner'))).toEqual(expect.arrayContaining(['Add cost', 'New shipment', 'Allocate']));
    expect(buttons(html('Accountant'))).toEqual(expect.arrayContaining(['Add cost', 'New shipment', 'Allocate']));
    // add_shipment_cost and allocate_shipment are Accountant-only; the Warehouse Manager may only create shipments.
    expect(buttons(html('Warehouse Manager'))).toEqual(['New shipment']);
    expect(buttons(html('Auditor'))).toEqual([]);
    expect(html('Auditor')).toContain('Read only');
  });

  it('D-11 every cost class carries a one-line explanation, shown under the shipments table', () => {
    const html = renderToStaticMarkup(createElement(ImportsView, { workspace: buildDemoWorkspace(), actor: actor('Auditor'), editable: false, busy: '', command }));
    expect(costClasses.map(c => c.value)).toEqual(['inventory', 'recoverable_tax', 'deposit', 'expense']);
    for (const c of costClasses) { expect(c.help.length).toBeGreaterThan(20); expect(html).toContain(`<dt>${c.label}</dt>`); }
  });
});
