/** Regression tests for the QA defects fixed by agent A (engine money). Titles start with the defect ID. */
import { describe, expect, it } from 'vitest';
import { accountBalance, expectInvariants, firstWarehouse, freshCompany, refused, run, today, withDocument, withItem, withParty } from '../qa/helpers';
import { stock } from '../../src/modules/erp/engine';
import { D } from '../../src/modules/erp/money';
import type { Workspace } from '../../src/modules/erp/types';

const line = (itemId: string, quantity = '1', price = '100', extra: Record<string, unknown> = {}) => ({ itemId, quantity, price, discount: '0', taxRate: '0', employeeId: '', splits: [], ...extra });

function trading() {
  let w = freshCompany();
  let item: string, cust: string, supp: string;
  [w, item] = withItem(w, {}, { quantity: '100', cost: '50' });
  [w, cust] = withParty(w, 'customer');
  [w, supp] = withParty(w, 'supplier');
  return { w, item, cust, supp, wh: firstWarehouse(w) };
}
const docOf = (w: Workspace, id: string) => w.documents.find(d => d.id === id)!;

describe('D-05 precision is enforced at input (4 dp, half-up)', () => {
  it('D-05 an invoiced quantity beyond 4 dp is rounded, and the stock move matches the document line', () => {
    const t = trading();
    const [w, id] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1.23456', '10.123456', { discount: '2.55555' })]);
    const doc = docOf(w, id);
    expect(doc.lines[0].quantity).toBe('1.2346');
    expect(doc.lines[0].price).toBe('10.1235');
    expect(doc.lines[0].discount).toBe('2.5556');
    expect(w.stockMoves.find(m => m.sourceId === id)!.quantity).toBe('-1.2346');
    expect(stock(w, t.item).quantity).toBe('98.7654');
    expectInvariants(w);
  });

  it('D-05 quantities that round to zero are refused on every stock path', () => {
    const t = trading();
    const two = run(t.w, 'save_warehouse', { name: 'Second store', branchId: 'main' });
    refused(two.workspace, 'stock_transfer', { itemId: t.item, from: t.wh, to: two.recordId, quantity: '0.00004', date: today() }, 'Amount must be greater than zero.');
    refused(t.w, 'stock_adjust', { itemId: t.item, warehouseId: t.wh, quantity: '0.00004', reason: 'x', date: today() }, 'Enter a non-zero adjustment.');
    refused(t.w, 'bulk_stock_increase', { warehouseId: t.wh, date: today(), purpose: 'count_correction', reason: 'x', lines: [{ itemId: t.item, quantity: '0.00001', cost: '5' }] }, 'Amount must be greater than zero.');
    const [w, id] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '2')]);
    refused(w, 'return_document', { id, date: today(), lines: [{ lineId: docOf(w, id).lines[0].id, quantity: '0.00001' }] }, 'Amount must be greater than zero.');
  });

  it('D-05 a count correction target beyond 4 dp moves the rounded difference', () => {
    const t = trading();
    const r = run(t.w, 'set_stock_quantity', { itemId: t.item, warehouseId: t.wh, expectedQuantity: '100', targetQuantity: '100.00005', date: today(), reason: 'recount' });
    expect(r.workspace.stockMoves.at(-1)!.quantity).toBe('0.0001');
    expect(stock(r.workspace, t.item).quantity).toBe('100.0001');
    expectInvariants(r.workspace);
  });

  it('D-05 FX rates are rounded half-up to 4 dp and the bill posts at the rounded rate', () => {
    const t = trading();
    const [w, bill] = withDocument(t.w, 'supplier_invoice', t.supp, [line(t.item, '1', '10')], { currency: 'USD', fxRate: '280.00005' });
    expect(docOf(w, bill).fxRate).toBe('280.0001');
    expect(w.journals.find(j => j.sourceId === bill)!.lines.find(l => l.account === '2000')!.credit).toBe('2800.0010');
    expectInvariants(w);
  });

  it('D-05 values already within 4 dp keep the text that was sent', () => {
    const w = run(freshCompany(), 'save_item', { sku: 'P-1', name: 'Plain', category: 'General', hsCode: '', unit: 'pcs', price: '1e3', cost: '0', weight: '0.65', volume: '0.008', reorderLevel: 0 }).workspace;
    expect([w.items[0].price, w.items[0].cost, w.items[0].weight]).toEqual(['1e3', '0', '0.65']);
  });

  it('D-05 a receipt and its allocation are compared after rounding', () => {
    const t = trading();
    const [w, inv] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '100')]);
    const r = run(w, 'create_receipt', { partyId: t.cust, date: today(), amount: '100.00004', method: 'cash', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: inv, amount: '99.99996' }], employeeId: '', note: '', accountId: 'cash' });
    expect(r.workspace.receipts.at(-1)!.amount).toBe('100');
    expect(accountBalance(r.workspace, '1100')).toBe('0.0000');
    expectInvariants(r.workspace);
  });
});

