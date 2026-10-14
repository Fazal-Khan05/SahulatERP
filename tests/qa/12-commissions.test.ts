import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commissionTotals } from '../../src/modules/erp/engine';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { moduleRecordCounts } from '../../src/modules/erp/modules';
import { salesAnalysis } from '../../src/modules/erp/reports';
import { employees as employeeSpec } from '../../src/modules/erp/master-data';
import type { Actor, CommissionPlan, Workspace } from '../../src/modules/erp/types';
import { accountBalance, actor, D, expectInvariants, freshCompany, money, outstanding, refused, run, sum, today, withDocument, withItem, withParty } from './helpers';

const T = today();
const MONTH = T.slice(0, 7);
const YEAR = T.slice(0, 4);
const nextMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const M2 = nextMonth(MONTH);
const employee = (name: string, extra: Record<string, unknown> = {}) => ({ name, role: 'Order Booker', territory: 'Karachi', salary: '45000', allowance: '5000', deduction: '0', attendance: 30, active: true, ...extra });
const payrollSettings = { taxRate: '', employerEobi: '5', employeeEobi: '1', eobiBase: '32000', incomeTaxRate: '5', numbering: 'QA', approvalLimit: '0' };

type Ctx = { w: Workspace; emp: string; emp2: string; item: string; item2: string; cust: string };
/** Fresh company with the provisioned plan edited to `plan`, two salespeople, two products (Lighting, Home) and a Retailer customer. */
function setup(plan: Partial<CommissionPlan> & Record<string, unknown> = {}, modules?: Parameters<typeof freshCompany>[0]): Ctx {
  let w = freshCompany(modules);
  if (w.plans.length) w = run(w, 'save_plan', { ...w.plans[0], rate: '2', ...plan }).workspace;
  w = run(w, 'save_settings', payrollSettings).workspace;
  const e1 = run(w, 'save_employee', employee('Hamza Khan')); w = e1.workspace;
  const e2 = run(w, 'save_employee', employee('Sara Malik', { role: 'Area Sales Manager' })); w = e2.workspace;
  let item: string, item2: string, cust: string;
  [w, item] = withItem(w, { category: 'Lighting' }, { quantity: '100000', cost: '50' });
  [w, item2] = withItem(w, { category: 'Home' }, { quantity: '100000', cost: '50' });
  [w, cust] = withParty(w, 'customer', { customerClass: 'Retailer' });
  return { w, emp: e1.recordId, emp2: e2.recordId, item, item2, cust };
}
/** Submitted invoice; default 100 × 100 = 10,000 net, no tax. */
function invoice(c: Ctx, w: Workspace, line: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, party = c.cust): [Workspace, string] {
  return withDocument(w, 'sales_invoice', party, [{ itemId: c.item, quantity: '100', price: '100', employeeId: c.emp, ...line }], extra);
}
const pay = (w: Workspace, party: string, inv: string, amount: string, method: 'cash' | 'bank' = 'cash', date = T) =>
  run(w, 'create_receipt', { partyId: party, date, amount, method, dueDate: date, allocations: [{ invoiceId: inv, amount }], accountId: method === 'cash' ? 'cash' : 'main-bank' }).workspace;
function cheque(w: Workspace, party: string, inv: string, amount: string, to: 'received' | 'deposited' | 'cleared' = 'cleared'): [Workspace, string] {
  const r = run(w, 'create_receipt', { partyId: party, date: T, amount, method: 'cheque', chequeNo: 'CHQ-77', dueDate: T, allocations: [{ invoiceId: inv, amount }] });
  let next = r.workspace;
  if (to !== 'received') next = run(next, 'update_cheque', { id: r.recordId, status: 'deposited', date: T, accountId: 'main-bank' }).workspace;
  if (to === 'cleared') next = run(next, 'update_cheque', { id: r.recordId, status: 'cleared', date: T }).workspace;
  return [next, r.recordId];
}
const com = (w: Workspace, inv: string, emp?: string) => w.commissions.find(c => c.invoiceId === inv && (!emp || c.employeeId === emp))!;
const moves = (w: Workspace, id: string) => w.commissionMovements.filter(m => m.commissionId === id).map(m => [m.type, m.amount]);
const approveAll = (w: Workspace) => { const ids = w.commissions.filter(c => D(c.released).gt(c.paid) && !c.approved).map(c => c.id); return ids.length ? run(w, 'approve_commission', { ids }).workspace : w; };
/** Creates and pays a payroll run for `month`; returns [w, runId]. */
function payroll(w: Workspace, month: string, steps: ('reviewed' | 'approved' | 'paid')[] = ['reviewed', 'approved', 'paid']): [Workspace, string] {
  const r = run(w, 'create_payroll', { month });
  let next = r.workspace;
  for (const s of steps) next = run(next, 'update_payroll', { id: r.recordId, status: s }).workspace;
  return [next, r.recordId];
}
const source = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8');
const sp = (employeeId: string): Actor => actor('Salesperson', { employeeId });

