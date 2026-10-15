import { describe, expect, it } from 'vitest';
import { accountBalance, actor, expectInvariants, firstWarehouse, freshCompany, owner, refused, run, today, withItem, withParty, D, outstanding } from './helpers';
import { commissionTotals, summary } from '../../src/modules/erp/engine';
import { receiptView } from '../../src/modules/erp/documents';
import { agedBalances, partyStatement, trialBalance } from '../../src/modules/erp/reports';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { toggleModules } from '../../src/modules/erp/modules';
import type { Actor, Workspace } from '../../src/modules/erp/types';

// ---------- private helpers ----------
const L = (itemId: string, quantity = '1', price = '100', extra: Record<string, unknown> = {}) => ({ itemId, quantity, price, discount: '0', taxRate: '0', employeeId: '', splits: [], ...extra });
const docOf = (w: Workspace, id: string) => w.documents.find(d => d.id === id)!;
const rcOf = (w: Workspace, id: string) => w.receipts.find(r => r.id === id)!;
const journalOf = (w: Workspace, sourceId: string) => w.journals.find(j => j.sourceId === sourceId);
const byAccount = (w: Workspace, sourceId: string) => {
  const out: Record<string, string> = {};
  for (const l of journalOf(w, sourceId)?.lines ?? []) out[l.account] = D(out[l.account] ?? 0).plus(l.debit).minus(l.credit).toFixed(4);
  return out;
};
function invoice(w: Workspace, partyId: string, item: string, quantity = '100', extra: Record<string, unknown> = {}, lineExtra: Record<string, unknown> = {}, who: Actor = owner): [Workspace, string] {
  const c = run(w, 'create_document', { kind: 'sales_invoice', partyId, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, quantity, '100', lineExtra)], ...extra }, who);
  return [run(c.workspace, 'submit_document', { id: c.recordId }, who).workspace, c.recordId];
}
/** Company with a salesperson on a 5% plan, 1,000 units in stock, one customer, and a 10,000 invoice booked to the salesperson. */
function base() {
  let w = freshCompany();
  let item: string, cust: string;
  [w, item] = withItem(w, { name: 'Kettle' }, { quantity: '1000', cost: '60' });
  [w, cust] = withParty(w, 'customer', { name: 'Al-Noor Electronics' });
  const e = run(w, 'save_employee', { name: 'Hamza Khan', role: 'Salesperson', territory: 'Karachi', salary: '50000', allowance: '0', deduction: '0', attendance: 30, active: true });
  w = e.workspace;
  w = run(w, 'save_plan', { ...w.plans[0], rate: '5' }).workspace;
  let inv: string;
  [w, inv] = invoice(w, cust, item, '100', {}, { employeeId: e.recordId });
  return { w, item, cust, emp: e.recordId, inv };
}
function receipt(w: Workspace, partyId: string, allocations: { invoiceId: string; amount: string }[], extra: Record<string, unknown> = {}, who: Actor = owner, key?: string) {
  const amount = allocations.reduce((t, a) => t.plus(a.amount), D(0)).toString();
  return run(w, 'create_receipt', { partyId, date: today(), amount, method: 'cash', chequeNo: '', dueDate: today(), allocations, employeeId: '', note: '', accountId: 'cash', ...extra }, who, key);
}
function cheque(w: Workspace, partyId: string, invoiceId: string, amount: string, extra: Record<string, unknown> = {}, who: Actor = owner): [Workspace, string] {
  const r = receipt(w, partyId, [{ invoiceId, amount }], { method: 'cheque', chequeNo: 'CHQ-0001', accountId: undefined, ...extra }, who);
  return [r.workspace, r.recordId];
}
const chq = (w: Workspace, id: string, status: string, extra: Record<string, unknown> = {}, who: Actor = owner, key?: string) => run(w, 'update_cheque', { id, status, ...extra }, who, key);
const deposit = (w: Workspace, id: string, accountId = 'main-bank') => chq(w, id, 'deposited', { accountId }).workspace;
const released = (w: Workspace, inv: string) => w.commissions.filter(c => c.invoiceId === inv).reduce((t, c) => t.plus(c.released), D(0)).toFixed(4);
const raw = (partyId: string, allocations: unknown[], extra: Record<string, unknown> = {}) => ({ partyId, date: today(), amount: '1000', method: 'cash', chequeNo: '', dueDate: today(), allocations, employeeId: '', note: '', accountId: 'cash', ...extra });
function secondBranch(w: Workspace): Workspace {
  w = run(w, 'save_branch', { name: 'Lahore' }).workspace;
  return run(w, 'save_warehouse', { name: 'Lahore store', branchId: 'lahore' }).workspace;
}

