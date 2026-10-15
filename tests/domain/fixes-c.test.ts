import { describe, expect, it } from 'vitest';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { businessToday } from '../../src/modules/erp/dates';
import { accountBalance, execute, outstanding } from '../../src/modules/erp/engine';
import { D, money, sum } from '../../src/modules/erp/money';
import { agedBalances, landedCostPayable, partyStatement, salesAnalysis } from '../../src/modules/erp/reports';
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

const cheque = (w: Workspace, partyId: string, invoiceId: string, amount: string, recorded: string) => run(w, 'create_receipt', { partyId, date: recorded, amount, method: 'cheque', chequeNo: 'CHQ-77', dueDate: recorded, allocations: [{ invoiceId, amount }] });
const chequeTo = (w: Workspace, id: string, status: 'deposited' | 'cleared' | 'bounced', date: string) => run(w, 'update_cheque', { id, status, date, ...(status === 'deposited' ? { accountId: 'main-bank' } : {}) }).workspace;
const aged = (w: Workspace, type: 'customer' | 'supplier', asOf: string) => { const t = agedBalances(w, type, asOf).totals; return [t.current, t.d30, t.d60, t.total]; };
/** Today's outstanding by invoice, the figure the report used before D-12; it must still hold for any date after the last posting. */
const outstandingNow = (w: Workspace, kind: string, asOf: string) => money(sum(w.documents.filter(d => d.kind === kind && d.status === 'submitted' && d.date <= asOf).map(d => D(outstanding(d)).mul(d.currency === 'PKR' ? 1 : D(d.fxRate)))));

describe('D-12 aged balances as at a past date rebuild each open amount from what had cleared by then', () => {
  it('a receipt after the as-at date is not counted; on and after its date it is', () => {
    let { w, item, cust } = company(); let inv: string;
    [w, inv] = document(w, 'sales_invoice', cust, item, '10', '100', { date: '2026-09-01', dueDate: '2026-09-01' });
    w = pay(w, cust, inv, '400', '400', '2026-09-15');
    w = pay(w, cust, inv, '600', '600', '2026-10-10');
    expect(aged(w, 'customer', '2026-09-10')).toEqual(['0.0000', '1000.0000', '0.0000', '1000.0000']);
    expect(aged(w, 'customer', '2026-09-30')).toEqual(['0.0000', '600.0000', '0.0000', '600.0000']);
    expect(aged(w, 'customer', '2026-10-09')).toEqual(['0.0000', '0.0000', '600.0000', '600.0000']);
    expect(aged(w, 'customer', '2026-10-10')[3]).toBe('0.0000');
  });

  it('a cheque counts from its clearing date, not the date it was recorded', () => {
    let { w, item, cust } = company(); let inv: string;
    [w, inv] = document(w, 'sales_invoice', cust, item, '10', '100', { date: '2026-09-01', dueDate: '2026-09-01' });
    const c = cheque(w, cust, inv, '1000', '2026-09-20');
    w = chequeTo(c.workspace, c.recordId, 'deposited', '2026-09-28');
    w = chequeTo(w, c.recordId, 'cleared', '2026-10-05');
    expect(aged(w, 'customer', '2026-09-30')[3]).toBe('1000.0000');
    expect(aged(w, 'customer', '2026-10-05')[3]).toBe('0.0000');
  });

  it('a cheque that cleared and then bounced is paid only between those dates', () => {
    let { w, item, cust } = company(); let inv: string;
    [w, inv] = document(w, 'sales_invoice', cust, item, '10', '100', { date: '2026-09-01', dueDate: '2026-09-01' });
    const c = cheque(w, cust, inv, '1000', '2026-09-20');
    w = chequeTo(c.workspace, c.recordId, 'deposited', '2026-09-21');
    w = chequeTo(w, c.recordId, 'cleared', '2026-09-22');
    w = chequeTo(w, c.recordId, 'bounced', '2026-09-24');
    expect(aged(w, 'customer', '2026-09-21')[3]).toBe('1000.0000');
    expect(aged(w, 'customer', '2026-09-23')[3]).toBe('0.0000');
    expect(aged(w, 'customer', '2026-09-24')[3]).toBe('1000.0000');
    expect(agedBalances(w, 'customer', '2099-12-31').totals.total).toBe(accountBalance(w, '1100'));
  });

  it('a return dated after the as-at date is not deducted yet', () => {
    let { w, item, cust } = company(); let inv: string;
    [w, inv] = document(w, 'sales_invoice', cust, item, '10', '100', { date: '2026-09-01', dueDate: '2026-09-01' });
    w = returnOf(w, inv, '2', '2026-10-05');
    expect(aged(w, 'customer', '2026-09-30')[3]).toBe('1000.0000');
    expect(aged(w, 'customer', '2026-10-05')[3]).toBe('800.0000');
  });

  it('aged payables: a USD bill paid after the as-at date is still open in PKR at the bill rate', () => {
    let { w, item, sup } = company(); let bill: string;
    [w, bill] = document(w, 'supplier_invoice', sup, item, '100', '10', { currency: 'USD', fxRate: '280', date: '2026-09-01', dueDate: '2026-09-01' });
    w = pay(w, sup, bill, '400', '110000', '2026-10-10');
    expect(aged(w, 'supplier', '2026-09-30')[3]).toBe('280000.0000');
    expect(aged(w, 'supplier', '2026-10-10')[3]).toBe('168000.0000');
    expect(aged(w, 'supplier', '2026-10-10')[3]).toBe(payable(w));
  });

  it("today's figures are unchanged: after the last posting the report equals today's outstanding and the controls", () => {
    const w = buildDemoWorkspace();
    for (const asOf of [businessToday(), '2026-12-31', '2099-12-31']) {
      expect(agedBalances(w, 'customer', asOf).totals.total, asOf).toBe(outstandingNow(w, 'sales_invoice', asOf));
      expect(agedBalances(w, 'supplier', asOf).totals.total, asOf).toBe(outstandingNow(w, 'supplier_invoice', asOf));
    }
    expect(agedBalances(w, 'customer', '2099-12-31').totals.total).toBe(accountBalance(w, '1100'));
    // The demo's PDC-0982 cleared on 22 Sep and bounced on 24 Sep: on 23 Sep it was paid.
    const c4 = (asOf: string) => agedBalances(w, 'customer', asOf).rows.find(r => r.partyId === 'c-4')?.total ?? '0.0000';
    expect([c4('2026-09-21'), c4('2026-09-23'), c4('2026-09-24')]).toEqual(['65490.0000', '0.0000', '65490.0000']);
  });
});