describe('D-23 invalid or empty numbers give a clean validation message', () => {
  const message = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return ''; };
  it('D-23 empty, blank and non-numeric values never surface a raw DecimalError', () => {
    const t = trading();
    const stockLine = (quantity: unknown, cost: unknown = '5') => () => run(t.w, 'bulk_stock_increase', { warehouseId: t.wh, date: today(), purpose: 'opening_stock', reason: 'x', lines: [{ itemId: t.item, quantity, cost }] });
    const docLine = (extra: Record<string, unknown>) => () => run(t.w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: t.wh, date: today(), dueDate: today(), lines: [line(t.item, '1', '10', extra)] });
    const cases: [() => unknown, string][] = [
      [stockLine(''), 'Amount must be greater than zero.'],
      [stockLine('   '), 'Amount must be greater than zero.'],
      [stockLine('abc'), 'Enter a valid number below one trillion.'],
      [stockLine('NaN'), 'Enter a valid number below one trillion.'],
      [stockLine('5', ''), 'Amount must be greater than zero.'],
      [docLine({ price: '' }), 'Enter a valid number below one trillion.'],
      [docLine({ price: 'abc' }), 'Enter a valid number below one trillion.'],
      [docLine({ discount: '' }), 'Enter a valid number below one trillion.'],
      [docLine({ discount: 'x' }), 'Enter a valid number below one trillion.'],
      [docLine({ taxRate: 'abc' }), 'Enter a valid number below one trillion.'],
      [() => run(t.w, 'stock_adjust', { itemId: t.item, warehouseId: t.wh, quantity: '', reason: 'x', date: today() }), 'Enter a valid number below one trillion.'],
      [() => run(t.w, 'create_journal', { memo: 'x', date: today(), lines: [{ account: '1000', debit: 'abc', credit: '0' }, { account: '3000', debit: '0', credit: '1' }] }), 'Enter a valid number below one trillion.'],
    ];
    for (const [f, expected] of cases) {
      const text = message(f);
      expect(text).toContain(expected);
      expect(text).not.toContain('DecimalError');
    }
  });

  it('D-23 a blank amount yields exactly one issue, not one per chained check', () => {
    const t = trading();
    const text = message(() => run(t.w, 'bulk_stock_increase', { warehouseId: t.wh, date: today(), purpose: 'opening_stock', reason: 'x', lines: [{ itemId: t.item, quantity: '', cost: '5' }] }));
    expect(JSON.parse(text)).toHaveLength(1);
  });
});

