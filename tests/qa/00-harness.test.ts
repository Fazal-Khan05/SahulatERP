import { describe, expect, it } from 'vitest';
import { expectInvariants, freshCompany, invariants, refused, run, withDocument, withItem, withParty } from './helpers';

describe('harness', () => {
  it('fresh company is provisioned and reconciled', () => {
    let w = freshCompany();
    expect(w.setup.complete).toBe(true);
    expect(w.warehouses.length).toBeGreaterThan(0);
    expectInvariants(w);
    let item: string, cust: string;
    [w, item] = withItem(w, {}, { quantity: '10', cost: '60' });
    [w, cust] = withParty(w);
    [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '2', price: '100' }]);
    expectInvariants(w);
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: w.warehouses[0].id, date: '2026-10-14', dueDate: '2026-10-14', lines: [{ itemId: item, quantity: '1', price: '1', discount: '0', taxRate: '0', employeeId: '', splits: [] }, { itemId: item, quantity: '1', price: '1', discount: '0', taxRate: '0', employeeId: '', splits: [] }] }, 'Use one line per product.');
    expect(invariants(run(w, 'set_period', { month: '2026-01', locked: true }).workspace).trialBalanced).toBe(true);
  });
});
