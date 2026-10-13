import { describe, expect, it } from 'vitest';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { execute } from '../../src/modules/erp/engine';
import { toggleModules } from '../../src/modules/erp/modules';
import { blankWorkspace } from '../../src/modules/erp/seed';
import type { Actor, Workspace } from '../../src/modules/erp/types';

const owner: Actor = { id: 'o', name: 'Owner', role: 'Owner', branchIds: [] };
let n = 0;
const run = (w: Workspace, type: string, payload: Record<string, unknown>, actor = owner) => execute(w, { type, payload, idempotencyKey: `master-data-${++n}` }, actor);
// A fresh company with every module on, so master-data commands are not gated.
const blank = () => ({ ...blankWorkspace(false), modules: [...toggleModules] });
const customer = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Retailer', ...extra });

describe('branches and warehouses', () => {
  it('creates slug ids, renames, and refuses duplicates', () => {
    let w = run(blank(), 'save_branch', { name: 'Lahore Office' }).workspace;
    expect(w.branches).toEqual([{ id: 'lahore-office', name: 'Lahore Office' }]);
    w = run(w, 'save_warehouse', { name: 'Godown A', branchId: 'lahore-office' }).workspace;
    w = run(w, 'save_warehouse', { name: 'Godown B', branchId: 'lahore-office' }).workspace;
    expect(w.warehouses.map(x => x.id)).toEqual(['godown-a', 'godown-b']);
    expect(() => run(w, 'save_warehouse', { name: 'godown a', branchId: 'lahore-office' })).toThrow(/already exists/);
    w = run(w, 'save_warehouse', { id: 'godown-a', name: 'Main godown', branchId: 'lahore-office' }).workspace;
    expect(w.warehouses[0]).toEqual({ id: 'godown-a', name: 'Main godown', branchId: 'lahore-office' });
    expect(() => run(w, 'save_warehouse', { name: 'Xy', branchId: 'nope' })).toThrow(/Branch not found/);
  });

  it('keeps branch-limited users inside their branches', () => {
    const w = buildDemoWorkspace();
    const lahore: Actor = { ...owner, role: 'Warehouse Manager', branchIds: ['lahore'] };
    expect(() => run(w, 'save_warehouse', { name: 'Karachi Annex', branchId: 'karachi' }, lahore)).toThrow(/outside your permitted branches/);
    expect(() => run(w, 'save_warehouse', { name: 'Lahore Annex', branchId: 'lahore' }, lahore)).not.toThrow();
  });
});

describe('archiving', () => {
  it('hides archived customers and products from new documents but keeps history', () => {
    let w = buildDemoWorkspace();
    const before = w.documents.length;
    w = run(w, 'set_archived', { kind: 'party', id: 'c-1', archived: true }).workspace;
    w = run(w, 'set_archived', { kind: 'item', id: 'i-6', archived: true }).workspace;
    expect(w.documents).toHaveLength(before);
    expect(() => run(w, 'create_document', { kind: 'sales_invoice', partyId: 'c-1', warehouseId: 'khi-main', date: '2026-10-14', dueDate: '2026-11-14', lines: [{ itemId: 'i-1', quantity: '1', price: '10' }] })).toThrow(/Al-Noor Electronics is archived/);
    expect(() => run(w, 'create_document', { kind: 'sales_invoice', partyId: 'c-2', warehouseId: 'khi-main', date: '2026-10-14', dueDate: '2026-11-14', lines: [{ itemId: 'i-6', quantity: '1', price: '10' }] })).toThrow(/Motion Sensor Switch is archived/);
    // Editing an archived record keeps it archived; restoring clears the flag entirely.
    w = run(w, 'save_party', { ...w.parties.find(p => p.id === 'c-1')!, city: 'Hyderabad' }).workspace;
    expect(w.parties.find(p => p.id === 'c-1')!.archived).toBe(true);
    w = run(w, 'set_archived', { kind: 'party', id: 'c-1', archived: false }).workspace;
    expect('archived' in w.parties.find(p => p.id === 'c-1')!).toBe(false);
  });

  it('refuses duplicate names within a party type', () => {
    const w = buildDemoWorkspace();
    expect(() => run(w, 'save_party', customer('al-noor electronics'))).toThrow(/already exists/);
    expect(() => run(w, 'save_party', { ...customer('Al-Noor Electronics'), type: 'supplier', customerClass: 'Importer' })).not.toThrow();
  });
});

describe('CSV import', () => {
  it('creates rows and refuses existing ones in create mode, updates them in upsert mode', () => {
    let w = blank();
    w = run(w, 'import_records', { kind: 'items', rows: [{ sku: 'A-1', name: 'Alpha', price: '100' }, { sku: 'B-2', name: 'Beta', unit: 'box' }] }).workspace;
    expect(w.items.map(i => [i.sku, i.name, i.price, i.unit])).toEqual([['A-1', 'Alpha', '100', 'pcs'], ['B-2', 'Beta', '0', 'box']]);
    expect(() => run(w, 'import_records', { kind: 'items', rows: [{ sku: 'a-1', name: 'Alpha again' }] })).toThrow(/Row 2: SKU a-1 already exists/);
    const upsert = run(w, 'import_records', { kind: 'items', mode: 'upsert', rows: [{ sku: 'A-1', price: '120' }, { sku: 'C-3', name: 'Gamma' }] });
    expect(upsert.message).toBe('Imported 2 items: 1 created, 1 updated.');
    expect(upsert.workspace.items.find(i => i.sku === 'A-1')).toMatchObject({ name: 'Alpha', price: '120' });
  });

  it('imports nothing when any row is invalid and names every bad row', () => {
    const w = blank();
    expect(() => run(w, 'import_records', { kind: 'customers', rows: [customer('Good Co'), { name: '' }, { name: 'Bad Email', email: 'not-an-email' }, customer('Good Co')] }))
      .toThrow(/Row 3: name is required[\s\S]*Row 4: [\s\S]*Row 5: Good Co appears more than once/);
    expect(w.parties).toHaveLength(0);
  });

  it('imports employees with managers by name and attendance by name', () => {
    let w = blank();
    w = run(w, 'import_records', { kind: 'employees', rows: [{ name: 'Boss Person', role: 'Manager', salary: '100000' }, { name: 'Staff Person', role: 'Booker', salary: '40000', manager: 'Boss Person' }] }).workspace;
    expect(w.employees.find(e => e.name === 'Staff Person')!.parentId).toBe(w.employees.find(e => e.name === 'Boss Person')!.id);
    expect(() => run(w, 'import_records', { kind: 'employees', rows: [{ name: 'New Person', manager: 'Nobody' }] })).toThrow(/manager Nobody not found/);
    w = run(w, 'import_records', { kind: 'attendance', rows: [{ name: 'staff person', attendance: '26' }] }).workspace;
    expect(w.employees.find(e => e.name === 'Staff Person')!.attendance).toBe(26);
  });

  it('defaults credit limit to zero, never to an invented amount', () => {
    const w = run(blank(), 'import_records', { kind: 'customers', rows: [{ name: 'Plain Customer' }] }).workspace;
    expect(w.parties[0]).toMatchObject({ creditLimit: '0', terms: 30, customerClass: 'Retailer', registered: false });
  });
});