describe('12 Commissions (COM)', () => {
  it('COM-001 new employee "Hamza, Order Booker" is saved and active [browser: appears in invoice salesperson select]', () => {
    const w = freshCompany();
    const r = run(w, 'save_employee', employee('Hamza', { role: 'Order Booker' }));
    expect(r.workspace.employees).toEqual([{ id: r.recordId, ...employee('Hamza', { role: 'Order Booker' }) }]);
    expect(r.message).toBe('Changes saved.');
  });

  it('COM-002 edit the provisioned "Standard plan" to flat 2%', () => {
    const w = freshCompany();
    expect(w.plans).toHaveLength(1);
    expect(w.plans[0]).toMatchObject({ name: 'Standard plan (edit me)', type: 'flat', rate: '0', effectiveFrom: `${YEAR}-01-01`, effectiveTo: '2099-12-31' });
    const next = run(w, 'save_plan', { ...w.plans[0], name: 'Standard plan', rate: '2' }).workspace;
    expect(next.plans).toHaveLength(1);
    expect(next.plans[0]).toMatchObject({ id: w.plans[0].id, name: 'Standard plan', rate: '2' });
  });

  it('COM-003 effectiveTo before effectiveFrom is refused', () => {
    const w = freshCompany();
    refused(w, 'save_plan', { ...w.plans[0], effectiveFrom: '2026-06-01', effectiveTo: '2026-05-31' }, 'Plan dates are invalid.');
  });

  it('COM-004 a second plan overlapping dates is refused', () => {
    const w = freshCompany();
    const { id: _id, ...plan } = w.plans[0];
    refused(w, 'save_plan', { ...plan, name: 'Overlap', effectiveFrom: '2030-01-01', effectiveTo: '2030-12-31' }, 'Commission plan dates overlap.');
  });

  it('COM-005 adjacent plans (to 2026-12-31, next from 2027-01-01) are allowed', () => {
    let w = freshCompany();
    w = run(w, 'save_plan', { ...w.plans[0], effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' }).workspace;
    const { id: _id, ...plan } = w.plans[0];
    w = run(w, 'save_plan', { ...plan, name: '2027 plan', effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31' }).workspace;
    expect(w.plans.map(p => [p.effectiveFrom, p.effectiveTo])).toEqual([['2026-01-01', '2026-12-31'], ['2027-01-01', '2027-12-31']]);
  });

  it('COM-006 plan name of 1 character is refused', () => {
    const w = freshCompany();
    refused(w, 'save_plan', { ...w.plans[0], name: 'P' }, /too_small/);
  });

  it('COM-007 rate −1 is refused', () => {
    const w = freshCompany();
    refused(w, 'save_plan', { ...w.plans[0], rate: '-1' }, 'Amount cannot be negative.');
  });

  it('COM-008 category rate 101 is refused', () => {
    const w = freshCompany();
    refused(w, 'save_plan', { ...w.plans[0], type: 'category', categoryRates: { Lighting: '101' } }, 'Percentage cannot exceed 100.');
  });

  it('COM-009 empty tiers fail validation (min 1)', () => {
    const w = freshCompany();
    refused(w, 'save_plan', { ...w.plans[0], tiers: [] }, /too_small/);
  });

  it('COM-010 multiplier 0 is refused', () => {
    const w = freshCompany();
    refused(w, 'save_plan', { ...w.plans[0], multiplier: '0' }, 'Amount must be greater than zero.');
  });

  it('COM-011 category plan: Lighting earns 2.5%, other categories earn the base rate [documented: unlisted categories fall back to the plan rate]', () => {
    const c = setup({ type: 'category', rate: '1', categoryRates: { Lighting: '2.5' } });
    const [w, inv] = withDocument(c.w, 'sales_invoice', c.cust, [{ itemId: c.item, quantity: '100', price: '100', employeeId: c.emp }, { itemId: c.item2, quantity: '100', price: '100', employeeId: c.emp }]);
    expect(w.commissions.filter(x => x.invoiceId === inv).map(x => x.earned)).toEqual(['250.0000', '100.0000']);
  });

  it('COM-012 customer-class plan: Wholesaler 1%, other classes at the base rate, frozen at submit', () => {
    let c = setup({ type: 'customer_class', rate: '3', classRates: { Wholesaler: '1' } });
    let wholesaler: string, w = c.w;
    [w, wholesaler] = withParty(w, 'customer', { customerClass: 'Wholesaler' });
    let a: string, b: string;
    [w, a] = invoice(c, w, {}, {}, wholesaler);
    [w, b] = invoice(c, w);
    expect([com(w, a).earned, com(w, b).earned]).toEqual(['100.0000', '300.0000']);
    const party = w.parties.find(p => p.id === wholesaler)!;
    w = run(w, 'save_party', { ...party, customerClass: 'Retailer' }).workspace;
    expect(com(w, a).earned).toBe('100.0000');
  });

  it('COM-013 per-unit plan rate 10: earned = qty × 10', () => {
    const c = setup({ type: 'per_unit', rate: '10' });
    const [w, inv] = invoice(c, c.w, { quantity: '7' });
    expect(com(w, inv).earned).toBe('70.0000');
  });

  it('COM-014 tiered plan 0 = 2%, 500,000 = 3% [documented: marginal tiers on each line\'s own net base, not cumulative across invoices]', () => {
    const c = setup({ type: 'tiered', tiers: [{ threshold: '0', rate: '2' }, { threshold: '500000', rate: '3' }] });
    let w = c.w, a: string, b: string;
    [w, a] = invoice(c, w, { quantity: '6000', price: '100' });
    [w, b] = invoice(c, w, { quantity: '1000', price: '100' });
    expect(com(w, a).earned).toBe('13000.0000');
    expect(com(w, b).earned).toBe('2000.0000');
  });

  it('COM-015 target 15,000 with multiplier 2 [documented: once the salesperson\'s month-to-date base incl. this line reaches the target, that line\'s commission is multiplied]', () => {
    const c = setup({ target: '15000', multiplier: '2' });
    let w = c.w, a: string, b: string, d: string;
    [w, a] = invoice(c, w);
    [w, b] = invoice(c, w);
    [w, d] = invoice(c, w);
    expect([com(w, a).earned, com(w, b).earned, com(w, d).earned]).toEqual(['200.0000', '400.0000', '400.0000']);
  });

  it('COM-016 invoice 10,000 net with Hamza on flat 2%: earned 200, released 0', () => {
    const c = setup();
    const [w, inv] = invoice(c, c.w);
    expect(com(w, inv)).toMatchObject({ employeeId: c.emp, eligibleBase: '10000.0000', earned: '200.0000', released: '0.0000', paid: '0.0000', approved: false });
    expectInvariants(w);
  });

  it('COM-017 cash receipt of 5,000 releases 100', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = pay(w, c.cust, inv, '5000');
    expect(com(w, inv).released).toBe('100.0000');
    expect(moves(w, com(w, inv).id)).toEqual([['accrued', '200.0000'], ['released', '100.0000']]);
  });

  it('COM-018 then a cleared cheque of 5,000 releases the full 200', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = pay(w, c.cust, inv, '5000');
    [w] = cheque(w, c.cust, inv, '5000');
    expect(com(w, inv).released).toBe('200.0000');
    expectInvariants(w);
  });

  it('COM-019 a cheque only deposited releases nothing', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    [w] = cheque(w, c.cust, inv, '10000', 'deposited');
    expect(com(w, inv).released).toBe('0.0000');
  });

  it('COM-020 cheque bounced after clearing reverses the release (release_reversed movement)', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w); let chq: string;
    [w, chq] = cheque(w, c.cust, inv, '10000');
    w = run(w, 'update_cheque', { id: chq, status: 'bounced', date: T }).workspace;
    expect(com(w, inv).released).toBe('0.0000');
    expect(moves(w, com(w, inv).id)).toEqual([['accrued', '200.0000'], ['released', '200.0000'], ['release_reversed', '200.0000']]);
    expectInvariants(w);
  });

  it('COM-021 bounce after payroll paid: paid > released, recovery deducted in the next payroll', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w); let chq: string;
    [w, chq] = cheque(w, c.cust, inv, '10000');
    w = approveAll(w);
    [w] = payroll(w, MONTH);
    expect(com(w, inv).paid).toBe('200.0000');
    w = run(w, 'update_cheque', { id: chq, status: 'bounced', date: T }).workspace;
    expect(com(w, inv)).toMatchObject({ released: '0.0000', paid: '200.0000' });
    expect(commissionTotals(w).recoverable).toBe('200.0000');
    const [w2, run2] = payroll(w, M2);
    const line = w2.payrolls.find(p => p.id === run2)!.lines.find(l => l.employeeId === c.emp)!;
    expect(line.recovery).toBe('200.0000');
    expect(com(w2, inv).paid).toBe('0.0000');
    expect(moves(w2, com(w2, inv).id).at(-1)).toEqual(['recovery_recorded', '200.0000']);
    expectInvariants(w2);
  });

  it('COM-022 approving a released entitlement sets approved', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = pay(w, c.cust, inv, '5000');
    const r = run(w, 'approve_commission', { ids: [com(w, inv).id] });
    expect(r.message).toBe('Commission approved for payroll.');
    expect(com(r.workspace, inv).approved).toBe(true);
  });

  it('COM-023 approving with nothing released is refused', () => {
    const c = setup();
    const [w, inv] = invoice(c, c.w);
    refused(w, 'approve_commission', { ids: [com(w, inv).id] }, 'There is no released unpaid commission to approve.');
  });

  it('COM-024 approving an already fully paid entitlement is refused', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = approveAll(pay(w, c.cust, inv, '10000'));
    [w] = payroll(w, MONTH);
    expect(com(w, inv).paid).toBe('200.0000');
    refused(w, 'approve_commission', { ids: [com(w, inv).id] }, 'There is no released unpaid commission to approve.');
  });

  it('COM-025 approving several ids approves all of them', () => {
    const c = setup();
    let w = c.w, a: string, b: string;
    [w, a] = invoice(c, w);
    [w, b] = invoice(c, w, { employeeId: c.emp2 });
    w = pay(pay(w, c.cust, a, '1000'), c.cust, b, '2000');
    w = run(w, 'approve_commission', { ids: [com(w, a).id, com(w, b).id] }).workspace;
    expect([com(w, a).approved, com(w, b).approved]).toEqual([true, true]);
  });

  it('COM-026 approving an empty id list fails validation', () => {
    refused(setup().w, 'approve_commission', { ids: [] }, /too_small/);
  });

  it('COM-027 a branch-limited approver cannot approve an invoice from another branch', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = run(w, 'save_branch', { name: 'Lahore' }).workspace;
    w = pay(w, c.cust, inv, '5000');
    refused(w, 'approve_commission', { ids: [com(w, inv).id] }, 'This warehouse is outside your permitted branches.', actor('Sales Manager', { branchIds: ['lahore'] }));
  });

  it('COM-028 earned ≥ released ≥ 0 holds throughout; paid ≤ released except while a bounce awaits recovery [case-corrected: paid may exceed released after a bounce until payroll recovers it]', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w); let chq: string;
    const check = (allowRecoverable = false) => { for (const x of w.commissions) { expect(D(x.earned).gte(x.released)).toBe(true); expect(D(x.released).gte(0)).toBe(true); if (!allowRecoverable) expect(D(x.paid).lte(x.released)).toBe(true); } expectInvariants(w); };
    check();
    w = pay(w, c.cust, inv, '3000'); check();
    [w, chq] = cheque(w, c.cust, inv, '7000'); check();
    w = approveAll(w); [w] = payroll(w, MONTH); check();
    w = run(w, 'update_cheque', { id: chq, status: 'bounced', date: T }).workspace; check(true);
    expect(D(com(w, inv).paid).gt(com(w, inv).released)).toBe(true);
    [w] = payroll(w, M2); check();
  });

  it('COM-029 plan snapshot is stored; editing the plan later does not change earned', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = run(w, 'save_plan', { ...w.plans[0], rate: '9' }).workspace;
    expect(com(w, inv).earned).toBe('200.0000');
    expect(com(w, inv).planSnapshot.rate).toBe('2');
    expect(w.plans[0].rate).toBe('9');
  });

  it('COM-030 one movement per event: accrued, released, release_reversed, paid, recovery_recorded', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w); let chq: string;
    [w, chq] = cheque(w, c.cust, inv, '10000');
    w = approveAll(w); [w] = payroll(w, MONTH);
    w = run(w, 'update_cheque', { id: chq, status: 'bounced', date: T }).workspace;
    [w] = payroll(w, M2);
    expect(moves(w, com(w, inv).id)).toEqual([['accrued', '200.0000'], ['released', '200.0000'], ['paid', '200.0000'], ['release_reversed', '200.0000'], ['recovery_recorded', '200.0000']]);
    expect(new Set(w.commissionMovements.map(m => m.id)).size).toBe(w.commissionMovements.length);
  });

  it('COM-031 invoice with no salesperson creates no entitlement and no commission journal', () => {
    const c = setup();
    const [w, inv] = invoice(c, c.w, { employeeId: '' });
    expect(w.commissions.filter(x => x.invoiceId === inv)).toEqual([]);
    expect(w.journals.some(j => j.sourceId === `${inv}:commission`)).toBe(false);
  });

  it('COM-032 a line split 60/40 creates two entitlements by share', () => {
    const c = setup();
    const [w, inv] = invoice(c, c.w, { employeeId: '', splits: [{ employeeId: c.emp, share: '60' }, { employeeId: c.emp2, share: '40' }] });
    expect([com(w, inv, c.emp), com(w, inv, c.emp2)].map(x => [x.eligibleBase, x.earned])).toEqual([['6000.0000', '120.0000'], ['4000.0000', '80.0000']]);
    expectInvariants(w);
  });

  it('COM-033 splits totalling 90 are refused', () => {
    const c = setup();
    refused(c.w, 'create_document', { kind: 'sales_invoice', partyId: c.cust, warehouseId: c.w.warehouses[0].id, date: T, dueDate: T, lines: [{ itemId: c.item, quantity: '1', price: '1', discount: '0', taxRate: '0', employeeId: '', splits: [{ employeeId: c.emp, share: '50' }, { employeeId: c.emp2, share: '40' }] }] }, 'Commission splits must total 100%.');
  });

  it('COM-034 a split with an unknown employee is refused', () => {
    const c = setup();
    refused(c.w, 'create_document', { kind: 'sales_invoice', partyId: c.cust, warehouseId: c.w.warehouses[0].id, date: T, dueDate: T, lines: [{ itemId: c.item, quantity: '1', price: '1', discount: '0', taxRate: '0', employeeId: '', splits: [{ employeeId: c.emp, share: '50' }, { employeeId: 'ghost', share: '50' }] }] }, 'Employee not found.');
  });

  it('COM-035 a credit note on a commissioned invoice adjusts the entitlement proportionally', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    const lineId = w.documents.find(d => d.id === inv)!.lines[0].id;
    w = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId, quantity: '50' }] }).workspace;
    expect(com(w, inv).earned).toBe('100.0000');
    expect(moves(w, com(w, inv).id).at(-1)).toEqual(['entitlement_adjusted', '-100.0000']);
    expect(accountBalance(w, '5100')).toBe('100.0000');
    expectInvariants(w);
  });

  it('COM-036 a return after release caps released at the new earned with a movement', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = pay(w, c.cust, inv, '10000');
    const lineId = w.documents.find(d => d.id === inv)!.lines[0].id;
    w = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId, quantity: '50' }] }).workspace;
    expect(com(w, inv)).toMatchObject({ earned: '100.0000', released: '100.0000' });
    expect(moves(w, com(w, inv).id).slice(-2)).toEqual([['entitlement_adjusted', '-100.0000'], ['release_reversed', '100.0000']]);
    expectInvariants(w);
  });

  it('COM-037 a return after payment leaves an amount to recover in the next payroll', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = approveAll(pay(w, c.cust, inv, '10000'));
    [w] = payroll(w, MONTH);
    const lineId = w.documents.find(d => d.id === inv)!.lines[0].id;
    w = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId, quantity: '50' }] }).workspace;
    expect(com(w, inv)).toMatchObject({ earned: '100.0000', released: '100.0000', paid: '200.0000' });
    const [w2, r2] = payroll(w, M2);
    expect(w2.payrolls.find(p => p.id === r2)!.lines.find(l => l.employeeId === c.emp)!.recovery).toBe('100.0000');
    expect(com(w2, inv).paid).toBe('100.0000');
    expectInvariants(w2);
  });

  it('COM-038 discounted line: base is net after discount, before tax', () => {
    const c = setup();
    const [w, inv] = invoice(c, c.w, { discount: '10' });
    expect(com(w, inv)).toMatchObject({ eligibleBase: '9000.0000', earned: '180.0000' });
  });

  it('COM-039 tax is excluded from the base', () => {
    const c = setup();
    const [w, inv] = invoice(c, c.w, { taxRate: '18' });
    expect(w.documents.find(d => d.id === inv)!.total).toBe('11800.0000');
    expect(com(w, inv)).toMatchObject({ eligibleBase: '10000.0000', earned: '200.0000' });
  });

  it('COM-040 entitlement records carry earned / released / paid / approved [browser: list columns]', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = approveAll(pay(w, c.cust, inv, '5000'));
    expect(com(w, inv)).toMatchObject({ earned: '200.0000', released: '100.0000', paid: '0.0000', approved: true });
  });

  it('COM-041 totals filtered by salesperson [browser: list filter control]', () => {
    const c = setup();
    let w = c.w;
    [w] = invoice(c, w);
    [w] = invoice(c, w, { employeeId: c.emp2, quantity: '50' });
    expect(commissionTotals(w, c.emp).earned).toBe('200.0000');
    expect(commissionTotals(w, c.emp2).earned).toBe('100.0000');
    expect(commissionTotals(w).earned).toBe('300.0000');
  });

  it('COM-042 entitlement links to its invoice [browser: opens details]', () => {
    const c = setup();
    const [w, inv] = invoice(c, c.w);
    const doc = w.documents.find(d => d.id === com(w, inv).invoiceId)!;
    expect(doc.kind).toBe('sales_invoice');
    expect(doc.lines.map(l => l.id)).toContain(com(w, inv).lineId);
  });

  it('COM-043 Salesperson sees only own entitlements', () => {
    const c = setup();
    let w = c.w;
    [w] = invoice(c, w);
    [w] = invoice(c, w, { employeeId: c.emp2 });
    const view = scopeWorkspace(w, sp(c.emp));
    expect(view.commissions.map(x => x.employeeId)).toEqual([c.emp]);
    expect(view.commissionMovements.every(m => view.commissions.some(x => x.id === m.commissionId))).toBe(true);
  });

  it('COM-044 Sales Manager sees all entitlements; employee salaries are zeroed', () => {
    const c = setup();
    let w = c.w;
    [w] = invoice(c, w);
    [w] = invoice(c, w, { employeeId: c.emp2 });
    const view = scopeWorkspace(w, actor('Sales Manager'));
    expect(view.commissions).toHaveLength(2);
    expect(view.employees.map(e => [e.salary, e.allowance, e.deduction, e.attendance])).toEqual([['0', '0', '0', 0], ['0', '0', '0', 0]]);
  });

  it('COM-045 Payroll Administrator sees entitlements', () => {
    const c = setup();
    const [w] = invoice(c, c.w);
    const view = scopeWorkspace(w, actor('Payroll Administrator'));
    expect(view.commissions).toHaveLength(1);
    expect(view.employees[0].salary).toBe('45000');
  });

  it('COM-046 Recovery Officer receives no commission data [browser: Commissions hidden from nav]', () => {
    const c = setup();
    const [w] = invoice(c, c.w);
    const view = scopeWorkspace(w, actor('Recovery Officer'));
    expect(view.commissions).toEqual([]);
    expect(view.plans).toEqual([]);
    expect(view.employees).toEqual([]);
  });

  it('COM-047 Salesperson cannot approve commission', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = pay(w, c.cust, inv, '5000');
    refused(w, 'approve_commission', { ids: [com(w, inv).id] }, 'Your role does not permit this action.', sp(c.emp));
  });

  it('COM-048 employee hierarchy: Reports to is saved', () => {
    const c = setup();
    const w = run(c.w, 'save_employee', { ...c.w.employees.find(e => e.id === c.emp), parentId: c.emp2 }).workspace;
    expect(w.employees.find(e => e.id === c.emp)!.parentId).toBe(c.emp2);
  });

  it('COM-049 hierarchy cycle A → B → A is refused', () => {
    const c = setup();
    const w = run(c.w, 'save_employee', { ...c.w.employees.find(e => e.id === c.emp2), parentId: c.emp }).workspace;
    refused(w, 'save_employee', { ...w.employees.find(e => e.id === c.emp), parentId: c.emp2 }, 'The sales hierarchy cannot contain a cycle.');
  });

  it('COM-050 employee as their own manager is refused as a cycle', () => {
    const c = setup();
    refused(c.w, 'save_employee', { ...c.w.employees.find(e => e.id === c.emp), parentId: c.emp }, 'The sales hierarchy cannot contain a cycle.');
  });

  it('COM-051 deactivating an employee keeps their history [browser: hidden from invoice select]', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = run(w, 'save_employee', { ...w.employees.find(e => e.id === c.emp), active: false }).workspace;
    expect(w.employees.find(e => e.id === c.emp)!.active).toBe(false);
    expect(com(w, inv).earned).toBe('200.0000');
  });

  it('COM-052 invoice for an inactive employee via API [documented: allowed; commission accrues]', () => {
    const c = setup();
    const w0 = run(c.w, 'save_employee', { ...c.w.employees.find(e => e.id === c.emp), active: false }).workspace;
    const [w, inv] = invoice(c, w0);
    expect(com(w, inv).earned).toBe('200.0000');
  });

  it('COM-053 employee CSV import creates employees and links the manager by name', () => {
    const w0 = freshCompany();
    const r = run(w0, 'import_records', { kind: 'employees', rows: [{ name: 'Ahmed Raza', role: 'RSM', salary: '150000' }, { name: 'Hamza Khan', role: 'Order Booker', manager: 'Ahmed Raza', salary: '45000' }] });
    expect(r.message).toBe('Imported 2 employees: 2 created, 0 updated.');
    const [ahmed, hamza] = r.workspace.employees;
    expect(hamza).toMatchObject({ name: 'Hamza Khan', parentId: ahmed.id, salary: '45000', attendance: 30, active: true });
  });

  it('COM-054 import with an unknown manager name is refused', () => {
    refused(freshCompany(), 'import_records', { kind: 'employees', rows: [{ name: 'Hamza Khan', manager: 'Nobody' }] }, 'Row 2: manager Nobody not found');
  });

  it('COM-055 duplicate employee in the file [case-corrected: message is "Hamza Khan appears more than once in the file" without the word "employee"]', () => {
    const text = refused(freshCompany(), 'import_records', { kind: 'employees', rows: [{ name: 'Hamza Khan' }, { name: 'hamza khan' }] }, 'Row 3: hamza khan appears more than once in the file');
    expect(text).toMatch(/^Nothing was imported/);
  });

  it('COM-056 importing an existing employee in create mode is refused', () => {
    const c = setup();
    refused(c.w, 'import_records', { kind: 'employees', rows: [{ name: 'Hamza Khan' }] }, 'Row 2: employee Hamza Khan already exists');
  });

  it('COM-057 employee export includes salary columns; non-pay roles receive salaries zeroed by projection [documented: export columns are the same for all roles, values come from the projection]', () => {
    const keys = employeeSpec.fields.map(f => f.key);
    expect(keys).toEqual(expect.arrayContaining(['salary', 'allowance', 'deduction', 'attendance']));
    const c = setup();
    expect(scopeWorkspace(c.w, actor('Sales Manager')).employees.every(e => e.salary === '0')).toBe(true);
    expect(scopeWorkspace(c.w, actor('Payroll Administrator')).employees.map(e => e.salary)).toEqual(['45000', '45000']);
  });

  it('COM-058 employee name 100 characters accepted; 101 refused', () => {
    const w = freshCompany();
    expect(run(w, 'save_employee', employee('E'.repeat(100))).workspace.employees[0].name).toHaveLength(100);
    refused(w, 'save_employee', employee('E'.repeat(101)), /too_big/);
  });

  it('COM-059 attendance 31 is refused (max 30)', () => {
    refused(freshCompany(), 'save_employee', employee('Hamza', { attendance: 31 }), /too_big/);
  });

  it('COM-060 negative salary is refused', () => {
    refused(freshCompany(), 'save_employee', employee('Hamza', { salary: '-1' }), 'Amount cannot be negative.');
  });

  it('COM-061 Collections cannot be hidden while Commissions is on [documented: refused, so cash releases always have a collections path]', () => {
    const w = freshCompany();
    refused(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'collections') }, 'Commissions cannot stay on without Collections & PDCs.');
  });

  it('COM-062 with Commissions hidden, submitting an invoice still accrues under the existing plan [documented: accrual is not gated by the module]', () => {
    const c = setup();
    const w0 = run(c.w, 'set_modules', { enabled: c.w.modules.filter(m => m !== 'commissions') }).workspace;
    const [w, inv] = invoice(c, w0);
    expect(com(w, inv).earned).toBe('200.0000');
    expect(accountBalance(w, '2200')).toBe('-200.0000');
  });

  it('COM-063 turning Commissions on later does not accrue past invoices retroactively', () => {
    const c = setup({}, ['sales', 'purchasing', 'inventory', 'collections', 'cashbank', 'payroll', 'reports']);
    expect(c.w.plans).toEqual([]);
    let [w, inv] = invoice(c, c.w);
    expect(w.commissions).toEqual([]);
    w = run(w, 'set_modules', { enabled: [...w.modules, 'commissions'] }).workspace;
    expect(w.plans).toHaveLength(1);
    expect(w.commissions.filter(x => x.invoiceId === inv)).toEqual([]);
  });

  it('COM-064 reconciliation: commission expense = sum earned; payable = earned − paid', () => {
    const c = setup();
    let w = c.w, a: string, b: string;
    [w, a] = invoice(c, w);
    [w, b] = invoice(c, w, { employeeId: c.emp2, quantity: '30' });
    w = approveAll(pay(w, c.cust, a, '10000'));
    [w] = payroll(w, MONTH);
    const lineId = w.documents.find(d => d.id === b)!.lines[0].id;
    w = run(w, 'return_document', { id: b, date: T, lines: [{ lineId, quantity: '10' }] }).workspace;
    const t = commissionTotals(w);
    expect(accountBalance(w, '5100')).toBe(t.earned);
    expect(money(D(accountBalance(w, '2200')).negated())).toBe(money(D(t.earned).minus(t.paid)));
    expect([t.earned, t.paid]).toEqual(['240.0000', '200.0000']);
    expectInvariants(w);
  });

  it('COM-065 accrual journal at submit: Dr 5100 / Cr 2200', () => {
    const c = setup();
    const [w, inv] = invoice(c, c.w);
    const j = w.journals.find(x => x.sourceId === `${inv}:commission`)!;
    expect(j.memo).toBe(`Commission accrued · ${w.documents.find(d => d.id === inv)!.number}`);
    expect(j.date).toBe(T);
    expect(j.lines).toEqual([{ account: '5100', debit: '200.0000', credit: '0.0000' }, { account: '2200', debit: '0.0000', credit: '200.0000' }]);
  });

  it('COM-066 payroll clears commission payable without a second expense [documented: 2200 is cleared at payroll approval; payment settles 2300]', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = approveAll(pay(w, c.cust, inv, '10000'));
    const expenseBefore = accountBalance(w, '5100');
    let id: string;
    [w, id] = payroll(w, MONTH, ['reviewed', 'approved']);
    expect(w.journals.find(j => j.sourceId === `${id}:approve`)!.lines.find(l => l.account === '2200')).toEqual({ account: '2200', debit: '200.0000', credit: '0.0000' });
    expect(accountBalance(w, '2200')).toBe('0.0000');
    w = run(w, 'update_payroll', { id, status: 'paid' }).workspace;
    expect(accountBalance(w, '5100')).toBe(expenseBefore);
    expect(w.journals.find(j => j.sourceId === `${id}:paid`)!.lines.some(l => ['5100', '2200'].includes(l.account))).toBe(false);
    expectInvariants(w);
  });

  it('COM-067 invoice dated outside any plan earns no entitlement', () => {
    const c = setup({ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' });
    const [w, inv] = invoice(c, c.w, {}, { date: '2026-07-15', dueDate: '2026-07-15' });
    expect(w.commissions.filter(x => x.invoiceId === inv)).toEqual([]);
  });

  it('COM-068 two plans in different years: each invoice uses its own plan', () => {
    const c = setup({ effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' });
    const { id: _id, ...plan } = c.w.plans[0];
    let w = run(c.w, 'save_plan', { ...plan, name: '2027 plan', rate: '5', effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31' }).workspace, a: string, b: string;
    [w, a] = invoice(c, w, {}, { date: '2026-11-20', dueDate: '2026-11-20' });
    [w, b] = invoice(c, w, {}, { date: '2027-01-05', dueDate: '2027-01-05' });
    expect([com(w, a).earned, com(w, b).earned]).toEqual(['200.0000', '500.0000']);
    expect(com(w, b).planSnapshot.name).toBe('2027 plan');
  });

  it('COM-069 rate 0 [documented: a zero entitlement row is created and no journal is posted]', () => {
    const c = setup({ rate: '0' });
    const [w, inv] = invoice(c, c.w);
    expect(com(w, inv).earned).toBe('0.0000');
    expect(w.journals.some(j => j.sourceId === `${inv}:commission`)).toBe(false);
  });

  it('COM-070 rate 100: earned equals the base', () => {
    const c = setup({ rate: '100' });
    const [w, inv] = invoice(c, c.w);
    expect(com(w, inv).earned).toBe('10000.0000');
  });

  it('COM-071 per-unit 10 on quantity 0.5 earns 5', () => {
    const c = setup({ type: 'per_unit', rate: '10' });
    const [w, inv] = invoice(c, c.w, { quantity: '0.5' });
    expect(com(w, inv).earned).toBe('5.0000');
  });

  it('COM-072 tier threshold equal to the base [documented: the amount up to the threshold earns the lower tier; only the excess earns the next tier]', () => {
    const c = setup({ type: 'tiered', tiers: [{ threshold: '0', rate: '2' }, { threshold: '500000', rate: '3' }] });
    let w = c.w, a: string, b: string;
    [w, a] = invoice(c, w, { quantity: '5000', price: '100' });
    [w, b] = invoice(c, w, { quantity: '5000.01', price: '100' });
    expect(com(w, a).earned).toBe('10000.0000');
    expect(com(w, b).earned).toBe('10000.0300');
  });

  it('COM-073 per-unit plan with quantity returned is adjusted', () => {
    const c = setup({ type: 'per_unit', rate: '10' });
    let [w, inv] = invoice(c, c.w, { quantity: '10' });
    const lineId = w.documents.find(d => d.id === inv)!.lines[0].id;
    w = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId, quantity: '4' }] }).workspace;
    expect(com(w, inv).earned).toBe('60.0000');
    expectInvariants(w);
  });

  it('COM-074 a cancelled draft invoice never creates an entitlement', () => {
    const c = setup();
    let [w, inv] = withDocument(c.w, 'sales_invoice', c.cust, [{ itemId: c.item, quantity: '1', price: '100', employeeId: c.emp }], {}, false);
    w = run(w, 'cancel_document', { id: inv, reason: 'Wrong customer' }).workspace;
    refused(w, 'submit_document', { id: inv }, 'Only draft documents can be submitted.');
    expect(w.commissions).toEqual([]);
  });

  it('COM-075 one receipt across several invoices releases each by its own ratio', () => {
    const c = setup();
    let w = c.w, a: string, b: string;
    [w, a] = invoice(c, w);
    [w, b] = invoice(c, w, { employeeId: c.emp2, quantity: '200' });
    w = run(w, 'create_receipt', { partyId: c.cust, date: T, amount: '15000', method: 'bank', dueDate: T, allocations: [{ invoiceId: a, amount: '10000' }, { invoiceId: b, amount: '5000' }], accountId: 'main-bank' }).workspace;
    expect([com(w, a).released, com(w, b).released]).toEqual(['200.0000', '100.0000']);
    expectInvariants(w);
  });

  it('COM-076 overpayment is prevented, so release never exceeds earned', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = pay(w, c.cust, inv, '9000');
    refused(w, 'create_receipt', { partyId: c.cust, date: T, amount: '2000', method: 'cash', dueDate: T, allocations: [{ invoiceId: inv, amount: '2000' }], accountId: 'cash' }, 'Invalid invoice allocation.');
    expect(D(com(w, inv).released).lte(com(w, inv).earned)).toBe(true);
  });

  it('COM-077 rounding: 2% of 33.33 is 0.6666 at 4 dp; movements sum exactly', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w, { quantity: '1', price: '33.33' });
    expect(com(w, inv).earned).toBe('0.6666');
    w = pay(w, c.cust, inv, '11.11');
    w = pay(w, c.cust, inv, '22.22');
    const released = sum(w.commissionMovements.filter(m => m.commissionId === com(w, inv).id && m.type === 'released').map(m => m.amount));
    expect(money(released)).toBe('0.6666');
    expect(com(w, inv).released).toBe('0.6666');
  });

  it('COM-078 releases across partial receipts sum exactly to earned when fully paid', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    for (const part of ['3333.33', '3333.33', '3333.33', '0.01']) w = pay(w, c.cust, inv, part);
    expect(outstanding(w.documents.find(d => d.id === inv)!)).toBe('0.0000');
    const released = sum(w.commissionMovements.filter(m => m.commissionId === com(w, inv).id && m.type === 'released').map(m => m.amount));
    expect(money(released)).toBe('200.0000');
    expect(com(w, inv).released).toBe('200.0000');
  });

  it('COM-079 released-but-unapproved commissions are counted for the attention list [browser: list rendering]', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = pay(w, c.cust, inv, '5000');
    expect(w.commissions.filter(x => D(x.released).gt(x.paid) && !x.approved)).toHaveLength(1);
    expect(source('src/components/workbench.tsx')).toContain("'Commission awaiting approval'");
  });

  it('COM-080 sales analysis by salesperson includes commission [documented: not present; rows carry invoices, quantity, net, returns only]', () => {
    const c = setup();
    const [w] = invoice(c, c.w);
    const row = salesAnalysis(w, `${MONTH}-01`, `${MONTH}-31`, 'salesperson').rows[0];
    expect(row).toMatchObject({ label: 'Hamza Khan', net: '10000.0000' });
    expect(Object.keys(row)).not.toContain('commission');
  });

  it.todo('COM-081 [browser] entitlement badges earned / released / approved use distinct colours');

  it('COM-082 plan form pairs textarea "Lighting = 2.5" is parsed; invalid lines ignored [browser: form round trip]', () => {
    const form = source('src/components/record-form.tsx');
    expect(form).toContain(".filter(([k, v]) => k && v)");
  });

  it('COM-083 pairs with "=" in the key split at the first "="', () => {
    const form = source('src/components/record-form.tsx');
    expect(form).toContain("const [k, ...rest] = l.split('='); return [k.trim(), rest.join('=').trim()]");
  });

  it.todo('COM-084 [browser] plan form shows fields for its type consistently');
  it.todo('COM-085 [browser] Owner "View as" Salesperson filters entitlements (projection verified in COM-043)');

  it('COM-086 employee territory is saved [browser: territory filter]', () => {
    const w = run(freshCompany(), 'save_employee', employee('Bilal', { territory: 'Lahore' })).workspace;
    expect(w.employees[0].territory).toBe('Lahore');
  });

  it('COM-087 global search finds an employee [documented: not present; search covers documents, parties and items only]', () => {
    const search = source('src/components/workbench.tsx').split('function SearchDialog')[1].split('\nfunction ')[0];
    expect(search).not.toContain('employees');
  });

  it('COM-088 10,000 entitlements: totals and projection compute in < 2 s [browser: list rendering time]', () => {
    const c = setup();
    const [w] = invoice(c, c.w);
    const tpl = w.commissions[0];
    for (let i = 0; i < 10000; i++) w.commissions.push({ ...tpl, id: `bulk-${i}`, employeeId: i % 2 ? c.emp : c.emp2 });
    const start = performance.now();
    const t = commissionTotals(w);
    const view = scopeWorkspace(w, sp(c.emp));
    expect(performance.now() - start).toBeLessThan(2000);
    expect(t.earned).toBe('2000200.0000');
    expect(view.commissions.length).toBe(5001);
  });

  it.todo('COM-089 [browser] LIVE label shows on Commissions in the sidebar');

  it('COM-090 approve retried with the same key changes nothing the second time', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = pay(w, c.cust, inv, '5000');
    const first = run(w, 'approve_commission', { ids: [com(w, inv).id] }, undefined, 'qa-approve-retry');
    const second = run(first.workspace, 'approve_commission', { ids: [com(w, inv).id] }, undefined, 'qa-approve-retry');
    expect(second.message).toBe('This operation was already completed.');
    expect(second.workspace).toBe(first.workspace);
  });

  it('COM-091 approve then bounce: released drops, approval is cleared, payroll refuses [case-corrected: approved resets to false when the release changes]', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w); let chq: string, id: string;
    [w, chq] = cheque(w, c.cust, inv, '10000');
    w = approveAll(w);
    [w, id] = payroll(w, MONTH, []);
    w = run(w, 'update_cheque', { id: chq, status: 'bounced', date: T }).workspace;
    expect(com(w, inv)).toMatchObject({ released: '0.0000', approved: false });
    refused(w, 'update_payroll', { id, status: 'reviewed' }, 'Commission changed since this payroll was calculated. Reconcile the run before approval.');
  });

  it('COM-092 walk-in customer invoice with a salesperson accrues normally', () => {
    const c = setup();
    let walkIn: string, w = c.w, inv: string;
    [w, walkIn] = withParty(w, 'customer', { name: 'Walk-in customer' });
    [w, inv] = invoice(c, w, {}, { partyName: 'Ali Traders' }, walkIn);
    expect(w.documents.find(d => d.id === inv)!.partyName).toBe('Ali Traders');
    expect(com(w, inv).earned).toBe('200.0000');
  });

  it('COM-093 credit note on a walk-in invoice adjusts the entitlement', () => {
    const c = setup();
    let walkIn: string, w = c.w, inv: string;
    [w, walkIn] = withParty(w, 'customer', { name: 'Walk-in customer' });
    [w, inv] = invoice(c, w, {}, { partyName: 'Ali Traders' }, walkIn);
    w = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '25' }] }).workspace;
    expect(com(w, inv).earned).toBe('150.0000');
    expectInvariants(w);
  });

  it('COM-094 employee deactivated with unpaid commission: still payable and shown [documented: payroll skips inactive employees, so it is not paid until reactivated]', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = approveAll(pay(w, c.cust, inv, '10000'));
    w = run(w, 'save_employee', { ...w.employees.find(e => e.id === c.emp), active: false }).workspace;
    expect(commissionTotals(w, c.emp).unpaid).toBe('200.0000');
    expect(accountBalance(w, '2200')).toBe('-200.0000');
    const [w2, id] = payroll(w, MONTH, []);
    expect(w2.payrolls.find(p => p.id === id)!.lines.some(l => l.employeeId === c.emp)).toBe(false);
  });

  it('COM-095 with Payroll off, approvals still work', () => {
    const c = setup({}, ['sales', 'purchasing', 'inventory', 'collections', 'cashbank', 'commissions', 'reports']);
    let [w, inv] = invoice(c, c.w);
    w = pay(w, c.cust, inv, '5000');
    const r = run(w, 'approve_commission', { ids: [com(w, inv).id] });
    expect(r.message).toBe('Commission approved for payroll.');
    expect(com(r.workspace, inv).approved).toBe(true);
  });

  it('COM-096 hiding Commissions reports plan and entitlement counts [browser: password confirmation dialog]', () => {
    const c = setup();
    let [w] = invoice(c, c.w);
    [w] = invoice(c, w);
    expect(moduleRecordCounts(w, 'commissions')).toEqual([{ label: 'entitlements', count: 2 }, { label: 'plans', count: 1 }]);
    const hidden = run(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'commissions') });
    expect(hidden.message).toBe('Hid Commissions; records are kept');
    expect(hidden.workspace.commissions).toHaveLength(2);
  });

  it('COM-097 approvals are written to the audit log', () => {
    const c = setup();
    let [w, inv] = invoice(c, c.w);
    w = pay(w, c.cust, inv, '5000');
    w = run(w, 'approve_commission', { ids: [com(w, inv).id] }, actor('Sales Manager')).workspace;
    expect(w.audit.at(-1)).toMatchObject({ action: 'approve_commission', role: 'Sales Manager', sourceId: com(w, inv).id, detail: 'Commission approved for payroll.' });
  });

  it('COM-098 save_plan as Salesperson is refused', () => {
    const c = setup();
    refused(c.w, 'save_plan', { ...c.w.plans[0], rate: '50' }, 'Your role does not permit this action.', sp(c.emp));
  });

  it("COM-099 approve_commission with another tenant's id is not found", () => {
    const c = setup();
    let [other, inv] = invoice(c, c.w);
    other = pay(other, c.cust, inv, '5000');
    const foreign = com(other, inv).id;
    refused(freshCompany(), 'approve_commission', { ids: [foreign] }, 'Commission not found.');
  });

  it('COM-100 end to end: plan → split invoice → partial cash → cheque clear → approve → payroll pay → bounce → recovery in next payroll', () => {
    const c = setup();
    let w = c.w, inv: string, chq: string;
    [w, inv] = invoice(c, w, { employeeId: '', taxRate: '18', splits: [{ employeeId: c.emp, share: '60' }, { employeeId: c.emp2, share: '40' }] });
    expect([com(w, inv, c.emp).earned, com(w, inv, c.emp2).earned]).toEqual(['120.0000', '80.0000']);
    w = pay(w, c.cust, inv, '5900');
    expect([com(w, inv, c.emp).released, com(w, inv, c.emp2).released]).toEqual(['60.0000', '40.0000']);
    [w, chq] = cheque(w, c.cust, inv, '5900');
    expect([com(w, inv, c.emp).released, com(w, inv, c.emp2).released]).toEqual(['120.0000', '80.0000']);
    w = approveAll(w);
    [w] = payroll(w, MONTH);
    expect([com(w, inv, c.emp).paid, com(w, inv, c.emp2).paid]).toEqual(['120.0000', '80.0000']);
    expectInvariants(w);
    w = run(w, 'update_cheque', { id: chq, status: 'bounced', date: T }).workspace;
    expect([com(w, inv, c.emp).released, com(w, inv, c.emp2).released]).toEqual(['60.0000', '40.0000']);
    expect(commissionTotals(w).recoverable).toBe('100.0000');
    expectInvariants(w);
    let id: string;
    [w, id] = payroll(w, M2);
    const pr = w.payrolls.find(p => p.id === id)!;
    expect(pr.lines.map(l => [l.employeeId, l.recovery])).toEqual([[c.emp, '60.0000'], [c.emp2, '40.0000']]);
    expect(commissionTotals(w).recoverable).toBe('0.0000');
    expect(commissionTotals(w).paid).toBe('100.0000');
    expectInvariants(w);
  });
});
