import { describe, expect, it } from 'vitest';
import { accountBalance, actor, expectInvariants, firstWarehouse, freshCompany, owner, refused, run, today, withItem, withParty, D } from './helpers';
import { commandSchema, stock, summary } from '../../src/modules/erp/engine';
import { documentView } from '../../src/modules/erp/documents';
import { balanceSheet, profitAndLoss, stockValuation, trialBalance } from '../../src/modules/erp/reports';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { toggleModules } from '../../src/modules/erp/modules';
import type { Actor, Workspace } from '../../src/modules/erp/types';

// ---------- private helpers ----------
const L = (itemId: string, quantity = '1', price = '100', extra: Record<string, unknown> = {}) => ({ itemId, quantity, price, discount: '0', taxRate: '0', employeeId: '', splits: [], ...extra });
const docOf = (w: Workspace, id: string) => w.documents.find(d => d.id === id)!;
const shOf = (w: Workspace, id: string) => w.shipments.find(s => s.id === id)!;
const landedJournals = (w: Workspace) => w.journals.filter(j => j.memo.startsWith('Landed costs'));
const sumBy = (lines: { account: string; debit: string; credit: string }[]) => {
  const out: Record<string, string> = {};
  for (const l of lines) out[l.account] = D(out[l.account] ?? 0).plus(l.debit).minus(l.credit).toFixed(4);
  return out;
};
const allocatedTo = (w: Workspace, shId: string, itemId: string) => D(shOf(w, shId).allocations.filter(a => a.itemId === itemId).reduce((t, a) => t.plus(a.amount), D(0))).toFixed(4);
function createSubmit(w: Workspace, kind: string, partyId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, who: Actor = owner): [Workspace, string] {
  const c = run(w, 'create_document', { kind, partyId, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines, ...extra }, who);
  return [run(c.workspace, 'submit_document', { id: c.recordId }, who).workspace, c.recordId];
}
/** Company with products A (weight 2, volume 3) and B (weight 1, volume 1), a supplier and a customer. */
function base() {
  let w = freshCompany();
  let a: string, b: string, sup: string, cust: string;
  [w, a] = withItem(w, { name: 'Product A', weight: '2', volume: '3' });
  [w, b] = withItem(w, { name: 'Product B', weight: '1', volume: '1' });
  [w, sup] = withParty(w, 'supplier', { name: 'Ningbo Exports' });
  [w, cust] = withParty(w, 'customer');
  return { w, a, b, sup, cust };
}
/** Base plus a submitted PKR GRN: A 7 x 1,000 and B 3 x 1,000. */
function withGrn() {
  const s = base();
  const [w, grn] = createSubmit(s.w, 'goods_receipt', s.sup, [L(s.a, '7', '1000'), L(s.b, '3', '1000')]);
  return { ...s, w, grn };
}
function ship(w: Workspace, documentId: string, extra: Record<string, unknown> = {}, who: Actor = owner): [Workspace, string] {
  const r = run(w, 'create_shipment', { documentId, ...extra }, who);
  return [r.workspace, r.recordId];
}
function cost(w: Workspace, id: string, label: string, amount: string, classification = 'inventory', basis = 'value', who: Actor = owner) {
  return run(w, 'add_shipment_cost', { id, label, amount, classification, basis }, who).workspace;
}
function allocate(w: Workspace, id: string, extra: Record<string, unknown> = {}, who: Actor = owner, key?: string) {
  return run(w, 'allocate_shipment', { id, ...extra }, who, key);
}
/** A 10 x 100 received, `sold` units sold, shipment with one inventory cost of 1,000 by quantity allocated. */
function soldThenAllocated(sold: string) {
  let { w, a, sup, cust } = base();
  let grn: string, sh: string;
  [w, grn] = createSubmit(w, 'goods_receipt', sup, [L(a, '10', '100')]);
  if (D(sold).gt(0)) [w] = createSubmit(w, 'sales_invoice', cust, [L(a, sold, '500')]);
  [w, sh] = ship(w, grn);
  w = cost(w, sh, 'Duty', '1000', 'inventory', 'quantity');
  const r = allocate(w, sh);
  return { w: r.workspace, a, sup, cust, grn, sh, result: r };
}
function secondBranch(w: Workspace): Workspace {
  w = run(w, 'save_branch', { name: 'Lahore' }).workspace;
  return run(w, 'save_warehouse', { name: 'Lahore store', branchId: 'lahore' }).workspace;
}
/** IMP-017 cost set: freight/value, duty/quantity, import tax, deposit, agent fee. */
function fiveCosts(w: Workspace, sh: string) {
  w = cost(w, sh, 'Freight', '50000', 'inventory', 'value');
  w = cost(w, sh, 'Customs duty', '80000', 'inventory', 'quantity');
  w = cost(w, sh, 'Sales tax at import', '30000', 'recoverable_tax', 'value');
  w = cost(w, sh, 'Container deposit', '20000', 'deposit', 'value');
  return cost(w, sh, 'Clearing agent fee', '5000', 'expense', 'value');
}

