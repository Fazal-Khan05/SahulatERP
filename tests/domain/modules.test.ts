import { describe, expect, it } from 'vitest';
import { decodeWorkspace } from '../../src/modules/erp/codec';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { execute } from '../../src/modules/erp/engine';
import { dependentsOf, moduleEnabled, moduleOfCommand, withRequirements } from '../../src/modules/erp/modules';
import { blankWorkspace } from '../../src/modules/erp/seed';
import type { Actor, Workspace } from '../../src/modules/erp/types';

const owner: Actor = { id: 'o', name: 'Owner', role: 'Owner', branchIds: [] };
const sales: Actor = { id: 's', name: 'Sales', role: 'Sales Manager', branchIds: [] };
let n = 0;
const run = (w: Workspace, type: string, payload: Record<string, unknown>, actor = owner) => execute(w, { type, payload, idempotencyKey: `modules-test-${++n}` }, actor);

describe('module catalogue', () => {
  it('resolves requirements transitively and in catalogue order', () => {
    expect(withRequirements(['commissions'])).toEqual(['sales', 'collections', 'commissions']);
    expect(withRequirements(['imports'])).toEqual(['purchasing', 'inventory', 'imports']);
  });

  it('finds dependents to switch off with a parent', () => {
    const all = withRequirements(['imports', 'commissions', 'payroll', 'reports']);
    expect(dependentsOf('sales', all)).toEqual(['collections', 'commissions']);
    expect(dependentsOf('purchasing', all)).toEqual(['imports']);
    expect(dependentsOf('reports', all)).toEqual([]);
  });

  it('maps commands to modules, always-on ones to null', () => {
    const w = buildDemoWorkspace();
    expect(moduleOfCommand('create_document', { kind: 'sales_invoice' }, w)).toBe('sales');
    expect(moduleOfCommand('create_document', { kind: 'purchase_order' }, w)).toBe('purchasing');
    expect(moduleOfCommand('submit_document', { id: w.documents.find(d => d.kind === 'goods_receipt')!.id }, w)).toBe('purchasing');
    expect(moduleOfCommand('create_receipt', { partyId: 'c-1' }, w)).toBe('collections');
    expect(moduleOfCommand('create_receipt', { partyId: 's-1' }, w)).toBe('purchasing');
    expect(moduleOfCommand('create_journal', {}, w)).toBeNull();
    expect(moduleOfCommand('set_period', {}, w)).toBeNull();
  });
});

describe('set_modules', () => {
  it('turns on requirements, provisions once and reports the change', () => {
    const blank = blankWorkspace(false);
    const first = run(blank, 'set_modules', { enabled: ['commissions', 'inventory'] });
    expect(first.workspace.modules).toEqual(['sales', 'inventory', 'collections', 'commissions']);
    expect(first.message).toContain('Sales');
    expect(first.workspace.warehouses).toHaveLength(1);
    expect(first.workspace.plans).toHaveLength(1);
    // Re-enabling after editing provisioned defaults never overwrites them.
    const renamed = { ...first.workspace, warehouses: [{ ...first.workspace.warehouses[0], name: 'Godown A' }] };
    const off = run(renamed, 'set_modules', { enabled: ['sales', 'collections', 'commissions'] });
    expect(off.workspace.modules).not.toContain('inventory');
    const on = run(off.workspace, 'set_modules', { enabled: ['sales', 'collections', 'commissions', 'inventory'] });
    expect(on.workspace.warehouses).toEqual([{ ...first.workspace.warehouses[0], name: 'Godown A' }]);
  });

  it('refuses to keep a child on when its parent is turned off', () => {
    const w = buildDemoWorkspace();
    expect(() => run(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'sales') })).toThrow(/cannot stay on without Sales/);
  });

  it('hides data by gating commands, never by deleting', () => {
    const w = buildDemoWorkspace();
    const off = run(w, 'set_modules', { enabled: w.modules.filter(m => !['commissions', 'payroll'].includes(m)) }).workspace;
    expect(off.commissions).toHaveLength(w.commissions.length);
    expect(off.payrolls).toHaveLength(w.payrolls.length);
    expect(() => run(off, 'approve_commission', { ids: [w.commissions[0].id] })).toThrow(/Commissions is turned off/);
    expect(() => run(off, 'create_payroll', { month: '2026-12' })).toThrow(/Payroll is turned off/);
    expect(() => run(off, 'create_document', { kind: 'sales_invoice', partyId: 'c-1', warehouseId: 'khi-main', date: '2026-10-14', dueDate: '2026-11-14', lines: [{ itemId: 'i-1', quantity: '1', price: '10' }] })).not.toThrow();
  });

  it('is allowed for non-owner roles; the API, not the engine, demands the password', () => {
    const w = buildDemoWorkspace();
    expect(() => run(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'payroll') }, sales)).not.toThrow();
    expect(() => run(w, 'set_modules', { enabled: w.modules }, { ...owner, role: 'Auditor' })).toThrow(/role does not permit/);
  });
});