describe('D-02 a supplier payment equals its allocations unless a bill is in foreign currency', () => {
  const pay = (w: Workspace, partyId: string, amount: string, allocations: { invoiceId: string; amount: string }[], method = 'bank') =>
    run(w, 'create_receipt', { partyId, date: today(), amount, method, chequeNo: method === 'cheque' ? 'CHQ-1' : '', dueDate: today(), allocations, employeeId: '', note: '', ...(method === 'cheque' ? {} : { accountId: 'main-bank' }) });
  function bills() {
    const t = trading();
    let w = t.w; let pkr: string, usd: string;
    [w, pkr] = withDocument(w, 'supplier_invoice', t.supp, [line(t.item, '10', '400')]);
    [w, usd] = withDocument(w, 'supplier_invoice', t.supp, [line(t.item, '10', '10')], { currency: 'USD', fxRate: '280' });
    return { ...t, w, pkr, usd };
  }
  it('D-02 PKR-only allocations must equal the amount, for bank and cheque payments alike', () => {
    const b = bills();
    refused(b.w, 'create_receipt', { partyId: b.supp, date: today(), amount: '5000', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: b.pkr, amount: '4000' }], employeeId: '', note: '', accountId: 'main-bank' }, 'Allocations must equal the receipt amount.');
    refused(b.w, 'create_receipt', { partyId: b.supp, date: today(), amount: '3000', method: 'cheque', chequeNo: 'C-1', dueDate: today(), allocations: [{ invoiceId: b.pkr, amount: '4000' }], employeeId: '', note: '' }, 'Allocations must equal the receipt amount.');
    const ok = pay(b.w, b.supp, '4000', [{ invoiceId: b.pkr, amount: '4000' }]).workspace;
    expect(ok.journals.at(-1)!.lines.some(l => l.account === '5400')).toBe(false);
    expectInvariants(ok);
  });
  it('D-02 a foreign-currency bill keeps the exchange difference, also when paid together with a PKR bill', () => {
    const b = bills();
    const usdOnly = pay(b.w, b.supp, '29000', [{ invoiceId: b.usd, amount: '100' }]).workspace;
    expect(usdOnly.journals.at(-1)!.lines.find(l => l.account === '5400')!.debit).toBe('1000.0000');
    expectInvariants(usdOnly);
    const mixed = pay(b.w, b.supp, '31500', [{ invoiceId: b.pkr, amount: '4000' }, { invoiceId: b.usd, amount: '100' }]).workspace;
    expect(mixed.journals.at(-1)!.lines.find(l => l.account === '5400')!.credit).toBe('500.0000');
    expect(accountBalance(mixed, '2000')).toBe('0.0000');
    expectInvariants(mixed);
  });
});

describe('D-03 a bill from a GRN clears GRNI (2010) at the GRN value', () => {
  const byAccount = (w: Workspace, sourceId: string) => Object.fromEntries(w.journals.find(j => j.sourceId === sourceId)!.lines.map(l => [l.account, D(l.debit).minus(l.credit).toFixed(4)]));
  const bill = (w: Workspace, grn: string, supp: string, wh: string, lines: Record<string, unknown>[], fxRate: string) => {
    const c = run(w, 'create_document', { kind: 'supplier_invoice', parentId: grn, partyId: supp, warehouseId: wh, date: today(), dueDate: today(), currency: 'USD', fxRate, lines });
    return [run(c.workspace, 'submit_document', { id: c.recordId }).workspace, c.recordId] as const;
  };
  function received(quantity = '100', price = '10', extra: Record<string, unknown> = {}) {
    const t = trading();
    const [w, grn] = withDocument(t.w, 'goods_receipt', t.supp, [line(t.item, quantity, price, extra)], { currency: 'USD', fxRate: '280' });
    return { ...t, w, grn };
  }
  it('D-03 a lower bill rate posts an exchange gain and clears 2010; tax is booked at the bill rate', () => {
    const r = received('100', '10');
    const [w, id] = bill(r.w, r.grn, r.supp, r.wh, [line(r.item, '100', '10', { taxRate: '10' })], '276');
    expect(byAccount(w, id)).toEqual({ '2010': '280000.0000', '1300': '27600.0000', '5400': '-4000.0000', '2000': '-303600.0000' });
    expect(accountBalance(w, '2010')).toBe('0.0000');
    expectInvariants(w);
  });
  it('D-03 partial bills at different rates leave no 2010 residue', () => {
    const r = received('3', '0.3333');
    let w = r.w; let b1: string, b2: string;
    [w, b1] = bill(w, r.grn, r.supp, r.wh, [line(r.item, '1', '0.3333')], '281');
    [w, b2] = bill(w, r.grn, r.supp, r.wh, [line(r.item, '2', '0.3333')], '279.5');
    expect(byAccount(w, b1)['2010']).toBe('93.3240');
    expect(byAccount(w, b2)['2010']).toBe('186.6480');
    expect(accountBalance(w, '2010')).toBe('0.0000');
    expectInvariants(w);
  });
  it('D-03 a bill priced differently from the GRN posts the price difference to 5300, not to FX', () => {
    const r = received('10', '10');
    const [w, id] = bill(r.w, r.grn, r.supp, r.wh, [line(r.item, '10', '11')], '280');
    expect(byAccount(w, id)).toEqual({ '2010': '28000.0000', '5300': '2800.0000', '2000': '-30800.0000' });
    expectInvariants(w);
  });
});