describe('09 Imports and landed cost (IMP)', () => {
  it('IMP-001 create shipment from a submitted GRN: SHP-YYYY-001, supplier, Shenzhen → Karachi, status received', () => {
    const { w: w0, sup, grn } = withGrn();
    const [w, sh] = ship(w0, grn);
    const s = shOf(w, sh);
    expect(s).toMatchObject({ number: `SHP-${today().slice(0, 4)}-001`, supplierId: sup, documentId: grn, origin: 'Shenzhen', port: 'Karachi', status: 'received', eta: today(), costs: [], allocations: [] });
  });

  it('IMP-002 create from a draft GRN refused', () => {
    const { w: w0, a, sup } = base();
    const g = run(w0, 'create_document', { kind: 'goods_receipt', partyId: sup, warehouseId: firstWarehouse(w0), date: today(), dueDate: today(), lines: [L(a, '1')] });
    refused(g.workspace, 'create_shipment', { documentId: g.recordId }, 'Choose a submitted receipt or supplier bill.');
  });

  it('IMP-003 create from a PO refused', () => {
    const { w: w0, a, sup } = base();
    const [w, po] = createSubmit(w0, 'purchase_order', sup, [L(a, '1')]);
    refused(w, 'create_shipment', { documentId: po }, 'Choose a submitted receipt or supplier bill.');
  });

  it('IMP-004 create from a submitted bill allowed', () => {
    const { w: w0, a, sup } = base();
    const [w, bill] = createSubmit(w0, 'supplier_invoice', sup, [L(a, '2', '500')]);
    const [w2, sh] = ship(w, bill);
    expect(shOf(w2, sh).documentId).toBe(bill);
  });

  it('IMP-005 container, GD number and ETA saved [browser: shown in list]', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn, { container: 'MSKU1234567', gdNumber: 'KPPI-HC-12345-2026', eta: '2026-11-20' });
    expect(shOf(w, sh)).toMatchObject({ container: 'MSKU1234567', gdNumber: 'KPPI-HC-12345-2026', eta: '2026-11-20' });
  });

  it('IMP-006 invalid ETA refused by validation', () => {
    const { w, grn } = withGrn();
    refused(w, 'create_shipment', { documentId: grn, eta: '2026-02-30' }, /invalid_format|Invalid ISO date/);
  });

  it('IMP-007 GD number of 100 chars saved', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn, { gdNumber: 'G'.repeat(100) });
    expect(shOf(w, sh).gdNumber).toHaveLength(100);
  });

  it('IMP-008 add Freight 50,000 inventory by value: listed unallocated', () => {
    const { w: w0, grn } = withGrn();
    const [w1, sh] = ship(w0, grn);
    const w = cost(w1, sh, 'Freight', '50000', 'inventory', 'value');
    expect(shOf(w, sh).costs).toMatchObject([{ label: 'Freight', amount: '50000', classification: 'inventory', basis: 'value', allocated: false }]);
  });

  it('IMP-009 add Customs duty 80,000 inventory by quantity: listed', () => {
    const { w: w0, grn } = withGrn();
    const [w1, sh] = ship(w0, grn);
    const w = cost(w1, sh, 'Customs duty', '80000', 'inventory', 'quantity');
    expect(shOf(w, sh).costs[0]).toMatchObject({ label: 'Customs duty', basis: 'quantity', allocated: false });
  });

  it('IMP-010 add Sales tax at import 30,000 recoverable_tax: listed', () => {
    const { w: w0, grn } = withGrn();
    const [w1, sh] = ship(w0, grn);
    expect(shOf(cost(w1, sh, 'Sales tax at import', '30000', 'recoverable_tax'), sh).costs[0].classification).toBe('recoverable_tax');
  });

  it('IMP-011 add Container deposit 20,000 deposit: listed', () => {
    const { w: w0, grn } = withGrn();
    const [w1, sh] = ship(w0, grn);
    expect(shOf(cost(w1, sh, 'Container deposit', '20000', 'deposit'), sh).costs[0].classification).toBe('deposit');
  });

  it('IMP-012 add Clearing agent fee 5,000 expense: listed', () => {
    const { w: w0, grn } = withGrn();
    const [w1, sh] = ship(w0, grn);
    expect(shOf(cost(w1, sh, 'Clearing agent fee', '5000', 'expense'), sh).costs[0].classification).toBe('expense');
  });

  it('IMP-013 cost amount 0 refused', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn);
    refused(w, 'add_shipment_cost', { id: sh, label: 'Freight', amount: '0', classification: 'inventory', basis: 'value' }, 'Amount must be greater than zero.');
  });

  it('IMP-014 empty cost label refused', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn);
    refused(w, 'add_shipment_cost', { id: sh, label: '', amount: '10', classification: 'inventory', basis: 'value' }, /expected string to have >=1 characters/);
  });

  it('IMP-015 classification "other" via API refused', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn);
    refused(w, 'add_shipment_cost', { id: sh, label: 'X', amount: '10', classification: 'other', basis: 'value' }, /Invalid option/);
  });

  it('IMP-016 basis "price" via API refused', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn);
    refused(w, 'add_shipment_cost', { id: sh, label: 'X', amount: '10', classification: 'inventory', basis: 'price' }, /Invalid option/);
  });

  it('IMP-017 allocate: inventory costs into stock by basis; tax → 1300; deposit → 1400; expense → 5300', () => {
    const { w: w0, a, b, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = fiveCosts(w, sh);
    const r = allocate(w, sh);
    expect(r.message).toBe('Costs allocated. Inventory, COGS and supplier liability updated.');
    expect(sumBy(landedJournals(r.workspace)[0].lines)).toEqual({ '1200': '130000.0000', '1300': '30000.0000', '1400': '20000.0000', '5300': '5000.0000', '2000': '-185000.0000' });
    expect(stock(r.workspace, a).value).toBe('98000.0000');
    expect(stock(r.workspace, b).value).toBe('42000.0000');
    expect(shOf(r.workspace, sh).costs.every(c => c.allocated)).toBe(true);
    expectInvariants(r.workspace);
  });

  it('IMP-018 by value: 70%/30% lines get 70/30 of freight; remainder paisa on the last line', () => {
    const { w: w0, a, b, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Freight', '50000', 'inventory', 'value'), sh).workspace;
    expect([allocatedTo(w, sh, a), allocatedTo(w, sh, b)]).toEqual(['35000.0000', '15000.0000']);
    // 3 equal lines, 100 → 33.3333 / 33.3333 / 33.3334
    let x = freshCompany();
    let i1: string, i2: string, i3: string, sup: string, g: string, s2: string;
    [x, i1] = withItem(x); [x, i2] = withItem(x); [x, i3] = withItem(x); [x, sup] = withParty(x, 'supplier');
    [x, g] = createSubmit(x, 'goods_receipt', sup, [L(i1, '1', '10'), L(i2, '1', '10'), L(i3, '1', '10')]);
    [x, s2] = ship(x, g);
    x = allocate(cost(x, s2, 'Freight', '100', 'inventory', 'value'), s2).workspace;
    expect(shOf(x, s2).allocations.map(al => al.amount)).toEqual(['33.3333', '33.3333', '33.3334']);
  });

  it('IMP-019 by quantity splits by units', () => {
    const { w: w0, a, b, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Duty', '1000', 'inventory', 'quantity'), sh).workspace;
    expect([allocatedTo(w, sh, a), allocatedTo(w, sh, b)]).toEqual(['700.0000', '300.0000']);
  });

  it('IMP-020 by weight splits by qty x product weight', () => {
    const { w: w0, a, b, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Freight', '1700', 'inventory', 'weight'), sh).workspace;
    expect([allocatedTo(w, sh, a), allocatedTo(w, sh, b)]).toEqual(['1400.0000', '300.0000']);
  });

  it('IMP-021 by volume splits by qty x product volume', () => {
    const { w: w0, a, b, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Freight', '2400', 'inventory', 'volume'), sh).workspace;
    expect([allocatedTo(w, sh, a), allocatedTo(w, sh, b)]).toEqual(['2100.0000', '300.0000']);
  });

  it('IMP-022 weight 0 on one product: that line gets 0, others share, no NaN', () => {
    let { w, a, sup } = base();
    let c: string, g: string, sh: string;
    [w, c] = withItem(w, { weight: '0' });
    [w, g] = createSubmit(w, 'goods_receipt', sup, [L(a, '5', '100'), L(c, '5', '100')]);
    [w, sh] = ship(w, g);
    w = allocate(cost(w, sh, 'Freight', '900', 'inventory', 'weight'), sh).workspace;
    expect([allocatedTo(w, sh, a), allocatedTo(w, sh, c)]).toEqual(['900.0000', '0.0000']);
    expect(stock(w, c).value).toBe('500.0000');
    expectInvariants(w);
  });

  it('IMP-023 all weights 0 with basis weight [documented: allocation refused "Allocation needs positive weights."; no fallback]', () => {
    let { w, sup } = base();
    let c: string, g: string, sh: string;
    [w, c] = withItem(w, { weight: '0' });
    [w, g] = createSubmit(w, 'goods_receipt', sup, [L(c, '5', '100')]);
    [w, sh] = ship(w, g);
    w = cost(w, sh, 'Freight', '900', 'inventory', 'weight');
    refused(w, 'allocate_shipment', { id: sh }, 'Allocation needs positive weights.');
  });

  it('IMP-024 average cost after allocation = (stock value + allocated) / qty', () => {
    const { w: w0, a, b, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(fiveCosts(w, sh), sh).workspace;
    expect(stock(w, a).average).toBe('14000.0000');
    expect(stock(w, b).average).toBe('14000.0000');
  });

  it('IMP-025 allocation after part of the stock is sold: remaining stock gets its share, sold share to COGS', () => {
    const { w, a, sh } = soldThenAllocated('4');
    expect(sumBy(landedJournals(w)[0].lines)).toEqual({ '1200': '600.0000', '5000': '400.0000', '2000': '-1000.0000' });
    expect(stock(w, a)).toEqual({ quantity: '6.0000', value: '1200.0000', average: '200.0000' });
    expect(shOf(w, sh).status).toBe('costed');
    expectInvariants(w);
  });

  it('IMP-026 allocation after all stock sold: entire inventory cost to COGS, stock value stays 0', () => {
    const { w, a } = soldThenAllocated('10');
    expect(sumBy(landedJournals(w)[0].lines)).toEqual({ '5000': '1000.0000', '2000': '-1000.0000' });
    expect(stock(w, a)).toEqual({ quantity: '0.0000', value: '0.0000', average: '0.0000' });
    expectInvariants(w);
  });

  it('IMP-027 allocating twice refused', () => {
    const { w, sh } = soldThenAllocated('0');
    refused(w, 'allocate_shipment', { id: sh }, 'All shipment costs are already allocated.');
  });

  it('IMP-028 another cost after allocation: only the new cost is allocated; status costed again', () => {
    const { w: w0, sh, a } = soldThenAllocated('0');
    const w1 = cost(w0, sh, 'Late demurrage', '500', 'inventory', 'quantity');
    expect(shOf(w1, sh).status).toBe('received');
    const w = allocate(w1, sh).workspace;
    expect(landedJournals(w)).toHaveLength(2);
    expect(sumBy(landedJournals(w)[1].lines)).toEqual({ '1200': '500.0000', '2000': '-500.0000' });
    expect(shOf(w, sh).status).toBe('costed');
    expect(stock(w, a).value).toBe('2500.0000');
  });

  it('IMP-029 allocating in a locked period refused', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = cost(w, sh, 'Freight', '100');
    w = run(w, 'set_period', { month: '2026-01', locked: true }).workspace;
    refused(w, 'allocate_shipment', { id: sh, date: '2026-01-31' }, 'Accounting period 2026-01 is locked.');
  });

  it('IMP-030 Warehouse Manager allocating refused (Accountant/Owner only)', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = cost(w, sh, 'Freight', '100');
    refused(w, 'allocate_shipment', { id: sh }, 'Your role does not permit this action.', actor('Warehouse Manager'));
  });

  it('IMP-031 Warehouse Manager creates a shipment', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn, {}, actor('Warehouse Manager'));
    expect(shOf(w, sh)).toBeDefined();
  });

  it('IMP-032 Salesperson: shipments hidden and shipment commands refused [browser: Imports not in nav]', () => {
    const { w: w0, grn } = withGrn();
    const [w] = ship(w0, grn);
    const sp = actor('Salesperson', { employeeId: 'e' });
    expect(scopeWorkspace(w, sp).shipments).toEqual([]);
    refused(w, 'create_shipment', { documentId: grn }, 'Your role does not permit this action.', sp);
  });

  it('IMP-033 branch-limited user with a GRN in another branch refused', () => {
    let { w, a, sup } = base();
    w = secondBranch(w);
    let g: string;
    [w, g] = createSubmit(w, 'goods_receipt', sup, [L(a, '2')], { warehouseId: 'lahore-store' });
    refused(w, 'create_shipment', { documentId: g }, 'This warehouse is outside your permitted branches.', actor('Warehouse Manager', { branchIds: ['main'] }));
  });

  it('IMP-034 shipment status flow [documented: engine has no in_transit/customs commands; new shipments start "received", adding a cost sets "received", allocation sets "costed"]', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    expect(shOf(w, sh).status).toBe('received');
    w = cost(w, sh, 'Freight', '100');
    w = allocate(w, sh).workspace;
    expect(shOf(w, sh).status).toBe('costed');
    expect(commandSchema.shape.type.options.filter(t => t.includes('shipment'))).toEqual(['create_shipment', 'add_shipment_cost', 'allocate_shipment']);
  });

  it.todo('IMP-035 [browser] shipment list columns: shipment, supplier, container/GD, ETA, status, unallocated');

  it('IMP-036 unallocated total = sum of unallocated costs [browser: list column]', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = cost(w, sh, 'Freight', '100');
    w = allocate(w, sh).workspace;
    w = cost(w, sh, 'Duty', '250.5');
    w = cost(w, sh, 'Fee', '49.5', 'expense');
    const pending = shOf(w, sh).costs.filter(c => !c.allocated).reduce((t, c) => t.plus(c.amount), D(0));
    expect(pending.toFixed(4)).toBe('300.0000');
  });

  it.todo('IMP-037 [browser] customs/GD lookup (simulated) result (code review: no customs lookup exists anywhere in src — likely fails)');

  it('IMP-038 allocation journal: Dr 1200 / 1300 / 1400 / 5300, Cr 2000; balanced; one journal per allocation', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(fiveCosts(w, sh), sh).workspace;
    const js = landedJournals(w);
    expect(js).toHaveLength(1);
    expect(js[0].memo).toBe(`Landed costs · ${shOf(w, sh).number}`);
    const dr = js[0].lines.reduce((t, l) => t.plus(l.debit), D(0)), cr = js[0].lines.reduce((t, l) => t.plus(l.credit), D(0));
    expect([dr.toFixed(4), cr.toFixed(4)]).toEqual(['185000.0000', '185000.0000']);
  });

  it('IMP-039 reconciliation after allocation: inventory control = valuation', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(fiveCosts(w, sh), sh).workspace;
    expect(stockValuation(w).total).toBe(accountBalance(w, '1200'));
    expectInvariants(w);
  });

  it('IMP-040 P&L after allocation: expense cost in P&L, inventory cost not', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(fiveCosts(w, sh), sh).workspace;
    const pl = profitAndLoss(w, '2000-01-01', '2999-12-31');
    expect(pl.expenses).toEqual([{ code: '5300', name: 'Operating expense', amount: '5000.0000' }]);
  });

  it('IMP-041 deposit refunded later [documented: no refund command; a manual journal Dr bank / Cr 1400 clears it]', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Container deposit', '20000', 'deposit'), sh).workspace;
    expect(accountBalance(w, '1400')).toBe('20000.0000');
    w = run(w, 'create_journal', { memo: 'Container deposit refunded', date: today(), lines: [{ account: '1001', debit: '20000', credit: '0' }, { account: '1400', debit: '0', credit: '20000' }] }).workspace;
    expect(accountBalance(w, '1400')).toBe('0.0000');
  });

  it('IMP-042 cost 0.0001 accepted; allocation rounds small shares without error', () => {
    const { w: w0, a, b, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Tiny', '0.0001'), sh).workspace;
    expect([allocatedTo(w, sh, a), allocatedTo(w, sh, b)]).toEqual(['0.0001', '0.0000']);
    expectInvariants(w);
  });

  it('IMP-043 50 costs on one shipment allocated in one journal', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    for (let i = 0; i < 50; i++) w = cost(w, sh, `Charge ${i + 1}`, '10', i % 2 ? 'inventory' : 'expense', 'quantity');
    w = allocate(w, sh).workspace;
    expect(landedJournals(w)).toHaveLength(1);
    expect(sumBy(landedJournals(w)[0].lines)).toEqual({ '1200': '250.0000', '5300': '250.0000', '2000': '-500.0000' });
    expectInvariants(w);
  });

  it('IMP-044 GRN with 100 lines: allocation computes in under 2 s', () => {
    let w = freshCompany();
    const items: string[] = [];
    for (let i = 0; i < 100; i++) { let id: string; [w, id] = withItem(w, { weight: String(i % 5 + 1) }); items.push(id); }
    let sup: string, g: string, sh: string;
    [w, sup] = withParty(w, 'supplier');
    [w, g] = createSubmit(w, 'goods_receipt', sup, items.map((id, i) => L(id, String(i + 1), '10')));
    [w, sh] = ship(w, g);
    w = cost(w, sh, 'Freight', '12345.67', 'inventory', 'weight');
    const started = performance.now();
    w = allocate(w, sh).workspace;
    expect(performance.now() - started).toBeLessThan(2000);
    expectInvariants(w);
  });

  it('IMP-045 costs are PKR only [documented: a cost has no currency; on a USD GRN the amount is posted as PKR as entered] [browser: UI label "PKR"]', () => {
    let { w, a, sup } = base();
    let g: string, sh: string;
    [w, g] = createSubmit(w, 'goods_receipt', sup, [L(a, '10', '10')], { currency: 'USD', fxRate: '280' });
    [w, sh] = ship(w, g);
    w = allocate(cost(w, sh, 'Freight', '1000'), sh).workspace;
    expect(Object.keys(shOf(w, sh).costs[0]).sort()).toEqual(['allocated', 'amount', 'basis', 'classification', 'id', 'label']);
    expect(stock(w, a).value).toBe('29000.0000');
  });

  it('IMP-046 shipment for a walk-in supplier GRN works', () => {
    let { w, a } = base();
    const walk = run(w, 'save_party', { name: 'Walk-in supplier', type: 'supplier', city: '', phone: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Importer' });
    let g: string, sh: string;
    [w, g] = createSubmit(walk.workspace, 'goods_receipt', walk.recordId, [L(a, '5', '100')], { partyName: 'Port Trader' });
    [w, sh] = ship(w, g);
    expect(shOf(w, sh).supplierId).toBe(walk.recordId);
    w = allocate(cost(w, sh, 'Freight', '500'), sh).workspace;
    expect(stock(w, a).value).toBe('1000.0000');
  });

  it('IMP-047 shipment from a bill when a GRN also exists uses the bill lines', () => {
    let { w, a, b, sup } = base();
    let po: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(a, '7', '1000'), L(b, '3', '1000')]);
    const g = run(w, 'convert_document', { id: po, date: today() });
    w = run(g.workspace, 'submit_document', { id: g.recordId }).workspace;
    const bl = run(w, 'convert_document', { id: g.recordId, date: today(), lines: [L(a, '7', '1000')] });
    w = run(bl.workspace, 'submit_document', { id: bl.recordId }).workspace;
    let sh: string;
    [w, sh] = ship(w, bl.recordId);
    w = allocate(cost(w, sh, 'Freight', '700'), sh).workspace;
    expect(shOf(w, sh).allocations.map(x => [x.itemId, x.amount])).toEqual([[a, '700.0000']]);
    expect(stock(w, a).value).toBe('7700.0000');
    expectInvariants(w);
  });

  it('IMP-048 shipment from a cancelled GRN refused', () => {
    const { w: w0, a, sup } = base();
    const g = run(w0, 'create_document', { kind: 'goods_receipt', partyId: sup, warehouseId: firstWarehouse(w0), date: today(), dueDate: today(), lines: [L(a, '1')] });
    const w = run(g.workspace, 'cancel_document', { id: g.recordId }).workspace;
    refused(w, 'create_shipment', { documentId: g.recordId }, 'Choose a submitted receipt or supplier bill.');
  });

  it('IMP-049 two shipments for the same GRN [documented: allowed; each allocates its own costs]', () => {
    const { w: w0, a, grn } = withGrn();
    let [w, s1] = ship(w0, grn);
    let s2: string; [w, s2] = ship(w, grn);
    expect(shOf(w, s2).number).toBe(`SHP-${today().slice(0, 4)}-002`);
    w = allocate(cost(w, s1, 'Freight', '700', 'inventory', 'quantity'), s1).workspace;
    w = allocate(cost(w, s2, 'Duty', '1400', 'inventory', 'quantity'), s2).workspace;
    expect([allocatedTo(w, s1, a), allocatedTo(w, s2, a)]).toEqual(['490.0000', '980.0000']);
    expect(landedJournals(w)).toHaveLength(2);
  });

  it('IMP-050 delete a cost before allocation [documented: not supported; no delete command exists]', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = cost(w, sh, 'Freight', '100');
    refused(w, 'delete_shipment_cost', { id: sh, costId: shOf(w, sh).costs[0].id }, /Invalid option/);
  });

  it('IMP-051 edit a cost after allocation [documented: no edit command; allocated costs are immutable]', () => {
    const { w } = soldThenAllocated('0');
    expect(commandSchema.shape.type.options.some(t => /update_shipment|edit_shipment/.test(t))).toBe(false);
    refused(w, 'update_shipment_cost', { id: w.shipments[0].id }, /Invalid option/);
  });

  it('IMP-052 shipment numbers SHP-YYYY-001, 002', () => {
    const { w: w0, grn } = withGrn();
    let [w] = ship(w0, grn);
    [w] = ship(w, grn);
    const y = today().slice(0, 4);
    expect(w.shipments.map(s => s.number)).toEqual([`SHP-${y}-001`, `SHP-${y}-002`]);
  });

  it.todo('IMP-053 [browser] shipment table on phone shows scroll hint');
  it.todo('IMP-054 [browser] add-cost dialog: amount empty with placeholder (code review: no add-cost dialog found in src/components)');
  it.todo('IMP-055 [browser] classification help text explains each class');
  it.todo('IMP-056 [browser] search finds shipment by number/container');
  it.todo('IMP-057 [browser] attention queue lists shipments with unallocated costs');

  it('IMP-058 allocation then stock transfer: value moves with units', () => {
    let { w, a } = soldThenAllocated('0');
    w = secondBranch(w);
    w = run(w, 'stock_transfer', { itemId: a, from: firstWarehouse(w), to: 'lahore-store', quantity: '3', date: today() }).workspace;
    expect(stock(w, a, 'lahore-store')).toEqual({ quantity: '3.0000', value: '600.0000', average: '200.0000' });
    expect(stock(w, a, firstWarehouse(w)).value).toBe('1400.0000');
    expectInvariants(w);
  });

  it('IMP-059 allocation then supplier return [documented: return removes stock at the bill line cost (excl. landed cost); landed cost stays on remaining units; payable reduced by bill price only]', () => {
    let { w, a, sup } = base();
    let po: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(a, '10', '100')]);
    const g = run(w, 'convert_document', { id: po, date: today() });
    w = run(g.workspace, 'submit_document', { id: g.recordId }).workspace;
    let sh: string;
    [w, sh] = ship(w, g.recordId);
    w = allocate(cost(w, sh, 'Duty', '1000', 'inventory', 'quantity'), sh).workspace;
    const bl = run(w, 'convert_document', { id: g.recordId, date: today() });
    w = run(bl.workspace, 'submit_document', { id: bl.recordId }).workspace;
    const r = run(w, 'return_document', { id: bl.recordId, lines: [{ lineId: docOf(w, bl.recordId).lines[0].id, quantity: '1' }] });
    expect(sumBy(r.workspace.journals.find(j => j.sourceId === r.recordId)!.lines)).toEqual({ '2000': '100.0000', '1200': '-100.0000' });
    expect(stock(r.workspace, a)).toEqual({ quantity: '9.0000', value: '1900.0000', average: '211.1111' });
    expectInvariants(r.workspace);
  });

  it('IMP-060 allocation then count correction uses the new average', () => {
    let { w, a } = soldThenAllocated('0');
    w = run(w, 'set_stock_quantity', { itemId: a, warehouseId: firstWarehouse(w), expectedQuantity: '10', targetQuantity: '8', date: today(), reason: 'Count' }).workspace;
    expect(stock(w, a)).toEqual({ quantity: '8.0000', value: '1600.0000', average: '200.0000' });
    expectInvariants(w);
  });

  it('IMP-061 idempotent allocate retry gives one journal', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = cost(w, sh, 'Freight', '100');
    const first = allocate(w, sh, {}, owner, 'qa-imp-061-allocate');
    const retry = allocate(first.workspace, sh, {}, owner, 'qa-imp-061-allocate');
    expect(retry.message).toBe('This operation was already completed.');
    expect(landedJournals(retry.workspace)).toHaveLength(1);
  });

  it('IMP-062 audit entries for shipment commands', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Freight', '100'), sh).workspace;
    const actions = w.audit.filter(e => e.sourceId === sh).map(e => e.action);
    expect(actions).toEqual(['create_shipment', 'add_shipment_cost', 'allocate_shipment']);
  });

  it('IMP-063 hidden Imports with existing shipments: data kept, API refused [browser: view hidden]', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    const off = run(w, 'set_modules', { enabled: toggleModules.filter(m => m !== 'imports') });
    expect(off.message).toBe('Hid Imports & costing; records are kept');
    expect(shOf(off.workspace, sh)).toBeDefined();
    refused(off.workspace, 'add_shipment_cost', { id: sh, label: 'X', amount: '1', classification: 'inventory', basis: 'value' }, 'Imports & costing is turned off for this company. Turn it on in Settings → Features.');
  });

  it('IMP-064 turning Imports on later [documented: nothing is provisioned; deposit/expense accounts are part of the fixed chart]', () => {
    const w0 = freshCompany(toggleModules.filter(m => m !== 'imports'));
    const on = run(w0, 'set_modules', { enabled: [...toggleModules] });
    expect(on.message).toBe('Turned on Imports & costing');
    expect(on.workspace.bankAccounts).toEqual(w0.bankAccounts);
    const again = run(on.workspace, 'set_modules', { enabled: [...toggleModules] });
    expect(again.message).toBe('No module changes.');
  });

  it('IMP-065 label with emoji saved', () => {
    const { w: w0, grn } = withGrn();
    const [w1, sh] = ship(w0, grn);
    expect(shOf(cost(w1, sh, 'Freight 🚢 sea', '10'), sh).costs[0].label).toBe('Freight 🚢 sea');
  });

  it('IMP-066 amount 999,999,999,999 [case-corrected: accepted (below one trillion); 1,000,000,000,000 is refused]', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn);
    expect(shOf(cost(w, sh, 'Huge', '999999999999'), sh).costs[0].amount).toBe('999999999999');
    refused(w, 'add_shipment_cost', { id: sh, label: 'Huge', amount: '1000000000000', classification: 'inventory', basis: 'value' }, 'Enter a valid number below one trillion.');
  });

  it('IMP-067 negative amount refused', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn);
    refused(w, 'add_shipment_cost', { id: sh, label: 'X', amount: '-5', classification: 'inventory', basis: 'value' }, 'Amount must be greater than zero.');
  });

  it('IMP-068 ETA in the past allowed', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn, { eta: '2025-01-01' });
    expect(shOf(w, sh).eta).toBe('2025-01-01');
  });

  it('IMP-069 origin/port blank [case-corrected: defaults apply only when the fields are omitted; blank strings are stored blank]', () => {
    const { w: w0, grn } = withGrn();
    const [w1, s1] = ship(w0, grn);
    expect([shOf(w1, s1).origin, shOf(w1, s1).port]).toEqual(['Shenzhen', 'Karachi']);
    const [w2, s2] = ship(w0, grn, { origin: '', port: '' });
    expect([shOf(w2, s2).origin, shOf(w2, s2).port]).toEqual(['', '']);
  });

  it('IMP-070 per-line landed cost data available after allocation [browser: shown on shipment detail]', () => {
    const { w: w0, a, b, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Freight', '1000', 'inventory', 'quantity'), sh).workspace;
    const perUnit = (item: string, units: string) => D(docOf(w, grn).lines.find(l => l.itemId === item)!.cost).plus(D(allocatedTo(w, sh, item)).div(units)).toFixed(4);
    expect([perUnit(a, '7'), perUnit(b, '3')]).toEqual(['1100.0000', '1100.0000']);
  });

  it('IMP-071 landed cost per unit = (price x rate + allocated) / qty exactly', () => {
    let { w, a, sup } = base();
    let g: string, sh: string;
    [w, g] = createSubmit(w, 'goods_receipt', sup, [L(a, '10', '10')], { currency: 'USD', fxRate: '280' });
    [w, sh] = ship(w, g);
    w = allocate(cost(w, sh, 'Freight', '2000'), sh).workspace;
    expect(stock(w, a).average).toBe('3000.0000');
  });

  it('IMP-072 sales after landed cost use the new COGS', () => {
    let { w, a, sup, cust } = base();
    let g: string, sh: string, inv: string;
    [w, g] = createSubmit(w, 'goods_receipt', sup, [L(a, '10', '10')], { currency: 'USD', fxRate: '280' });
    [w, sh] = ship(w, g);
    w = allocate(cost(w, sh, 'Freight', '2000'), sh).workspace;
    [w, inv] = createSubmit(w, 'sales_invoice', cust, [L(a, '1', '5000')]);
    expect(sumBy(w.journals.find(j => j.sourceId === inv)!.lines)['5000']).toBe('3000.0000');
    expect(summary(w).margin).toBe('2000.0000');
  });

  it('IMP-073 margin after allocation [case-corrected: Sales analysis has no margin column; the overview margin (summary) reflects landed cost]', () => {
    let { w, a, sup, cust } = base();
    let g: string, sh: string;
    [w, g] = createSubmit(w, 'goods_receipt', sup, [L(a, '10', '100')]);
    [w] = createSubmit(w, 'sales_invoice', cust, [L(a, '5', '300')]);
    expect(summary(w).margin).toBe('1000.0000');
    [w, sh] = ship(w, g);
    w = allocate(cost(w, sh, 'Duty', '1000', 'inventory', 'quantity'), sh).workspace;
    expect(summary(w).margin).toBe('500.0000');
  });

  it('IMP-074 Auditor views shipments read-only', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = cost(w, sh, 'Freight', '100');
    const aud = actor('Auditor');
    expect(scopeWorkspace(w, aud).shipments.map(s => s.id)).toEqual([sh]);
    refused(w, 'allocate_shipment', { id: sh }, 'Your role does not permit this action.', aud);
    refused(w, 'add_shipment_cost', { id: sh, label: 'X', amount: '1', classification: 'inventory', basis: 'value' }, 'Your role does not permit this action.', aud);
  });

  it('IMP-075 add_shipment_cost as Payroll Administrator refused', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn);
    refused(w, 'add_shipment_cost', { id: sh, label: 'X', amount: '1', classification: 'inventory', basis: 'value' }, 'Your role does not permit this action.', actor('Payroll Administrator'));
  });

  it('IMP-076 allocating a shipment with no costs refused', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn);
    refused(w, 'allocate_shipment', { id: sh }, 'All shipment costs are already allocated.');
  });

  it('IMP-077 stock valuation shows the landed value', () => {
    const { w: w0, a, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(fiveCosts(w, sh), sh).workspace;
    expect(stockValuation(w).rows.find(r => r.itemId === a)).toMatchObject({ quantity: '7.0000', average: '14000.0000', value: '98000.0000' });
  });

  it('IMP-078 GRN print model unaffected by allocation', () => {
    const { w: w0, grn } = withGrn();
    const before = documentView(w0, docOf(w0, grn));
    let [w, sh] = ship(w0, grn);
    w = allocate(fiveCosts(w, sh), sh).workspace;
    expect(documentView(w, docOf(w, grn))).toEqual(before);
  });

  it('IMP-079 allocation across 3 lines of 1/3 each sums exactly to the cost', () => {
    let w = freshCompany();
    let i1: string, i2: string, i3: string, sup: string, g: string, sh: string;
    [w, i1] = withItem(w); [w, i2] = withItem(w); [w, i3] = withItem(w); [w, sup] = withParty(w, 'supplier');
    [w, g] = createSubmit(w, 'goods_receipt', sup, [L(i1, '1', '10'), L(i2, '1', '10'), L(i3, '1', '10')]);
    [w, sh] = ship(w, g);
    w = allocate(cost(w, sh, 'Freight', '1000', 'inventory', 'quantity'), sh).workspace;
    const amounts = shOf(w, sh).allocations.map(x => x.amount);
    expect(amounts).toEqual(['333.3333', '333.3333', '333.3334']);
    expect(amounts.reduce((t, x) => t.plus(x), D(0)).toFixed(4)).toBe('1000.0000');
    expectInvariants(w);
  });

  it('IMP-080 allocation with lines of quantity 0.5 works', () => {
    let { w, a, b, sup } = base();
    let g: string, sh: string;
    [w, g] = createSubmit(w, 'goods_receipt', sup, [L(a, '0.5', '200'), L(b, '0.5', '100')]);
    [w, sh] = ship(w, g);
    w = allocate(cost(w, sh, 'Freight', '30', 'inventory', 'weight'), sh).workspace;
    expect([allocatedTo(w, sh, a), allocatedTo(w, sh, b)]).toEqual(['20.0000', '10.0000']);
    expect(stock(w, a)).toEqual({ quantity: '0.5000', value: '120.0000', average: '240.0000' });
    expectInvariants(w);
  });

  it('IMP-081 nothing left unallocated after allocation (attention count source is 0) [browser: attention item clears]', () => {
    const { w } = soldThenAllocated('0');
    expect(w.shipments.reduce((n, sh) => n + sh.costs.filter(c => !c.allocated).length, 0)).toBe(0);
  });

  it.todo('IMP-082 [browser] shipment list sorted newest first');
  it.todo('IMP-083 [browser] shipment filter by status');
  it.todo('IMP-084 [browser] 200 shipments list renders');

  it('IMP-085 recoverable tax appears in reports [documented: no separate tax summary; shown as 1300 Recoverable tax on the balance sheet and trial balance]', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Sales tax at import', '30000', 'recoverable_tax'), sh).workspace;
    expect(balanceSheet(w, '2999-12-31').assets).toContainEqual({ code: '1300', name: 'Recoverable tax', amount: '30000.0000' });
    expect(trialBalance(w, '2999-12-31').rows).toContainEqual({ code: '1300', name: 'Recoverable tax', debit: '30000.0000', credit: '' });
  });

  it('IMP-086 expense classification in P&L [case-corrected: posts to 5300 "Operating expense", not a separate clearing/import expense line]', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Clearing agent fee', '5000', 'expense'), sh).workspace;
    expect(profitAndLoss(w, '2000-01-01', '2999-12-31').expenses).toEqual([{ code: '5300', name: 'Operating expense', amount: '5000.0000' }]);
  });

  it('IMP-087 deposit classification on the balance sheet as an asset (1400)', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Container deposit', '20000', 'deposit'), sh).workspace;
    const bs = balanceSheet(w, '2999-12-31');
    expect(bs.assets).toContainEqual({ code: '1400', name: 'Deposits & advances', amount: '20000.0000' });
    expect(bs.difference).toBe('0.0000');
  });

  it.todo('IMP-088 [browser] shipment actions reachable by keyboard');
  it.todo('IMP-089 [browser] pastel status badge colours per status');

  it('IMP-090 shipment from a GRN of a supplier archived later is still listed and can be allocated', () => {
    const { w: w0, sup, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = run(w, 'set_archived', { kind: 'party', id: sup, archived: true }).workspace;
    expect(scopeWorkspace(w, owner).shipments.map(s => s.id)).toEqual([sh]);
    w = allocate(cost(w, sh, 'Freight', '100'), sh).workspace;
    expect(shOf(w, sh).status).toBe('costed');
  });

  it('IMP-091 Imports requires Inventory (and Purchasing): cannot be on alone', () => {
    let w = freshCompany(['sales']);
    const r = run(w, 'set_modules', { enabled: ['sales', 'imports'] });
    expect(r.workspace.modules).toEqual(expect.arrayContaining(['purchasing', 'inventory', 'imports']));
    expect(r.message).toBe('Turned on Purchasing, Inventory, Imports & costing (Purchasing, Inventory required)');
    w = r.workspace;
    expect(w.warehouses.length).toBeGreaterThan(0);
  });

  it('IMP-092 turning off Inventory with Imports on [documented: engine refuses unless Imports is also turned off ("Imports & costing cannot stay on without Inventory."); dropping both hides both]', () => {
    const w = freshCompany();
    refused(w, 'set_modules', { enabled: toggleModules.filter(m => m !== 'inventory') }, 'Imports & costing cannot stay on without Inventory.');
    const both = run(w, 'set_modules', { enabled: toggleModules.filter(m => !['inventory', 'imports'].includes(m)) });
    expect(both.workspace.modules).not.toContain('imports');
    expect(both.workspace.modules).not.toContain('inventory');
  });

  it('IMP-093 allocation date defaults to today; a custom open-period date dates the journal', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(cost(w, sh, 'Freight', '100'), sh).workspace;
    expect(landedJournals(w)[0].date).toBe(today());
    w = allocate(cost(w, sh, 'Duty', '100'), sh, { date: '2026-12-15' }).workspace;
    expect(landedJournals(w)[1].date).toBe('2026-12-15');
  });

  it('IMP-094 future allocation date: only locked months refused', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = cost(w, sh, 'Freight', '100');
    const locked = run(w, 'set_period', { month: '2027-03', locked: true }).workspace;
    refused(locked, 'allocate_shipment', { id: sh, date: '2027-03-01' }, 'Accounting period 2027-03 is locked.');
    expect(allocate(locked, sh, { date: '2027-02-01' }).workspace.journals.at(-1)!.date).toBe('2027-02-01');
  });

  it('IMP-095 container number with spaces saved as typed', () => {
    const { w: w0, grn } = withGrn();
    const [w, sh] = ship(w0, grn, { container: '  MSKU 123 4567 ' });
    expect(shOf(w, sh).container).toBe('  MSKU 123 4567 ');
  });

  it('IMP-096 allocation on a GRN with 100 lines and 20 costs in under 3 s', () => {
    let w = freshCompany();
    const items: string[] = [];
    for (let i = 0; i < 100; i++) { let id: string; [w, id] = withItem(w, { weight: '1.5', volume: '0.2' }); items.push(id); }
    let sup: string, g: string, sh: string;
    [w, sup] = withParty(w, 'supplier');
    [w, g] = createSubmit(w, 'goods_receipt', sup, items.map(id => L(id, '3', '17')));
    [w, sh] = ship(w, g);
    const bases = ['value', 'quantity', 'weight', 'volume'];
    for (let i = 0; i < 20; i++) w = cost(w, sh, `Charge ${i}`, '999.99', 'inventory', bases[i % 4]);
    const started = performance.now();
    w = allocate(w, sh).workspace;
    expect(performance.now() - started).toBeLessThan(3000);
    expectInvariants(w);
  });

  it.todo('IMP-097 [browser] export shipments CSV if present (code review: no shipment CSV export found)');
  it.todo('IMP-098 [browser] attention item link opens Imports');

  it('IMP-099 trial balance balanced after all import postings', () => {
    const { w: w0, grn } = withGrn();
    let [w, sh] = ship(w0, grn);
    w = allocate(fiveCosts(w, sh), sh).workspace;
    const tb = trialBalance(w, '2999-12-31');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expectInvariants(w);
  });

  it('IMP-100 end to end: USD GRN → shipment → 5 classified costs → allocate → sell → P&L and reconciliation correct', () => {
    let { w, a, b, sup, cust } = base();
    let g: string, sh: string;
    [w, g] = createSubmit(w, 'goods_receipt', sup, [L(a, '7', '10'), L(b, '3', '10')], { currency: 'USD', fxRate: '280' });
    [w, sh] = ship(w, g, { container: 'MSKU7654321', gdNumber: 'GD-1' });
    w = allocate(fiveCosts(w, sh), sh).workspace;
    expect(stock(w, a).average).toBe('15800.0000');
    [w] = createSubmit(w, 'sales_invoice', cust, [L(a, '2', '20000')]);
    const pl = profitAndLoss(w, '2000-01-01', '2999-12-31');
    expect(pl.totalRevenue).toBe('40000.0000');
    expect(pl.expenses).toEqual([{ code: '5000', name: 'Cost of goods sold', amount: '31600.0000' }, { code: '5300', name: 'Operating expense', amount: '5000.0000' }]);
    expect(pl.netProfit).toBe('3400.0000');
    expect(accountBalance(w, '1300')).toBe('30000.0000');
    expect(accountBalance(w, '1400')).toBe('20000.0000');
    expectInvariants(w);
  });
});