describe('setup', () => {
  it('walks a new company from blank to complete and provisions its modules', () => {
    let w = blankWorkspace(false);
    expect(w.setup.complete).toBe(false);
    expect(() => run(w, 'complete_setup', {})).toThrow(/name and address/);
    w = run(w, 'save_company', { name: 'Karachi Traders', address: 'Jodia Bazar, Karachi', phone: '+92 300 1234567', email: 'office@kt.example' }).workspace;
    expect(w.company.logo).toBe('K');
    w = run(w, 'save_branding', { accent: '#1f5fa8', footer: 'Thanks' }).workspace;
    expect(() => run(w, 'save_branding', { accent: '#1f5fa8', footer: '', logoPath: 'other-tenant/logo.png' })).toThrow(/belong to this company/);
    expect(() => run(w, 'complete_setup', {})).toThrow(/at least one feature/);
    w = run(w, 'set_modules', { enabled: ['sales', 'purchasing', 'inventory', 'reports'] }).workspace;
    w = run(w, 'save_setup_step', { step: 4 }).workspace;
    w = run(w, 'complete_setup', {}).workspace;
    expect(w.setup.complete).toBe(true);
    expect(w.warehouses).toHaveLength(1);
    expect(() => run(w, 'save_setup_step', { step: 2 })).toThrow(/already complete/);
    expect(moduleEnabled(w, 'commissions')).toBe(false);
    expect(moduleEnabled(w, 'accounting')).toBe(true);
  });

  it('blocks payroll until statutory settings are entered', () => {
    let w = run(blankWorkspace(false), 'set_modules', { enabled: ['payroll'] }).workspace;
    w = run(w, 'save_employee', { name: 'Test Person', role: 'Clerk', territory: '', salary: '50000', allowance: '0', deduction: '0', attendance: 30, active: true }).workspace;
    expect(() => run(w, 'create_payroll', { month: '2026-10' })).toThrow(/EOBI and income-tax settings/);
    w = run(w, 'save_settings', { ...w.settings, eobiBase: '37000', employeeEobi: '1', employerEobi: '5', incomeTaxRate: '2.5' }).workspace;
    expect(() => run(w, 'create_payroll', { month: '2026-10' })).not.toThrow();
  });
});

describe('decodeWorkspace defaults', () => {
  it('upgrades a pre-module snapshot: all modules on, set up when it has data, FBR/bank keys dropped', () => {
    const { modules: _m, setup: _s, branding: _b, ...legacy } = buildDemoWorkspace();
    const decoded = decodeWorkspace({ ...legacy, demo: false, fbr: [{ id: 'x' }], bankLines: [] });
    expect(decoded.modules).toHaveLength(8);
    expect(decoded.setup.complete).toBe(true);
    expect(decoded.branding.accent).toBe('#087f69');
    expect('fbr' in decoded).toBe(false);
    const empty = decodeWorkspace({ ...legacy, demo: false, documents: [], items: [], parties: [] });
    expect(empty.setup.complete).toBe(false);
  });
});
