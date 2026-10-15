import { describe, expect, it } from 'vitest';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { accountBalance, execute } from '../../src/modules/erp/engine';
import { D, money, sum } from '../../src/modules/erp/money';
import { agedBalances, landedCostPayable, partyStatement } from '../../src/modules/erp/reports';
import { toggleModules } from '../../src/modules/erp/modules';
import { blankWorkspace } from '../../src/modules/erp/seed';
import type { Actor, Workspace } from '../../src/modules/erp/types';

// Regression tests for the report defects fixed by agent C (D-01, D-12, D-25, D-26).
const owner: Actor = { id: 'fix-c-owner', name: 'Owner', role: 'Owner', branchIds: [] };
let n = 0;
const run = (w: Workspace, type: string, payload: Record<string, unknown>) => execute(w, { type, payload, idempotencyKey: `fixes-c-${++n}` }, owner);
const DAY = '2026-10-10';

function company() {
  let w: Workspace = { ...blankWorkspace(false), tenantId: 'fixes-c' };
  w = run(w, 'save_company', { name: 'Fix C Traders', address: 'Jodia Bazar, Karachi', phone: '+92 300 0000000', email: 'office@fixc.example', taxId: '' }).workspace;
  w = run(w, 'set_modules', { enabled: [...toggleModules] }).workspace;
  w = run(w, 'complete_setup', {}).workspace;
  const item = run(w, 'save_item', { sku: 'FC-1', name: 'LED Panel', category: 'General', hsCode: '', unit: 'pcs', price: '100', cost: '60', weight: '1', volume: '1', reorderLevel: 0 });
  w = run(item.workspace, 'bulk_stock_increase', { warehouseId: item.workspace.warehouses[0].id, date: '2026-01-01', purpose: 'opening_stock', reason: 'Opening', lines: [{ itemId: item.recordId, quantity: '1000', cost: '60' }] }).workspace;
  const cust = run(w, 'save_party', { name: 'Al-Noor Electronics', type: 'customer', city: 'Karachi', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Retailer' });
  const sup = run(cust.workspace, 'save_party', { name: 'Shenzhen Bright', type: 'supplier', city: 'Shenzhen', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Importer' });
  return { w: sup.workspace, item: item.recordId, cust: cust.recordId, sup: sup.recordId };
}
function document(w: Workspace, kind: string, partyId: string, itemId: string, quantity: string, price: string, extra: Record<string, unknown> = {}): [Workspace, string] {
  const created = run(w, 'create_document', { kind, partyId, warehouseId: w.warehouses[0].id, date: DAY, dueDate: DAY, lines: [{ itemId, quantity, price, discount: '0', taxRate: '0', employeeId: '', splits: [] }], ...extra });
  return [run(created.workspace, 'submit_document', { id: created.recordId }).workspace, created.recordId];
}
const returnOf = (w: Workspace, id: string, quantity: string, date = DAY) => run(w, 'return_document', { id, date, lines: [{ lineId: w.documents.find(d => d.id === id)!.lines[0].id, quantity }] }).workspace;
const pay = (w: Workspace, partyId: string, invoiceId: string, allocated: string, amount = allocated, date = DAY) => run(w, 'create_receipt', { partyId, date, amount, method: 'bank', dueDate: date, allocations: [{ invoiceId, amount: allocated }], accountId: 'main-bank' }).workspace;
const payable = (w: Workspace) => money(D(accountBalance(w, '2000')).negated());
const agedRow = (w: Workspace, type: 'customer' | 'supplier', partyId: string) => agedBalances(w, type, '2099-12-31').rows.find(r => r.partyId === partyId)?.total ?? '0.0000';

describe('D-01 supplier statement: bills raise what is owed; payments and returns lower it', () => {
  it('PKR supplier: running balance falls on the return and the payment, and closes at the payables ledger and aged payables', () => {
    let { w, item, sup } = company(); let bill: string;
    [w, bill] = document(w, 'supplier_invoice', sup, item, '10', '100');
    w = returnOf(w, bill, '2');
    w = pay(w, sup, bill, '500');
    const s = partyStatement(w, sup, '2026-01-01', '2026-12-31');
    expect(s.lines.map(l => [l.description, l.debit, l.credit, l.balance])).toEqual([
      ['Supplier bill', '1000.0000', '', '1000.0000'],
      ['Return to supplier', '', '200.0000', '800.0000'],
      ['Payment · bank', '', '500.0000', '300.0000'],
    ]);
    expect(s.closing).toBe('300.0000');
    expect(s.closing).toBe(payable(w));
    expect(s.closing).toBe(agedRow(w, 'supplier', sup));
  });

  it('USD supplier paid with an FX difference: the payment clears the bill at its rate; the difference is not on the statement', () => {
    let { w, item, sup } = company(); let bill: string;
    [w, bill] = document(w, 'supplier_invoice', sup, item, '100', '10', { currency: 'USD', fxRate: '280' });
    w = pay(w, sup, bill, '400', '110000');
    const s = partyStatement(w, sup, '2026-01-01', '2026-12-31');
    expect(s.lines.map(l => [l.description, l.debit, l.credit, l.balance])).toEqual([
      ['Supplier bill', '280000.0000', '', '280000.0000'],
      ['Payment · bank', '', '112000.0000', '168000.0000'],
    ]);
    expect(s.closing).toBe(payable(w));
    expect(s.closing).toBe(agedRow(w, 'supplier', sup));
  });

  it('a return after full payment leaves the supplier owing us (negative balance), matching the ledger', () => {
    let { w, item, sup } = company(); let bill: string;
    [w, bill] = document(w, 'supplier_invoice', sup, item, '10', '100');
    w = pay(w, sup, bill, '1000');
    w = returnOf(w, bill, '2', '2026-10-11');
    const s = partyStatement(w, sup, '2026-01-01', '2026-12-31');
    expect(s.lines.map(l => l.balance)).toEqual(['1000.0000', '0.0000', '-200.0000']);
    expect(s.closing).toBe('-200.0000');
    expect(s.closing).toBe(payable(w));
    expect(s.closing).toBe(agedRow(w, 'supplier', sup));
  });

  it('a payment before the period is in the opening balance with the right sign', () => {
    let { w, item, sup } = company(); let bill: string;
    [w, bill] = document(w, 'supplier_invoice', sup, item, '10', '100');
    w = pay(w, sup, bill, '600');
    expect(partyStatement(w, sup, '2026-10-11', '2026-12-31')).toEqual({ opening: '400.0000', lines: [], closing: '400.0000' });
  });

  it('customer statements are unchanged: invoice debits, credit note and receipt credit', () => {
    let { w, item, cust } = company(); let inv: string;
    [w, inv] = document(w, 'sales_invoice', cust, item, '10', '100');
    w = returnOf(w, inv, '2');
    w = pay(w, cust, inv, '300');
    const s = partyStatement(w, cust, '2026-01-01', '2026-12-31');
    expect(s.lines.map(l => [l.description, l.debit, l.credit, l.balance])).toEqual([
      ['Sales invoice', '1000.0000', '', '1000.0000'],
      ['Credit note', '', '200.0000', '800.0000'],
      ['Receipt · bank', '', '300.0000', '500.0000'],
    ]);
    expect(s.closing).toBe(accountBalance(w, '1100'));
  });

  it('demo company: every supplier statement equals its aged payables row, and together with unbilled import charges they equal the 2000 control', () => {
    const w = buildDemoWorkspace();
    const suppliers = w.parties.filter(p => p.type === 'supplier');
    const closings = suppliers.map(p => partyStatement(w, p.id, '2000-01-01', '2099-12-31').closing);
    suppliers.forEach((p, i) => expect(closings[i], p.name).toBe(agedRow(w, 'supplier', p.id)));
    expect(money(sum(closings).plus(landedCostPayable(w)))).toBe(payable(w));
  });
});