describe('D-04 journals backed by stock movements cannot be reversed', () => {
  const message = "Use the source document's correction workflow for operational journals.";
  it('D-04 opening stock, count corrections, adjustments and stock increases are refused; a manual journal still reverses', () => {
    const t = trading();
    let w = t.w;
    const opening = w.journals.find(j => j.lines.some(l => l.account === '3000'))!;
    w = run(w, 'set_stock_quantity', { itemId: t.item, warehouseId: t.wh, expectedQuantity: '100', targetQuantity: '90', date: today(), reason: 'Count' }).workspace;
    const count = w.journals.at(-1)!;
    w = run(w, 'stock_adjust', { itemId: t.item, warehouseId: t.wh, quantity: '5', reason: 'Found in yard', date: today() }).workspace;
    const adjust = w.journals.at(-1)!;
    w = run(w, 'bulk_stock_increase', { warehouseId: t.wh, date: today(), purpose: 'count_correction', reason: 'Recount', lines: [{ itemId: t.item, quantity: '2', cost: '50' }] }).workspace;
    const increase = w.journals.at(-1)!;
    for (const j of [opening, count, adjust, increase]) refused(w, 'reverse_journal', { id: j.id }, message);
    w = run(w, 'create_journal', { memo: 'Owner top-up', date: today(), lines: [{ account: '1002', debit: '500', credit: '0' }, { account: '3000', debit: '0', credit: '500' }] }).workspace;
    const reversed = run(w, 'reverse_journal', { id: w.journals.at(-1)!.id }).workspace;
    expect(reversed.journals.at(-1)!.reversalOf).toBe(w.journals.at(-1)!.id);
    expectInvariants(reversed);
  });
});

describe('D-06 attendance import and the employee form share one 0–30 rule', () => {
  function staff() {
    const w = run(freshCompany(), 'save_employee', { name: 'Ayesha', role: 'Salesperson', territory: 'Karachi', salary: '30000', allowance: '0', deduction: '0', attendance: 30, active: true });
    return { w: w.workspace, id: w.recordId };
  }
  it('D-06 31 and -1 are row errors in the import and refused by save_employee; 30 and 0 are accepted', () => {
    const { w, id } = staff();
    refused(w, 'import_records', { kind: 'attendance', rows: [{ employeeId: id, attendance: '31' }] }, 'Row 2: Attendance cannot exceed 30 days.');
    refused(w, 'import_records', { kind: 'attendance', rows: [{ employeeId: id, attendance: '-1' }] }, 'Row 2: Attendance cannot be negative.');
    const e = w.employees[0];
    refused(w, 'save_employee', { ...e, attendance: 31 }, 'Attendance cannot exceed 30 days.');
    expect(run(w, 'import_records', { kind: 'attendance', rows: [{ employeeId: id, attendance: '30' }] }).workspace.employees[0].attendance).toBe(30);
    expect(run(w, 'import_records', { kind: 'attendance', rows: [{ employeeId: id, attendance: '0' }] }).workspace.employees[0].attendance).toBe(0);
  });
});