describe('10 Collections: receipts, cheques (PDC), follow-ups (COL)', () => {
  it('COL-001 cash 5,000 to Cash in hand allocated to an invoice: posted, invoice paid, cash up', () => {
    const { w: w0, cust, inv } = base();
    const r = receipt(w0, cust, [{ invoiceId: inv, amount: '5000' }]);
    expect(r.message).toBe('Payment posted and allocated.');
    expect(rcOf(r.workspace, r.recordId).status).toBe('cleared');
    expect(docOf(r.workspace, inv).paid).toBe('5000.0000');
    expect(accountBalance(r.workspace, '1002')).toBe('5000.0000');
    expectInvariants(r.workspace);
  });

  it.todo('COL-002 [browser] typing a total spreads it across open invoices oldest first; allocations editable');

  it('COL-003 amount 0 refused', () => {
    const { w, cust, inv } = base();
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '0' }], { amount: '0' }), 'Amount must be greater than zero.');
  });

  it("COL-004 allocations that don't sum to the amount refused", () => {
    const { w, cust, inv } = base();
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '900' }], { amount: '1000' }), 'Allocations must equal the receipt amount.');
  });

  it('COL-005 allocation above the invoice outstanding refused [case-corrected: message is "Invalid invoice allocation."]', () => {
    const { w, cust, inv } = base();
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '10001' }], { amount: '10001' }), 'Invalid invoice allocation.');
  });

  it("COL-006 allocation to another customer's invoice refused [case-corrected: message is \"Invalid invoice allocation.\"]", () => {
    let { w, inv } = base();
    let other: string; [w, other] = withParty(w, 'customer');
    refused(w, 'create_receipt', raw(other, [{ invoiceId: inv, amount: '1000' }]), 'Invalid invoice allocation.');
  });

  it('COL-007 allocation to a draft invoice refused [case-corrected: message is "Invalid invoice allocation."]', () => {
    const { w: w0, item, cust } = base();
    const d = run(w0, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w0), date: today(), dueDate: today(), lines: [L(item, '10')] });
    refused(d.workspace, 'create_receipt', raw(cust, [{ invoiceId: d.recordId, amount: '1000' }]), 'Invalid invoice allocation.');
  });

  it('COL-008 duplicate invoice in allocations refused', () => {
    const { w, cust, inv } = base();
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '500' }, { invoiceId: inv, amount: '500' }]), 'Duplicate allocation.');
  });

  it('COL-009 no allocations refused (min 1)', () => {
    const { w, cust } = base();
    refused(w, 'create_receipt', raw(cust, []), /expected array to have >=1 items/);
  });

  it('COL-010 amount 0.0001 accepted', () => {
    const { w: w0, cust, inv } = base();
    const w = receipt(w0, cust, [{ invoiceId: inv, amount: '0.0001' }]).workspace;
    expect(docOf(w, inv).paid).toBe('0.0001');
  });

  it('COL-011 exact outstanding: invoice fully paid, balance 0', () => {
    const { w: w0, cust, inv } = base();
    const w = receipt(w0, cust, [{ invoiceId: inv, amount: '10000' }]).workspace;
    expect(outstanding(docOf(w, inv))).toBe('0.0000');
  });

  it('COL-012 overpayment refused (exceeds outstanding)', () => {
    const { w: w0, cust, inv } = base();
    const w = receipt(w0, cust, [{ invoiceId: inv, amount: '9000' }]).workspace;
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '1001' }], { amount: '1001' }), 'Invalid invoice allocation.');
  });

  it('COL-013 bank receipt to the chosen bank account raises its balance', () => {
    const { w: w0, cust, inv } = base();
    const w = receipt(w0, cust, [{ invoiceId: inv, amount: '2500' }], { method: 'bank', accountId: 'main-bank' }).workspace;
    expect(accountBalance(w, '1001')).toBe('2500.0000');
  });

  it('COL-014 bank receipt into an archived account refused', () => {
    let { w, cust, inv } = base();
    const acct = run(w, 'save_bank_account', { name: 'Old Bank', type: 'bank', details: '' });
    w = run(acct.workspace, 'save_bank_account', { id: acct.recordId, name: 'Old Bank', type: 'bank', details: '', archived: true }).workspace;
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '1000' }], { method: 'bank', accountId: acct.recordId }), 'Old Bank is archived.');
  });

  it('COL-015 account id from another tenant not found', () => {
    const { w, cust, inv } = base();
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '1000' }], { method: 'bank', accountId: 'other-tenant-bank' }), 'Bank account not found.');
  });

  it('COL-016 cheque with number and next-week date: received, not collected, invoice unpaid, no journal', () => {
    const { w: w0, cust, inv } = base();
    const next = new Date(Date.parse(today()) + 7 * 86400000).toISOString().slice(0, 10);
    const r = receipt(w0, cust, [{ invoiceId: inv, amount: '10000' }], { method: 'cheque', chequeNo: 'HBL-778899', dueDate: next, accountId: undefined });
    expect(r.message).toBe('Cheque recorded. Commission releases only on clearance.');
    expect(rcOf(r.workspace, r.recordId)).toMatchObject({ status: 'received', dueDate: next });
    expect(docOf(r.workspace, inv).paid).toBe('0.0000');
    expect(summary(r.workspace).collections).toBe('0.0000');
    expect(r.workspace.journals.filter(j => j.sourceId.startsWith(r.recordId))).toHaveLength(0);
  });

  it('COL-017 cheque without a number refused', () => {
    const { w, cust, inv } = base();
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '1000' }], { method: 'cheque', chequeNo: '  ' }), 'Enter the cheque number.');
  });

  it('COL-018 cheque number 100 chars accepted; 101 refused', () => {
    const { w, cust, inv } = base();
    const [w1, id] = cheque(w, cust, inv, '1000', { chequeNo: '9'.repeat(100) });
    expect(rcOf(w1, id).chequeNo).toHaveLength(100);
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '1000' }], { method: 'cheque', chequeNo: '9'.repeat(101) }), /<=100 characters/);
  });

  it('COL-019 cheque dated today allowed', () => {
    const { w, cust, inv } = base();
    const [w1, id] = cheque(w, cust, inv, '1000', { dueDate: today() });
    expect(rcOf(w1, id).dueDate).toBe(today());
  });

  it('COL-020 post-dated 90 days allowed and stays in hand (received) [browser: cheques-in-hand list]', () => {
    const { w, cust, inv } = base();
    const later = new Date(Date.parse(today()) + 90 * 86400000).toISOString().slice(0, 10);
    const [w1, id] = cheque(w, cust, inv, '1000', { dueDate: later });
    expect(w1.receipts.filter(r => r.method === 'cheque' && ['received', 'deposited'].includes(r.status)).map(r => r.id)).toEqual([id]);
  });

  it('COL-021 deposit choosing a bank account: status deposited, account stored', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '1000');
    const r = chq(w1, id, 'deposited', { accountId: 'main-bank' });
    expect(r.message).toBe('Cheque deposited.');
    expect(rcOf(r.workspace, id)).toMatchObject({ status: 'deposited', accountId: 'main-bank' });
    expect(r.workspace.journals).toEqual(w1.journals);
  });

  it('COL-022 clear: cleared, bank up, invoice paid, commission released', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '10000');
    const r = chq(deposit(w1, id), id, 'cleared');
    expect(r.message).toBe('Cheque cleared.');
    expect(rcOf(r.workspace, id).status).toBe('cleared');
    expect(accountBalance(r.workspace, '1001')).toBe('10000.0000');
    expect(docOf(r.workspace, inv).paid).toBe('10000.0000');
    expect(released(r.workspace, inv)).toBe('500.0000');
    expectInvariants(r.workspace);
  });

  it('COL-023 clearing straight from received refused', () => {
    const { w: w0, cust, inv } = base();
    const [w, id] = cheque(w0, cust, inv, '1000');
    refused(w, 'update_cheque', { id, status: 'cleared' }, 'Invalid cheque transition.');
  });

  it('COL-024 depositing twice refused', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '1000');
    refused(deposit(w1, id), 'update_cheque', { id, status: 'deposited', accountId: 'main-bank' }, 'Invalid cheque transition.');
  });

  it('COL-025 bounce from deposited: bounced, nothing collected', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '1000');
    const w = chq(deposit(w1, id), id, 'bounced').workspace;
    expect(rcOf(w, id).status).toBe('bounced');
    expect(docOf(w, inv).paid).toBe('0.0000');
    expect(w.journals.filter(j => j.sourceId.startsWith(id))).toHaveLength(0);
    expect(summary(w).collections).toBe('0.0000');
  });

  it('COL-026 bounce from cleared: bank reversed, invoice unpaid, release reversed [documented: recovery is recorded only via payroll when commission was already paid (see COL-071)] [browser: cleared cheques are not listed with a Bounce button in the UI]', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '10000');
    const cleared = chq(deposit(w1, id), id, 'cleared').workspace;
    const w = chq(cleared, id, 'bounced').workspace;
    expect(accountBalance(w, '1001')).toBe('0.0000');
    expect(docOf(w, inv).paid).toBe('0.0000');
    expect(released(w, inv)).toBe('0.0000');
    expect(w.commissionMovements.filter(m => m.sourceId === id).map(m => [m.type, m.amount])).toEqual([['released', '500.0000'], ['release_reversed', '500.0000']]);
    expectInvariants(w);
  });

  it('COL-027 bouncing a bounced cheque refused', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '1000');
    refused(chq(w1, id, 'bounced').workspace, 'update_cheque', { id, status: 'bounced' }, 'Invalid cheque transition.');
  });

  it('COL-028 update_cheque on a cash receipt refused', () => {
    const { w: w0, cust, inv } = base();
    const r = receipt(w0, cust, [{ invoiceId: inv, amount: '100' }]);
    refused(r.workspace, 'update_cheque', { id: r.recordId, status: 'bounced' }, 'This payment is not a cheque.');
  });

  it('COL-029 clearing in a locked period refused', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '1000');
    const w = run(deposit(w1, id), 'set_period', { month: '2026-01', locked: true }).workspace;
    refused(w, 'update_cheque', { id, status: 'cleared', date: '2026-01-31' }, 'Accounting period 2026-01 is locked.');
  });

  it('COL-030 custom clear date dates the journal', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '1000');
    const w = chq(deposit(w1, id), id, 'cleared', { date: '2026-12-02' }).workspace;
    expect(journalOf(w, `${id}:cleared`)!.date).toBe('2026-12-02');
  });

  it.todo('COL-031 [browser] cheques in hand list (received/deposited) with per-state buttons');
  it.todo('COL-032 [browser] attention: cheques due today/overdue listed');

  it('COL-033 Collections metric counts cleared customer receipts only [browser: Overview card]', () => {
    let { w, item, cust, inv } = base();
    w = receipt(w, cust, [{ invoiceId: inv, amount: '1000' }]).workspace;
    let pending: string; [w, pending] = cheque(w, cust, inv, '2000');
    let sup: string, bill: string;
    [w, sup] = withParty(w, 'supplier');
    const b = run(w, 'create_document', { kind: 'supplier_invoice', partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '10', '50')] });
    w = run(b.workspace, 'submit_document', { id: b.recordId }).workspace; bill = b.recordId;
    w = run(w, 'create_receipt', { partyId: sup, date: today(), amount: '500', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: bill, amount: '500' }], employeeId: '', note: '', accountId: 'main-bank' }).workspace;
    expect(summary(w).collections).toBe('1000.0000');
    expect(rcOf(w, pending).status).toBe('received');
  });

  it('COL-034 cash receipt journal: Dr cash / Cr 1100', () => {
    const { w: w0, cust, inv } = base();
    const r = receipt(w0, cust, [{ invoiceId: inv, amount: '700' }]);
    expect(byAccount(r.workspace, `${r.recordId}:cleared`)).toEqual({ '1002': '700.0000', '1100': '-700.0000' });
  });

  it('COL-035 cheque receipt posts no journal until cleared [documented: no cheques-in-hand account]', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '700');
    const w2 = deposit(w1, id);
    expect(w2.journals.length).toBe(w0.journals.length);
    const w3 = chq(w2, id, 'cleared').workspace;
    expect(byAccount(w3, `${id}:cleared`)).toEqual({ '1001': '700.0000', '1100': '-700.0000' });
  });

  it('COL-036 bounce after clear: exact reversal linked to the original posting', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '700');
    const cleared = chq(deposit(w1, id), id, 'cleared').workspace;
    const w = chq(cleared, id, 'bounced').workspace;
    const original = journalOf(w, `${id}:cleared`)!, reversal = journalOf(w, `${id}:bounce`)!;
    expect(reversal.reversalOf).toBe(original.id);
    expect(reversal.memo).toBe('Cheque dishonoured');
    expect(reversal.lines).toEqual(original.lines.map(l => ({ account: l.account, debit: l.credit, credit: l.debit })));
  });

  it('COL-037 receivable control reconciles after receipts', () => {
    let { w, cust, inv } = base();
    w = receipt(w, cust, [{ invoiceId: inv, amount: '3000' }]).workspace;
    let id: string; [w, id] = cheque(w, cust, inv, '2000');
    w = chq(deposit(w, id), id, 'cleared').workspace;
    expect(accountBalance(w, '1100')).toBe('5000.0000');
    expectInvariants(w);
  });

  it('COL-038 idempotent retry of create_receipt gives one receipt [case-corrected: a replay returns the original recordId and message (D-17)]', () => {
    const { w: w0, cust, inv } = base();
    const a = receipt(w0, cust, [{ invoiceId: inv, amount: '100' }], {}, owner, 'qa-col-038-receipt');
    const b = receipt(a.workspace, cust, [{ invoiceId: inv, amount: '100' }], {}, owner, 'qa-col-038-receipt');
    expect([b.recordId, b.message]).toEqual([a.recordId, a.message]);
    expect(b.workspace.receipts).toHaveLength(1);
    expect(docOf(b.workspace, inv).paid).toBe('100.0000');
  });

  it('COL-039 idempotent retry of clear gives one journal [case-corrected: a replay returns the original recordId and message (D-17)]', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '700');
    const w2 = deposit(w1, id);
    const a = chq(w2, id, 'cleared', {}, owner, 'qa-col-039-clear');
    const b = chq(a.workspace, id, 'cleared', {}, owner, 'qa-col-039-clear');
    expect([b.recordId, b.message]).toEqual([a.recordId, a.message]);
    expect(b.workspace.journals.filter(j => j.sourceId === `${id}:cleared`)).toHaveLength(1);
  });

  it('COL-040 receipt for a walk-in customer invoice works [browser: dialog lists invoices by number and date only — typed name not shown]', () => {
    let { w, item } = base();
    const walk = run(w, 'save_party', { name: 'Walk-in customer', type: 'customer', city: '', phone: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Retailer' });
    let inv: string;
    [w, inv] = invoice(walk.workspace, walk.recordId, item, '3', { partyName: 'Rashid Kiryana' });
    const r = receipt(w, walk.recordId, [{ invoiceId: inv, amount: '300' }]);
    expect(outstanding(docOf(r.workspace, inv))).toBe('0.0000');
    expect(receiptView(r.workspace, rcOf(r.workspace, r.recordId)).lines[0].description).toBe(`Sales invoice ${docOf(w, inv).number}`);
  });

  it('COL-041 receipt note of 1,000 chars saved', () => {
    const { w: w0, cust, inv } = base();
    const r = receipt(w0, cust, [{ invoiceId: inv, amount: '1' }], { note: 'x'.repeat(1000) });
    expect(rcOf(r.workspace, r.recordId).note).toHaveLength(1000);
  });

  it('COL-042 receipt collector employeeId stored and optional', () => {
    const { w: w0, cust, inv, emp } = base();
    const a = receipt(w0, cust, [{ invoiceId: inv, amount: '1' }], { employeeId: emp });
    expect(rcOf(a.workspace, a.recordId).employeeId).toBe(emp);
    const b = run(w0, 'create_receipt', { partyId: cust, date: today(), amount: '1', method: 'cash', dueDate: today(), allocations: [{ invoiceId: inv, amount: '1' }], accountId: 'cash' });
    expect(rcOf(b.workspace, b.recordId).employeeId).toBe('');
  });

  it('COL-043 receipt print model: "Receipt", "Received from", allocations', () => {
    const { w: w0, cust, inv } = base();
    const r = receipt(w0, cust, [{ invoiceId: inv, amount: '2500' }], { note: 'Thanks' });
    const view = receiptView(r.workspace, rcOf(r.workspace, r.recordId));
    expect([view.title, view.partyLabel, view.party.name]).toEqual(['Receipt', 'Received from', 'Al-Noor Electronics']);
    expect(view.lines.map(l => [l.description, l.amount])).toEqual([[`Sales invoice ${docOf(w0, inv).number}`, '2500.0000']]);
    expect(view.totals).toEqual([{ label: 'Amount', value: '2500.0000', emphasis: true }]);
  });

  it('COL-044 receipt numbering sequential [case-corrected: REC-0001, REC-0002… one global series without a year, shared with supplier payments]', () => {
    const { w: w0, cust, inv } = base();
    const a = receipt(w0, cust, [{ invoiceId: inv, amount: '1' }]);
    const b = receipt(a.workspace, cust, [{ invoiceId: inv, amount: '1' }], { date: '2027-01-05' });
    expect(b.workspace.receipts.map(r => r.number)).toEqual(['REC-0001', 'REC-0002']);
  });

  it('COL-045 Recovery Officer records a customer receipt', () => {
    const { w: w0, cust, inv } = base();
    const r = receipt(w0, cust, [{ invoiceId: inv, amount: '100' }], {}, actor('Recovery Officer'));
    expect(rcOf(r.workspace, r.recordId).status).toBe('cleared');
  });

  it('COL-046 Salesperson recording a receipt [documented: refused, "Your role does not permit this action."]', () => {
    const { w, cust, inv, emp } = base();
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '1000' }]), 'Your role does not permit this action.', actor('Salesperson', { employeeId: emp }));
  });

  it('COL-047 Warehouse Manager recording a receipt refused', () => {
    const { w, cust, inv } = base();
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '1000' }]), 'Your role does not permit this action.', actor('Warehouse Manager'));
  });

  it('COL-048 branch-limited user clearing a cheque for another branch invoice refused', () => {
    let { w, cust } = base();
    w = secondBranch(w);
    let lhrItem: string; [w, lhrItem] = withItem(w, {}, { quantity: '10', cost: '50', warehouseId: 'lahore-store' });
    const c = run(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: 'lahore-store', date: today(), dueDate: today(), lines: [L(lhrItem, '5')] });
    w = run(c.workspace, 'submit_document', { id: c.recordId }).workspace;
    let id: string; [w, id] = cheque(w, cust, c.recordId, '500');
    w = deposit(w, id);
    refused(w, 'update_cheque', { id, status: 'cleared' }, 'This warehouse is outside your permitted branches.', actor('Accountant', { branchIds: ['main'] }));
  });

  it('COL-049 follow-up with note and next date', () => {
    const { w: w0, cust } = base();
    const r = run(w0, 'follow_up', { partyId: cust, note: 'Promised payment Friday', nextDate: '2026-10-20' }, actor('Recovery Officer'));
    expect(r.message).toBe('Follow-up saved · next action 2026-10-20.');
    expect(r.workspace.followUps.at(-1)).toMatchObject({ partyId: cust, note: 'Promised payment Friday', nextDate: '2026-10-20', date: today() });
  });

  it('COL-050 follow-up with an empty note refused', () => {
    const { w, cust } = base();
    refused(w, 'follow_up', { partyId: cust, note: '   ', nextDate: '2026-10-20' }, 'Enter a follow-up note.');
  });

  it('COL-051 follow-up with an invalid next date refused', () => {
    const { w, cust } = base();
    refused(w, 'follow_up', { partyId: cust, note: 'Call', nextDate: '2026-02-30' }, /invalid_format|Invalid ISO date/);
  });

  it('COL-052 follow-up due today is due (nextDate <= today) [browser: attention item]', () => {
    const { w: w0, cust } = base();
    const w = run(w0, 'follow_up', { partyId: cust, note: 'Call', nextDate: today() }).workspace;
    expect(w.followUps.filter(f => f.nextDate <= today())).toHaveLength(1);
  });

  it('COL-053 follow-up on a supplier via API is refused [defect]', () => {
    let { w } = base();
    let sup: string; [w, sup] = withParty(w, 'supplier');
    // Actual: accepted — follow_up only checks that the party exists (any type).
    refused(w, 'follow_up', { partyId: sup, note: 'Call', nextDate: '2026-10-20' }, /Customer not found|customer/i);
  });

  it.todo('COL-054 [browser] follow-up list per customer newest first');
  it.todo('COL-055 [browser] follow-up dialog closes on success');

  it('COL-056 Salesperson logging a follow-up refused', () => {
    const { w, cust, emp } = base();
    refused(w, 'follow_up', { partyId: cust, note: 'Call', nextDate: '2026-10-20' }, 'Your role does not permit this action.', actor('Salesperson', { employeeId: emp }));
  });

  it('COL-057 aged receivables after a partial receipt bucket by due date, net of paid', () => {
    let { w, item, cust } = base();
    let old: string;
    [w, old] = invoice(w, cust, item, '50', { date: '2026-09-01', dueDate: '2026-09-01' });
    w = receipt(w, cust, [{ invoiceId: old, amount: '1500' }]).workspace;
    const row = agedBalances(w, 'customer', '2026-10-14').rows.find(r => r.partyId === cust)!;
    // The base 10,000 invoice is dated today(): it counts as current while today <= asOf, and is excluded after.
    expect(row.d60).toBe('3500.0000');
    expect(D(row.total).minus(row.d60).toFixed(4)).toBe(today() <= '2026-10-14' ? '10000.0000' : '0.0000');
  });

  it('COL-058 customer statement running balance: invoice +, credit note −, receipt −', () => {
    let { w, item, cust } = base();
    let inv2: string;
    [w, inv2] = invoice(w, cust, item, '10');
    w = run(w, 'return_document', { id: inv2, lines: [{ lineId: docOf(w, inv2).lines[0].id, quantity: '1' }] }).workspace;
    w = receipt(w, cust, [{ invoiceId: inv2, amount: '300' }]).workspace;
    const st = partyStatement(w, cust, '2000-01-01', '2999-12-31');
    expect(st.lines.map(l => [l.description, l.debit, l.credit, l.balance])).toEqual([
      ['Sales invoice', '10000.0000', '', '10000.0000'],
      ['Sales invoice', '1000.0000', '', '11000.0000'],
      ['Credit note', '', '100.0000', '10900.0000'],
      ['Receipt · cash', '', '300.0000', '10600.0000'],
    ]);
  });

  it('COL-059 statement shows a cheque only once cleared [documented: received/deposited cheques are not shown as pending lines]', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '4000', { chequeNo: 'MCB-1' });
    const pending = partyStatement(deposit(w1, id), cust, '2000-01-01', '2999-12-31');
    expect(pending.lines.map(l => l.description)).toEqual(['Sales invoice']);
    const cleared = chq(deposit(w1, id), id, 'cleared').workspace;
    expect(partyStatement(cleared, cust, '2000-01-01', '2999-12-31').lines.map(l => l.description)).toEqual(['Sales invoice', 'Receipt · cheque MCB-1']);
  });

  it('COL-060 receipt dated before the invoice date [documented: allowed; aging unaffected, no crash]', () => {
    const { w: w0, cust, inv } = base();
    const w = receipt(w0, cust, [{ invoiceId: inv, amount: '1000' }], { date: '2026-02-01' }).workspace;
    expect(journalOf(w, `${w.receipts[0].id}:cleared`)!.date).toBe('2026-02-01');
    expect(agedBalances(w, 'customer', '2999-12-31').totals.total).toBe('9000.0000');
  });

  it('COL-061 receipt dated in the future [documented: allowed when the month is not locked]', () => {
    const { w: w0, cust, inv } = base();
    const w = receipt(w0, cust, [{ invoiceId: inv, amount: '1000' }], { date: '2027-06-30' }).workspace;
    expect(w.receipts[0].date).toBe('2027-06-30');
  });

  it('COL-062 receipt against a fully returned invoice refused (outstanding 0)', () => {
    let { w, cust, inv } = base();
    w = run(w, 'return_document', { id: inv, lines: [{ lineId: docOf(w, inv).lines[0].id, quantity: '100' }] }).workspace;
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '1' }], { amount: '1' }), 'Invalid invoice allocation.');
  });

  it('COL-063 receipt against a partially returned invoice up to the remainder', () => {
    let { w, cust, inv } = base();
    w = run(w, 'return_document', { id: inv, lines: [{ lineId: docOf(w, inv).lines[0].id, quantity: '30' }] }).workspace;
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '7000.01' }], { amount: '7000.01' }), 'Invalid invoice allocation.');
    const r = receipt(w, cust, [{ invoiceId: inv, amount: '7000' }]);
    expect(outstanding(docOf(r.workspace, inv))).toBe('0.0000');
    expectInvariants(r.workspace);
  });

  it('COL-064 credit note then receipt larger than the remainder refused', () => {
    let { w, cust, inv } = base();
    w = receipt(w, cust, [{ invoiceId: inv, amount: '5000' }]).workspace;
    w = run(w, 'return_document', { id: inv, lines: [{ lineId: docOf(w, inv).lines[0].id, quantity: '40' }] }).workspace;
    expect(outstanding(docOf(w, inv))).toBe('1000.0000');
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '1500' }], { amount: '1500' }), 'Invalid invoice allocation.');
  });

  it.todo('COL-065 [browser] receipt dialog on phone: bottom sheet, allocations table scrolls');
  it.todo('COL-066 [browser] cheque fields shown only for method cheque');
  it.todo('COL-067 [browser] account select lists bank and cash accounts, not archived');
  it.todo('COL-068 [browser] amount field empty with placeholder');

  it('COL-069 Collections hidden: records kept, customer receipts refused [documented: with Collections off no customer receipt can be recorded] [browser: Accounting view, attention items gone]', () => {
    const { w: w0, cust, inv } = base();
    const w1 = receipt(w0, cust, [{ invoiceId: inv, amount: '100' }]).workspace;
    const off = run(w1, 'set_modules', { enabled: toggleModules.filter(m => !['collections', 'commissions'].includes(m)) }).workspace;
    expect(off.receipts).toHaveLength(1);
    refused(off, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '100' }], { amount: '100' }), 'Collections & PDCs is turned off for this company. Turn it on in Settings → Features.');
  });

  it.todo('COL-070 [browser] cheque register also visible in Cash & bank with the same data');

  it('COL-071 bounce after commission paid in payroll: recovery recorded; next payroll deducts it', () => {
    let { w, cust, inv, emp } = base();
    w = run(w, 'save_settings', { taxRate: '', employerEobi: '5', employeeEobi: '1', eobiBase: '37000', incomeTaxRate: '0', numbering: 'QA', approvalLimit: '0' }).workspace;
    let id: string; [w, id] = cheque(w, cust, inv, '10000');
    w = chq(deposit(w, id), id, 'cleared').workspace;
    w = run(w, 'approve_commission', { ids: w.commissions.map(c => c.id) }).workspace;
    const pr = run(w, 'create_payroll', { month: '2026-10' });
    w = pr.workspace;
    for (const status of ['reviewed', 'approved', 'paid']) w = run(w, 'update_payroll', { id: pr.recordId, status }).workspace;
    expect(commissionTotals(w, emp).paid).toBe('500.0000');
    w = chq(w, id, 'bounced').workspace;
    expect(commissionTotals(w, emp).recoverable).toBe('500.0000');
    const next = run(w, 'create_payroll', { month: '2026-11' });
    w = next.workspace;
    expect(w.payrolls.find(p => p.id === next.recordId)!.lines.find(l => l.employeeId === emp)!.recovery).toBe('500.0000');
    for (const status of ['reviewed', 'approved', 'paid']) w = run(w, 'update_payroll', { id: next.recordId, status }).workspace;
    expect(w.commissionMovements.filter(m => m.type === 'recovery_recorded').map(m => m.amount)).toEqual(['500.0000']);
    expect(commissionTotals(w, emp).recoverable).toBe('0.0000');
    expectInvariants(w);
  });

  it('COL-072 clearing after a bounce refused (bounced is terminal)', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '1000');
    const w = chq(deposit(w1, id), id, 'bounced').workspace;
    refused(w, 'update_cheque', { id, status: 'cleared' }, 'Invalid cheque transition.');
    refused(w, 'update_cheque', { id, status: 'deposited' }, 'Invalid cheque transition.');
  });

  it('COL-073 two cheques for the same invoice both clear up to the outstanding', () => {
    let { w, cust, inv } = base();
    let a: string, b: string;
    [w, a] = cheque(w, cust, inv, '4000', { chequeNo: 'A-1' });
    [w, b] = cheque(w, cust, inv, '6000', { chequeNo: 'B-1' });
    w = chq(deposit(w, a), a, 'cleared').workspace;
    w = chq(deposit(w, b), b, 'cleared').workspace;
    expect(docOf(w, inv).paid).toBe('10000.0000');
    expect(outstanding(docOf(w, inv))).toBe('0.0000');
    expectInvariants(w);
  });

  it('COL-074 commission release proportional to cash: 50% cash → 50% released', () => {
    const { w: w0, cust, inv } = base();
    const w = receipt(w0, cust, [{ invoiceId: inv, amount: '5000' }]).workspace;
    expect(released(w, inv)).toBe('250.0000');
    expect(commissionTotals(w).earned).toBe('500.0000');
  });

  it.todo('COL-075 [browser] receipts list filters by method/status');
  it.todo('COL-076 [browser] search by cheque number');

  it('COL-077 cheque number with spaces/dashes saved as typed', () => {
    const { w, cust, inv } = base();
    const [w1, id] = cheque(w, cust, inv, '100', { chequeNo: 'HBL 00-123 456' });
    expect(rcOf(w1, id).chequeNo).toBe('HBL 00-123 456');
  });

  it('COL-078 note with emoji saved', () => {
    const { w: w0, cust, inv } = base();
    const r = receipt(w0, cust, [{ invoiceId: inv, amount: '1' }], { note: 'Paid in full 👍' });
    expect(rcOf(r.workspace, r.recordId).note).toBe('Paid in full 👍');
  });

  it('COL-079 deposit without an account id [documented: API accepts it; clearing then posts to 1000 "Bank & cash (legacy)"] [browser: UI select defaults to a bank account]', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '800');
    const w2 = chq(w1, id, 'deposited').workspace;
    expect(rcOf(w2, id).accountId).toBeUndefined();
    const w = chq(w2, id, 'cleared').workspace;
    expect(byAccount(w, `${id}:cleared`)).toEqual({ '1000': '800.0000', '1100': '-800.0000' });
  });

  it('COL-080 deposit into a cash-type account [documented: allowed by the engine; UI lists only bank accounts]', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '800');
    const w = chq(deposit(w1, id, 'cash'), id, 'cleared').workspace;
    expect(accountBalance(w, '1002')).toBe('800.0000');
  });

  it('COL-081 Auditor views receipts read-only', () => {
    const { w: w0, cust, inv } = base();
    const [w, id] = cheque(w0, cust, inv, '800');
    const aud = actor('Auditor');
    expect(scopeWorkspace(w, aud).receipts.map(r => r.id)).toEqual([id]);
    refused(w, 'create_receipt', raw(cust, [{ invoiceId: inv, amount: '1000' }]), 'Your role does not permit this action.', aud);
    refused(w, 'update_cheque', { id, status: 'deposited' }, 'Your role does not permit this action.', aud);
  });

  it('COL-082 receipt dated in an open period against an invoice in a locked period allowed', () => {
    let { w, item, cust } = base();
    let old: string;
    [w, old] = invoice(w, cust, item, '10', { date: '2026-09-10', dueDate: '2026-09-10' });
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    const r = receipt(w, cust, [{ invoiceId: old, amount: '1000' }]);
    expect(outstanding(docOf(r.workspace, old))).toBe('0.0000');
  });

  it('COL-083 one receipt allocated to 10 invoices updates each', () => {
    let { w, item, cust } = base();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) { let id: string; [w, id] = invoice(w, cust, item, String(i + 1)); ids.push(id); }
    const r = receipt(w, cust, ids.map((id, i) => ({ invoiceId: id, amount: String((i + 1) * 100) })));
    expect(ids.map(id => outstanding(docOf(r.workspace, id)))).toEqual(Array(10).fill('0.0000'));
    expect(rcOf(r.workspace, r.recordId).amount).toBe('5500');
    expectInvariants(r.workspace);
  });

  it.todo('COL-084 [browser] 5,000 receipts: list and aging render < 2 s');
  it.todo('COL-085 [browser] attention "Cheques due" count badge on the bell matches');

  it('COL-086 follow-up records the signed-in member as actor', () => {
    const { w: w0, cust } = base();
    const w = run(w0, 'follow_up', { partyId: cust, note: 'Visited', nextDate: '2026-10-30' }, actor('Sales Manager')).workspace;
    expect(w.followUps.at(-1)!.actor).toBe('QA Sales Manager');
  });

  it('COL-087 follow-up on an archived customer [documented: allowed]', () => {
    let { w, cust } = base();
    w = run(w, 'set_archived', { kind: 'party', id: cust, archived: true }).workspace;
    expect(run(w, 'follow_up', { partyId: cust, note: 'Legal notice', nextDate: '2026-10-30' }).workspace.followUps).toHaveLength(1);
  });

  it('COL-088 receipt journal memo contains the receipt number', () => {
    const { w: w0, cust, inv } = base();
    const r = receipt(w0, cust, [{ invoiceId: inv, amount: '10' }]);
    expect(journalOf(r.workspace, `${r.recordId}:cleared`)!.memo).toBe(`Customer receipt · ${rcOf(r.workspace, r.recordId).number}`);
  });

  it("COL-089 journal uses the bank account's own ledger code", () => {
    let { w, cust, inv } = base();
    const acct = run(w, 'save_bank_account', { name: 'Meezan Current', type: 'bank', details: '' });
    w = acct.workspace;
    const code = w.bankAccounts.find(a => a.id === acct.recordId)!.code;
    expect(code).toBe('1003');
    const r = receipt(w, cust, [{ invoiceId: inv, amount: '10' }], { method: 'bank', accountId: acct.recordId });
    expect(byAccount(r.workspace, `${r.recordId}:cleared`)).toEqual({ '1003': '10.0000', '1100': '-10.0000' });
  });

  it.todo('COL-090 [browser] Collections receipt dialog does not offer suppliers (Purchasing → Supplier payments)');

  it('COL-091 clear dated earlier than the deposit [documented: allowed; journal and statement use the clear date]', () => {
    const { w: w0, cust, inv } = base();
    const [w1, id] = cheque(w0, cust, inv, '800', { date: '2026-10-01' });
    const w2 = chq(w1, id, 'deposited', { accountId: 'main-bank', date: '2026-10-10' }).workspace;
    const w = chq(w2, id, 'cleared', { date: '2026-10-05' }).workspace;
    expect(journalOf(w, `${id}:cleared`)!.date).toBe('2026-10-05');
    expect(partyStatement(w, cust, '2000-01-01', '2999-12-31').lines.find(l => l.reference === rcOf(w, id).number)!.date).toBe('2026-10-05');
  });

  it('COL-092 20 cheques cleared one by one, each independent', () => {
    let { w, cust, inv } = base();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) { let id: string; [w, id] = cheque(w, cust, inv, '100', { chequeNo: `C-${i}` }); ids.push(id); }
    for (const [i, id] of ids.entries()) {
      w = chq(deposit(w, id), id, 'cleared').workspace;
      expect(docOf(w, inv).paid).toBe(D(100).mul(i + 1).toFixed(4));
    }
    expect(w.receipts.every(r => r.status === 'cleared')).toBe(true);
    expect(new Set(ids.map(id => journalOf(w, `${id}:cleared`)!.id)).size).toBe(20);
    expectInvariants(w);
  });

  it.todo('COL-093 [browser] status badge colours: received amber, deposited info, cleared green, bounced red');
  it.todo('COL-094 [browser] receipt row actions show only valid transitions');

  it('COL-095 cheque receipt print before clearing shows status received', () => {
    const { w: w0, cust, inv } = base();
    const [w, id] = cheque(w0, cust, inv, '800', { chequeNo: 'UBL-55' });
    const view = receiptView(w, rcOf(w, id));
    expect(view.status).toBe('received');
    expect(view.meta).toEqual([{ label: 'Method', value: 'Cheque UBL-55' }, { label: 'Status', value: 'received' }, { label: 'Cheque date', value: today() }]);
  });

  it('COL-096 Recovery Officer sees only sales documents and customer receipts', () => {
    let { w, item, cust, inv } = base();
    let sup: string; [w, sup] = withParty(w, 'supplier');
    const b = run(w, 'create_document', { kind: 'supplier_invoice', partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '10', '50')] });
    w = run(b.workspace, 'submit_document', { id: b.recordId }).workspace;
    w = run(w, 'create_receipt', { partyId: sup, date: today(), amount: '500', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: b.recordId, amount: '500' }], employeeId: '', note: '', accountId: 'main-bank' }).workspace;
    const cr = receipt(w, cust, [{ invoiceId: inv, amount: '100' }]);
    const scoped = scopeWorkspace(cr.workspace, actor('Recovery Officer'));
    expect(scoped.documents.map(d => d.kind)).toEqual(['sales_invoice']);
    expect(scoped.receipts.map(r => r.id)).toEqual([cr.recordId]);
    expect(scoped.journals).toEqual([]);
  });

  it('COL-097 customer with no open invoices cannot save a receipt [browser: "No open invoices" state]', () => {
    let { w } = base();
    let fresh: string; [w, fresh] = withParty(w, 'customer');
    refused(w, 'create_receipt', raw(fresh, []), /expected array to have >=1 items/);
  });

  it('COL-098 outstanding = total − paid − returned on 5 invoices', () => {
    let { w, item, cust } = base();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) { let id: string; [w, id] = invoice(w, cust, item, String(i * 2), {}, { taxRate: '18' }); ids.push(id); }
    w = receipt(w, cust, [{ invoiceId: ids[0], amount: '100' }, { invoiceId: ids[2], amount: '236' }]).workspace;
    w = run(w, 'return_document', { id: ids[1], lines: [{ lineId: docOf(w, ids[1]).lines[0].id, quantity: '1' }] }).workspace;
    w = run(w, 'return_document', { id: ids[4], lines: [{ lineId: docOf(w, ids[4]).lines[0].id, quantity: '10' }] }).workspace;
    for (const id of ids) { const d = docOf(w, id); expect(outstanding(d)).toBe(D(d.total).minus(d.paid).minus(d.returned).toFixed(4)); }
    expect(ids.map(id => outstanding(docOf(w, id)))).toEqual(['136.0000', '354.0000', '472.0000', '944.0000', '0.0000']);
  });

  it('COL-099 trial balance balanced after a bounce sequence', () => {
    let { w, cust, inv } = base();
    let a: string, b: string;
    [w, a] = cheque(w, cust, inv, '3000', { chequeNo: 'A' });
    [w, b] = cheque(w, cust, inv, '2000', { chequeNo: 'B' });
    w = chq(chq(deposit(w, a), a, 'cleared').workspace, a, 'bounced').workspace;
    w = chq(deposit(w, b), b, 'bounced').workspace;
    const tb = trialBalance(w, '2999-12-31');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(docOf(w, inv).paid).toBe('0.0000');
    expectInvariants(w);
  });

  it('COL-100 end to end: 10,000 invoice → cash 4,000 → cheque 6,000 deposit/clear/bounce → cash 6,000; statement and commission correct', () => {
    let { w, cust, inv, emp } = base();
    w = receipt(w, cust, [{ invoiceId: inv, amount: '4000' }]).workspace;
    expect(released(w, inv)).toBe('200.0000');
    let id: string; [w, id] = cheque(w, cust, inv, '6000', { chequeNo: 'BAH-600' });
    w = chq(deposit(w, id), id, 'cleared').workspace;
    expect(released(w, inv)).toBe('500.0000');
    w = chq(w, id, 'bounced').workspace;
    expect(released(w, inv)).toBe('200.0000');
    expect(outstanding(docOf(w, inv))).toBe('6000.0000');
    w = receipt(w, cust, [{ invoiceId: inv, amount: '6000' }]).workspace;
    expect(outstanding(docOf(w, inv))).toBe('0.0000');
    expect(commissionTotals(w, emp)).toMatchObject({ earned: '500.0000', released: '500.0000', paid: '0.0000' });
    const st = partyStatement(w, cust, '2000-01-01', '2999-12-31');
    expect(st.lines.map(l => [l.description, l.debit, l.credit])).toEqual([['Sales invoice', '10000.0000', ''], ['Receipt · cash', '', '4000.0000'], ['Receipt · cash', '', '6000.0000']]);
    expect(st.closing).toBe('0.0000');
    expect(summary(w).collections).toBe('10000.0000');
    expectInvariants(w);
  });
});