describe('D-25 statement shows a bounced cheque and its reversal', () => {
  it('the receipt line sits on the clearing date and the reversal on the bounce date; the balance ends at what is owed', () => {
    let { w, item, cust } = company(); let inv: string;
    [w, inv] = document(w, 'sales_invoice', cust, item, '10', '100', { date: '2026-09-01', dueDate: '2026-09-01' });
    const c = cheque(w, cust, inv, '1000', '2026-09-20');
    w = chequeTo(c.workspace, c.recordId, 'deposited', '2026-09-21');
    w = chequeTo(w, c.recordId, 'cleared', '2026-09-22');
    w = chequeTo(w, c.recordId, 'bounced', '2026-09-24');
    const s = partyStatement(w, cust, '2026-09-01', '2026-09-30');
    expect(s.lines.map(l => [l.date, l.reference, l.description, l.debit, l.credit, l.balance])).toEqual([
      ['2026-09-01', 'INV-2026-0001', 'Sales invoice', '1000.0000', '', '1000.0000'],
      ['2026-09-22', 'REC-0001', 'Receipt · cheque CHQ-77', '', '1000.0000', '0.0000'],
      ['2026-09-24', 'REC-0001', 'Cheque bounced · reversal CHQ-77', '1000.0000', '', '1000.0000'],
    ]);
    expect(s.closing).toBe(accountBalance(w, '1100'));
    // A period that starts between clearing and bounce opens at zero.
    expect(partyStatement(w, cust, '2026-09-23', '2026-09-30')).toMatchObject({ opening: '0.0000', closing: '1000.0000' });
  });

  it('a cheque that bounced before it cleared never posted, so it is not listed', () => {
    let { w, item, cust } = company(); let inv: string;
    [w, inv] = document(w, 'sales_invoice', cust, item, '10', '100');
    const c = cheque(w, cust, inv, '1000', DAY);
    w = chequeTo(chequeTo(c.workspace, c.recordId, 'deposited', DAY), c.recordId, 'bounced', DAY);
    expect(partyStatement(w, cust, '2026-01-01', '2026-12-31').lines.map(l => l.description)).toEqual(['Sales invoice']);
  });

  it('a bounced cheque paid to a supplier raises what we owe again', () => {
    let { w, item, sup } = company(); let bill: string;
    [w, bill] = document(w, 'supplier_invoice', sup, item, '10', '100');
    const c = cheque(w, sup, bill, '1000', DAY);
    w = chequeTo(chequeTo(c.workspace, c.recordId, 'deposited', DAY), c.recordId, 'cleared', '2026-10-11');
    w = chequeTo(w, c.recordId, 'bounced', '2026-10-12');
    const s = partyStatement(w, sup, '2026-01-01', '2026-12-31');
    expect(s.lines.map(l => [l.description, l.balance])).toEqual([['Supplier bill', '1000.0000'], ['Payment · cheque CHQ-77', '0.0000'], ['Cheque bounced · reversal CHQ-77', '1000.0000']]);
    expect(s.closing).toBe(payable(w));
  });

  it('demo: every customer statement still closes at its aged balance and the AR control', () => {
    const w = buildDemoWorkspace();
    const customers = w.parties.filter(p => p.type === 'customer');
    for (const p of customers) expect(partyStatement(w, p.id, '2000-01-01', '2099-12-31').closing, p.name).toBe(agedRow(w, 'customer', p.id));
    expect(money(sum(customers.map(p => partyStatement(w, p.id, '2000-01-01', '2099-12-31').closing)))).toBe(accountBalance(w, '1100'));
  });
});

