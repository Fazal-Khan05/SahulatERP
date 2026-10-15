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
import { PayrollRuns, payrollDate } from '../../src/components/payroll-runs';
import { CustomerReceipts } from '../../src/components/receipts-list';
import { execute } from '../../src/modules/erp/engine';
import { TableCard, statusTone } from '../../src/components/table-card';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import type { Actor, Role, Workspace } from '../../src/modules/erp/types';

const actor = (role: Role): Actor => ({ id: `h-${role}`, name: `H ${role}`, role, branchIds: [] });
const command = async () => ({ ok: true, message: '' });
let key = 0;
const run = (w: Workspace, type: string, payload: Record<string, unknown>) => { const r = execute(w, { type, payload, idempotencyKey: `h-fix-${++key}-key` }, actor('Owner')); return { w: r.workspace, id: r.recordId }; };
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

  it('D-10/D-44 payroll runs: Cancel run for draft and reviewed runs only, "Cancelled" for a cancelled run, run numbers open the lines', () => {
    let w = buildDemoWorkspace();
    w = { ...w, payrolls: [], settings: { ...w.settings, employerEobi: '5', employeeEobi: '1', eobiBase: '37000', incomeTaxRate: '5' } };
    const ids: Record<string, string> = {};
    for (const [month, steps] of [['2026-05', ['reviewed', 'approved', 'paid']], ['2026-06', ['reviewed', 'approved']], ['2026-07', ['reviewed']], ['2026-08', []], ['2026-09', []]] as const) {
      const created = run(w, 'create_payroll', { month, date: `${month}-28` }); w = created.w; ids[month] = created.id!;
      for (const status of steps) w = run(w, 'update_payroll', { id: ids[month], status }).w;
    }
    w = run(w, 'cancel_payroll', { id: ids['2026-09'] }).w;
    const html = (role: Role, editable = role !== 'Auditor') => renderToStaticMarkup(createElement(PayrollRuns, { workspace: w, actor: actor(role), editable, busy: '', command }));
    const cells = (markup: string) => [...markup.matchAll(/<tr><td><button[^>]*>(PAY-[\d-]+)<\/button><\/td>(?:<td[^>]*>[^]*?<\/td>){5}<td>([^]*?)<\/td><\/tr>/g)].map(m => [m[1], m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()]);
    // Newest month first; only draft and reviewed runs offer Cancel run.
    expect(cells(html('Owner'))).toEqual([['PAY-2026-09', 'Cancelled'], ['PAY-2026-08', 'reviewed Cancel run'], ['PAY-2026-07', 'approved Cancel run'], ['PAY-2026-06', 'paid'], ['PAY-2026-05', 'Complete']]);
    expect(cells(html('Payroll Administrator'))).toEqual(cells(html('Owner')));
    expect(cells(html('Auditor'))).toEqual([['PAY-2026-09', 'Cancelled'], ['PAY-2026-08', 'Read only'], ['PAY-2026-07', 'Read only'], ['PAY-2026-06', 'Read only'], ['PAY-2026-05', 'Complete']]);
    expect(html('Auditor')).not.toContain('Create payroll');
    expect(html('Owner')).toContain('aria-label="Payroll month"');
    expect(html('Owner')).toContain('aria-expanded="false"');
  });

  it('D-10 a payroll for an earlier month is dated on its last day; the current month is dated today', () => {
    expect(payrollDate('2026-09', '2026-10-15')).toBe('2026-09-30');
    expect(payrollDate('2026-02', '2026-10-15')).toBe('2026-02-28');
    expect(payrollDate('2024-02', '2026-10-15')).toBe('2024-02-29');
    expect(payrollDate('2026-10', '2026-10-15')).toBe('2026-10-15');
  });

  it('D-66 payroll statuses each have their own badge tone; commission states stay distinct', () => {
    const payroll = ['draft', 'reviewed', 'approved', 'paid', 'cancelled'].map(statusTone);
    expect(payroll).toEqual(['draft', 'warning', 'info', 'success', 'neutral']);
    expect(new Set(['unreleased', 'pending', 'approved', 'recoverable'].slice(0, 3).map(statusTone)).size).toBe(3);
    // Unchanged elsewhere: cheques and shipments.
    expect(['received', 'deposited', 'cleared', 'bounced', 'costed'].map(statusTone)).toEqual(['warning', 'info', 'success', 'danger', 'success']);
  });

  it('D-67 TableCard right-aligns the amount columns it is given, header included', () => {
    const html = renderToStaticMarkup(createElement(TableCard, { title: 'Trial balance', heads: ['Code', 'Account', 'Net balance'], numeric: [2], rows: [['1000', 'Bank', 'Rs 5,000']] }));
    expect(html).toContain('<th>Code</th><th>Account</th><th class="num align-right">Net balance</th>');
    expect(html).toContain('<td>1000</td><td>Bank</td><td class="num align-right">Rs 5,000</td>');
  });

  it('D-40 customer receipts and shipments have filter bars and list newest first', () => {
    const w = buildDemoWorkspace();
    const receipts = renderToStaticMarkup(createElement(CustomerReceipts, { workspace: w, editable: true, onRecord: () => {} }));
    for (const label of ['aria-label="Receipt method"', 'aria-label="Receipt status"', 'role="group" aria-label="Customer receipt filters"']) expect(receipts).toContain(label);
    const customerReceipts = w.receipts.filter(r => w.parties.find(p => p.id === r.partyId)?.type !== 'supplier').map(r => r.number);
    const shown = [...receipts.matchAll(/<tr><td>([^<]+)<\/td>/g)].map(m => m[1]);
    expect(shown.length).toBeGreaterThan(1);
    expect(shown).toEqual(customerReceipts.slice().reverse());
    const imports = renderToStaticMarkup(createElement(ImportsView, { workspace: w, actor: actor('Owner'), editable: true, busy: '', command }));
    expect(imports).toContain('aria-label="Shipment status"');
    expect([...imports.matchAll(/<tr><td>(SHP-[^<]+)<\/td>/g)].map(m => m[1])).toEqual(w.shipments.map(sh => sh.number).reverse());
  });

  it('D-36 the customer receipts table draws the newest 100 receipts with "Show 100 more"', () => {
    const w = buildDemoWorkspace();
    const template = w.receipts.find(r => w.parties.find(p => p.id === r.partyId)?.type === 'customer')!;
    const bulk = { ...w, receipts: [...w.receipts, ...Array.from({ length: 300 }, (_, i) => ({ ...template, id: `h-bulk-${i}`, number: `REC-H-${1000 + i}` }))] };
    const total = bulk.receipts.filter(r => bulk.parties.find(p => p.id === r.partyId)?.type !== 'supplier').length;
    const html = renderToStaticMarkup(createElement(CustomerReceipts, { workspace: bulk, editable: false, onRecord: () => {} }));
    const shown = [...html.matchAll(/<tr><td>([^<]+)<\/td>/g)].map(m => m[1]);
    expect(shown).toHaveLength(100);
    expect(shown[0]).toBe('REC-H-1299');
    expect(html).toContain('Show 100 more</button>');
    expect(html).toContain(`Showing 100 of ${total.toLocaleString('en-PK')} receipts`);
  });
});
