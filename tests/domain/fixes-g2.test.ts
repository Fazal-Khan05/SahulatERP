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
vi.mock('@/modules/erp/master-data', () => import('../../src/modules/erp/master-data'));
import { SettingsView, TaxSettings, settingsPayload } from '../../src/components/settings-view';
import { readCsvRows } from '../../src/components/csv-import-dialog';
import { InventoryView, stockLevels } from '../../src/components/inventory-view';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { execute, stock } from '../../src/modules/erp/engine';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { toggleModules } from '../../src/modules/erp/modules';
import type { Actor, Role, ToggleModule, Workspace } from '../../src/modules/erp/types';

const owner: Actor = { id: 'g2-owner', name: 'G2 Owner', role: 'Owner', branchIds: [] };
let key = 0;
const run = (w: Workspace, type: string, payload: Record<string, unknown>, actor = owner) => execute(w, { type, payload, idempotencyKey: `g2-fix-${++key}-key` }, actor);

/** A real (non-demo) company as the setup wizard leaves it: every payroll setting blank. */
function freshCompany(modules: ToggleModule[] = [...toggleModules]) {
  let w: Workspace = { ...blankWorkspace(false), tenantId: 'g2-tenant' };
  w = run(w, 'save_company', { name: 'G2 Traders', address: '1 Bolton Market, Karachi', phone: '', email: '', taxId: '' }).workspace;
  w = run(w, 'set_modules', { enabled: modules }).workspace;
  return run(w, 'complete_setup', {}).workspace;
}
const command = async () => ({ ok: true, message: '' });
const settingsHtml = (w: Workspace, role: Role = 'Owner') => renderToStaticMarkup(createElement(SettingsView, { workspace: w, realRole: role, role, setRole: () => {}, busy: '', command, onWorkspace: () => {}, onReset: () => {}, audit: null }));
const taxHtml = (w: Workspace, readOnly = false, ownerOnly = false) => renderToStaticMarkup(createElement(TaxSettings, { workspace: w, busy: '', readOnly, ownerOnly, command }));
const csvRows = (text: string) => new Promise<{ headers: string[]; rows: Record<string, string>[]; tooMany: boolean }>(resolve => readCsvRows(text, resolve));
const productCsv = (count: number, blankEvery = 0) => 'sku,name,price\n' + Array.from({ length: count }, (_, i) => `SKU-${i},Product ${i},100\n${blankEvery && i % blankEvery === 0 ? '\n' : ''}`).join('');
const tabs = (html: string) => [...html.matchAll(/role="tab" aria-selected="(?:true|false)" class="tab[^"]*">([^<]+)</g)].map(m => m[1]);

describe('G2 form fixes', () => {
  it('D-09 Settings has a Payroll & tax tab; its payroll part shows only while Payroll is on', () => {
    const on = freshCompany();
    expect(tabs(settingsHtml(on))).toEqual(['Company &amp; documents', 'Payroll &amp; tax', 'Features', 'Access', 'Audit history']);
    const form = taxHtml(on);
    for (const label of ['Default sales-tax rate (%)', 'Employer EOBI (%)', 'Employee EOBI (%)', 'EOBI wage base (PKR)', 'Income-tax rate (%)', 'Numbering prefix', 'Approval limit (PKR)']) expect(form).toContain(label);
    for (const name of ['taxRate', 'employerEobi', 'employeeEobi', 'eobiBase', 'incomeTaxRate', 'numbering', 'approvalLimit']) expect(form).toContain(`name="${name}"`);
    expect(form).toContain('Payroll runs need both EOBI rates');

    const off = freshCompany(toggleModules.filter(m => m !== 'payroll'));
    expect(tabs(settingsHtml(off))).toEqual(['Company &amp; documents', 'Tax &amp; numbering', 'Features', 'Access', 'Audit history']);
    const taxOnly = taxHtml(off);
    expect(taxOnly).toContain('name="taxRate"');
    expect(taxOnly).not.toMatch(/EOBI|incomeTaxRate|Income-tax/);
  });

  it('D-09 the form is read-only for the Auditor and for roles that may not save settings', () => {
    const w = freshCompany();
    const auditor = taxHtml(w, true);
    expect(auditor).not.toContain('Save changes');
    expect(auditor.match(/<input [^>]*disabled=""/g)).toHaveLength(7);
    expect(auditor).not.toContain('Only the company owner');
    expect(taxHtml(w, true, true)).toContain('Only the company owner can change these settings.');
    expect(taxHtml(w)).toContain('Save changes');
  });

  it('D-09 saving the form lets create_payroll run on a fresh company', () => {
    const w0 = freshCompany();
    const w1 = run(w0, 'save_employee', { name: 'Hamza Khan', role: 'Order Booker', territory: 'Karachi', salary: '45000', allowance: '0', deduction: '0', attendance: 30, active: true }).workspace;
    expect(() => run(w1, 'create_payroll', { month: '2026-10', date: '2026-10-28' })).toThrow('Settings → Payroll');
    const typed: Record<string, string> = { taxRate: ' 17 ', employerEobi: '5', employeeEobi: '1', eobiBase: '37000', incomeTaxRate: '0', numbering: 'DP', approvalLimit: '0' };
    const payload = settingsPayload(k => typed[k] ?? null, w1.settings);
    expect(payload).toEqual({ ...typed, taxRate: '17' });
    const w2 = run(w1, 'save_settings', payload).workspace;
    expect(w2.settings).toEqual(payload);
    const created = run(w2, 'create_payroll', { month: '2026-10', date: '2026-10-28' });
    const runRecord = created.workspace.payrolls.find(p => p.id === created.recordId)!;
    expect(runRecord.lines).toHaveLength(1);
    expect(runRecord.status).toBe('draft');
  });

  it('D-37 CSV import reads 2,000 rows and stops at the first row over the limit', async () => {
    const full = await csvRows(productCsv(2000));
    expect(full).toMatchObject({ headers: ['sku', 'name', 'price'], tooMany: false });
    expect(full.rows).toHaveLength(2000);
    expect(full.rows[1999]).toEqual({ sku: 'SKU-1999', name: 'Product 1999', price: '100' });
    const over = await csvRows(productCsv(2001));
    expect(over.tooMany).toBe(true);
    expect(over.rows).toHaveLength(2000);
    // Blank lines are not rows, so they never push a file over the limit.
    const spaced = await csvRows(productCsv(2000, 3));
    expect(spaced.tooMany).toBe(false);
    expect(spaced.rows).toHaveLength(2000);
    expect(await csvRows('sku,name,price\n')).toEqual({ headers: [], rows: [], tooMany: false });
  });

  it('D-37 a 20 MB file is refused without parsing it whole', async () => {
    const row = 'QA-BULK-000000,Bulk imported product with a fairly long descriptive name for size,General,pcs,1000,800\n';
    const csv = 'sku,name,category,unit,price,cost\n' + row.repeat(Math.ceil(20 * 1024 * 1024 / row.length));
    const started = performance.now();
    const result = await csvRows(csv);
    expect(result.tooMany).toBe(true);
    expect(result.rows).toHaveLength(2000);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('D-36 stockLevels matches the engine stock() for every item and warehouse', () => {
    const w = buildDemoWorkspace();
    const levels = stockLevels(w.stockMoves);
    expect(w.stockMoves.length).toBeGreaterThan(10);
    for (const item of [...w.items, { id: 'no-such-item' }]) {
      expect(levels(item.id)).toEqual(stock(w, item.id));
      for (const warehouse of w.warehouses) expect(levels(item.id, warehouse.id)).toEqual(stock(w, item.id, warehouse.id));
    }
  });

  it('D-36 the Stock tab draws 100 rows per table for a large catalogue', () => {
    const w = buildDemoWorkspace();
    const warehouses = w.warehouses.slice(0, 3);
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: `p${i}`, sku: `P-${i}`, name: `Product ${i}`, category: 'General', hsCode: '', unit: 'pcs', price: '1', cost: '1', weight: '1', volume: '1', reorderLevel: 0 }));
    const stockMoves = items.flatMap(it => warehouses.map(x => ({ id: `${it.id}-${x.id}`, itemId: it.id, warehouseId: x.id, date: '2026-10-01', quantity: '1.0000', value: '1.0000', sourceId: 'synthetic', type: 'adjustment' as const })));
    const big = { ...w, warehouses, items, stockMoves } as Workspace;
    const started = performance.now();
    const html = renderToStaticMarkup(createElement(InventoryView, { workspace: big, actor: owner, busy: '', notice: '', command: async () => ({}), openStockTransfer: () => {} }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(html.match(/aria-label="View Product \d+"/g)).toHaveLength(100);
    expect(html).toContain('Showing 100 of 2,000 products');
    expect(html).toContain('Showing 100 of 6,000 rows');
    // A small company shows everything and no "Show more".
    expect(renderToStaticMarkup(createElement(InventoryView, { workspace: w, actor: owner, busy: '', notice: '', command: async () => ({}), openStockTransfer: () => {} }))).not.toContain('Show 100 more');
  });

  it('D-08 Company & documents is editable only for an Owner or Accountant', () => {
    const w = freshCompany();
    for (const role of ['Owner', 'Accountant'] as Role[]) {
      const html = settingsHtml(w, role);
      expect(html, role).toContain('Save changes');
      expect(html, role).not.toContain('Only the owner or an accountant can change these.');
      expect(html.match(/<input [^>]*name="name"[^>]*>/)![0], role).not.toContain('disabled');
    }
    for (const role of ['Auditor', 'Sales Manager', 'Warehouse Manager', 'Payroll Administrator'] as Role[]) {
      const html = settingsHtml(w, role);
      expect(html, role).not.toContain('Save changes');
      expect(html, role).toContain('Only the owner or an accountant can change these.');
      expect(html.match(/<input [^>]*name="name"[^>]*>/)![0], role).toContain('disabled=""');
      expect(html, role).toContain('aria-label="Upload logo" disabled=""');
    }
    // An Owner previewing a read-only role sees that role's read-only form.
    const preview = renderToStaticMarkup(createElement(SettingsView, { workspace: w, realRole: 'Owner', role: 'Auditor', setRole: () => {}, busy: '', command, onWorkspace: () => {}, onReset: () => {}, audit: null }));
    expect(preview).not.toContain('Save changes');
  });

  it('D-09 with Payroll off the form keeps the saved payroll rates (save_settings replaces every setting)', () => {
    const w = freshCompany(toggleModules.filter(m => m !== 'payroll'));
    const saved = { ...w.settings, employerEobi: '5', employeeEobi: '1', eobiBase: '37000', incomeTaxRate: '5' };
    const shown: Record<string, string> = { taxRate: '18', numbering: 'DP', approvalLimit: '0' };
    expect(settingsPayload(k => shown[k] ?? null, saved)).toEqual({ ...saved, taxRate: '18' });
  });
});