describe('D-26 sales analysis by salesperson apportions split lines by share', () => {
  const employee = (w: Workspace, name: string) => run(w, 'save_employee', { name, role: 'OB', territory: '', salary: '1', allowance: '0', deduction: '0', attendance: 30, active: true });
  function staffed() {
    let { w, item, cust } = company();
    const a = employee(w, 'Hamza Khan'); w = a.workspace;
    const b = employee(w, 'Sara Malik'); w = b.workspace;
    const c = employee(w, 'Bilal Ahmed'); w = c.workspace;
    return { w, item, cust, a: a.recordId, b: b.recordId, c: c.recordId };
  }
  const sale = (w: Workspace, cust: string, item: string, quantity: string, price: string, line: Record<string, unknown>): [Workspace, string] => {
    const created = run(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: w.warehouses[0].id, date: DAY, dueDate: DAY, lines: [{ itemId: item, quantity, price, discount: '0', taxRate: '0', employeeId: '', splits: [], ...line }] });
    return [run(created.workspace, 'submit_document', { id: created.recordId }).workspace, created.recordId];
  };
  const rowsOf = (w: Workspace) => salesAnalysis(w, '2026-01-01', '2026-12-31', 'salesperson').rows.map(r => [r.label, r.invoices, r.quantity, r.net, r.returns, r.netOfReturns]);

  it('a 60/40 split gives each person their share of net, quantity and returns', () => {
    let { w, item, cust, a, b } = staffed(); let inv: string;
    [w, inv] = sale(w, cust, item, '10', '100', { splits: [{ employeeId: a, share: '60' }, { employeeId: b, share: '40' }] });
    w = returnOf(w, inv, '5');
    expect(rowsOf(w)).toEqual([
      ['Hamza Khan', 1, '6.0000', '600.0000', '300.0000', '300.0000'],
      ['Sara Malik', 1, '4.0000', '400.0000', '200.0000', '200.0000'],
    ]);
  });

  it('uneven thirds still add up to the customer and product totals exactly', () => {
    let { w, item, cust, a, b, c } = staffed();
    [w] = sale(w, cust, item, '7', '33.33', { discount: '3', splits: [{ employeeId: a, share: '33.3333' }, { employeeId: b, share: '33.3333' }, { employeeId: c, share: '33.3334' }] });
    [w] = sale(w, cust, item, '1', '50', { employeeId: a });
    const bySalesperson = salesAnalysis(w, '2026-01-01', '2026-12-31', 'salesperson').total;
    for (const by of ['customer', 'item'] as const) {
      const other = salesAnalysis(w, '2026-01-01', '2026-12-31', by).total;
      expect([bySalesperson.quantity, bySalesperson.net, bySalesperson.netOfReturns], by).toEqual([other.quantity, other.net, other.netOfReturns]);
    }
    expect(rowsOf(w).map(r => r[0])).toEqual(['Hamza Khan', 'Bilal Ahmed', 'Sara Malik']);
  });

  it('lines without splits keep their salesperson, and unassigned lines stay "Unassigned"', () => {
    let { w, item, cust, a } = staffed();
    [w] = sale(w, cust, item, '2', '100', { employeeId: a });
    [w] = sale(w, cust, item, '1', '100', {});
    expect(rowsOf(w)).toEqual([['Hamza Khan', 1, '2.0000', '200.0000', '0.0000', '200.0000'], ['Unassigned', 1, '1.0000', '100.0000', '0.0000', '100.0000']]);
  });
});
