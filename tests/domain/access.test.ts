import { describe, expect, it } from 'vitest';
import { filterBranch, scopeWorkspace } from '../../src/modules/erp/access';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import type { Actor, Role } from '../../src/modules/erp/types';

const demo = buildDemoWorkspace();
const as = (role: Role, extra: Partial<Actor> = {}): Actor => ({ id: 'u', name: 'U', role, branchIds: [], ...extra });

describe('role-scoped workspace reads (SQA-01)', () => {
  it('gives ledger roles the full books', () => {
    for (const role of ['Owner', 'Accountant', 'Auditor'] as Role[]) {
      const scoped = scopeWorkspace(demo, as(role));
      expect(scoped.journals).toHaveLength(demo.journals.length);
      expect(scoped.employees).toEqual(demo.employees);
    }
  });

  it('never sends salaries, payroll, journals or audit to non-ledger roles outside payroll', () => {
    for (const role of ['Sales Manager', 'Salesperson', 'Recovery Officer', 'Warehouse Manager'] as Role[]) {
      const scoped = scopeWorkspace(demo, as(role, { employeeId: 'e-4' }));
      expect(scoped.journals, role).toEqual([]);
      expect(scoped.payrolls, role).toEqual([]);
      expect(scoped.audit, role).toEqual([]);
      expect(scoped.bankLines, role).toEqual([]);
      expect(scoped.operations, role).toEqual([]);
      expect(scoped.employees.every(e => e.salary === '0' && e.allowance === '0'), role).toBe(true);
    }
  });

  it('limits a salesperson to their own sales and commissions', () => {
    const scoped = scopeWorkspace(demo, as('Salesperson', { employeeId: 'e-4' }));
    expect(scoped.documents.length).toBeGreaterThan(0);
    expect(scoped.documents.every(d => d.lines.some(l => l.employeeId === 'e-4'))).toBe(true);
    expect(scoped.commissions.every(c => c.employeeId === 'e-4')).toBe(true);
    expect(scopeWorkspace(demo, as('Salesperson')).documents).toEqual([]);
  });

  it('limits a branch member to their branch', () => {
    const scoped = scopeWorkspace(demo, as('Accountant', { branchIds: ['lahore'] }));
    expect(scoped.warehouses.map(w => w.id)).toEqual(['lhe-main']);
    expect(scoped.documents.every(d => d.warehouseId === 'lhe-main')).toBe(true);
    expect(scoped.stockMoves.every(m => m.warehouseId === 'lhe-main')).toBe(true);
    expect(scoped.journals).toEqual([]);
  });

  it('gives the payroll administrator pay data but not the ledger', () => {
    const scoped = scopeWorkspace(demo, as('Payroll Administrator'));
    expect(scoped.payrolls).toHaveLength(demo.payrolls.length);
    expect(scoped.employees).toEqual(demo.employees);
    expect(scoped.journals).toEqual([]);
  });

  it('filters one branch for an owner while keeping the company ledger', () => {
    const lahore = filterBranch(demo, 'lahore');
    expect(lahore.documents.every(d => d.warehouseId === 'lhe-main')).toBe(true);
    expect(lahore.journals).toHaveLength(demo.journals.length);
  });
});
