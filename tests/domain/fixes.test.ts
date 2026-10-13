import { describe, expect, it } from 'vitest';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { accountBalance, commissionTotals, execute, outstanding, stock } from '../../src/modules/erp/engine';
import { businessToday } from '../../src/modules/erp/dates';
import { D, sum } from '../../src/modules/erp/money';
import type { Actor, Workspace } from '../../src/modules/erp/types';

const owner: Actor = { id: 'test-owner', name: 'Test Owner', role: 'Owner', branchIds: [] };
let key = 0;
const run = (workspace: Workspace, type: string, payload: Record<string, unknown>, actor = owner) =>
  execute(workspace, { type, payload, idempotencyKey: `fix-test-${++key}` }, actor);

function expectBalancedLedger(workspace: Workspace) {
  for (const journal of workspace.journals) expect(sum(journal.lines.map(l => l.debit)).eq(sum(journal.lines.map(l => l.credit)))).toBe(true);
  const inventory = sum(workspace.items.map(item => stock(workspace, item.id).value));
  expect(inventory.minus(accountBalance(workspace, '1200')).abs().lte('0.01')).toBe(true);
}

describe('engine fixes', () => {
  it('moves the exact remaining value when a warehouse is emptied (SQA-06)', () => {
    const base = buildDemoWorkspace();
    for (const itemId of ['i-5', 'i-6']) {
      const source = stock(base, itemId, 'khi-port');
      const { workspace } = run(base, 'stock_transfer', { itemId, from: 'khi-port', to: 'lhe-main', quantity: source.quantity, date: '2026-10-03' });
      expect(stock(workspace, itemId, 'khi-port')).toEqual({ quantity: '0.0000', value: '0.0000', average: '0.0000' });
      expect(stock(workspace, itemId).value).toBe(stock(base, itemId).value);
    }
  });

  it('leaves no value behind when the last units are sold', () => {
    let workspace = buildDemoWorkspace();
    const remaining = stock(workspace, 'i-4', 'lhe-main').quantity;
    const invoice = run(workspace, 'create_document', { kind: 'sales_invoice', partyId: 'c-2', warehouseId: 'lhe-main', date: '2026-10-04', dueDate: '2026-11-04', creditOverride: 'test', lines: [{ itemId: 'i-4', quantity: remaining, price: '1', taxRate: '0' }] });
    workspace = run(invoice.workspace, 'submit_document', { id: invoice.recordId }).workspace;
    expect(stock(workspace, 'i-4', 'lhe-main').value).toBe('0.0000');
    expectBalancedLedger(workspace);
  });

  it('numbers documents by their own year and keeps numbers unique (SQA-12)', () => {
    const first = run(buildDemoWorkspace(), 'create_document', { kind: 'sales_invoice', partyId: 'c-1', warehouseId: 'khi-main', date: '2027-01-05', dueDate: '2027-02-05', lines: [{ itemId: 'i-1', quantity: '1', price: '10' }] });
    const second = run(first.workspace, 'create_document', { kind: 'sales_invoice', partyId: 'c-1', warehouseId: 'khi-main', date: '2027-01-06', dueDate: '2027-02-05', lines: [{ itemId: 'i-1', quantity: '1', price: '10' }] });
    const numbers = second.workspace.documents.map(d => d.number);
    expect(numbers).toContain('INV-2027-0001');
    expect(numbers).toContain('INV-2027-0002');
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('uses the Asia/Karachi calendar day for defaults (SQA-16)', () => {
    expect(businessToday(new Date('2026-10-11T20:30:00Z'))).toBe('2026-10-12');
    expect(businessToday(new Date('2026-10-11T18:59:00Z'))).toBe('2026-10-11');
  });

  it('persists recovery follow-ups (SQA-15)', () => {
    const result = run(buildDemoWorkspace(), 'follow_up', { partyId: 'c-1', note: 'Call about the balance', nextDate: '2026-10-20' });
    const saved = result.workspace.followUps.filter(f => f.note === 'Call about the balance');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ partyId: 'c-1', nextDate: '2026-10-20', actor: 'Test Owner' });
  });

  it('sends late landed cost with transferred stock instead of COGS', () => {
    const base = buildDemoWorkspace();
    const shipment = base.shipments[0];
    const quantity = stock(base, 'i-5', 'khi-port').quantity;
    const moved = run(base, 'stock_transfer', { itemId: 'i-5', from: 'khi-port', to: 'lhe-main', quantity, date: '2026-10-03' }).workspace;
    const before = { lahore: D(stock(moved, 'i-5', 'lhe-main').value), cogs: D(accountBalance(moved, '5000')) };
    const after = run(moved, 'allocate_shipment', { id: shipment.id, date: '2026-10-05' }).workspace;
    const portion = sum(after.shipments[0].allocations.filter(a => a.itemId === 'i-5' && a.costId === after.shipments[0].costs.at(-1)!.id).map(a => a.amount));
    expect(portion.gt(0)).toBe(true);
    expect(D(stock(after, 'i-5', 'lhe-main').value).minus(before.lahore).eq(portion)).toBe(true);
    expect(stock(after, 'i-5', 'khi-port').value).toBe('0.0000');
    // Neither i-5 nor i-6 was sold after receipt, so the whole late charge stays in inventory.
    expect(D(accountBalance(after, '5000')).eq(before.cogs)).toBe(true);
    expectBalancedLedger(after);
  });

  it('pays commission released by a later collection in a new payroll run', () => {
    let workspace = buildDemoWorkspace();
    const invoice = workspace.documents.find(d => d.number === 'INV-2026-0001')!;
    const ids = workspace.commissions.filter(c => c.invoiceId === invoice.id).map(c => c.id);
    expect(workspace.payrolls.find(p => p.month === '2026-09')!.lines.some(l => l.commissionIds.some(id => ids.includes(id)))).toBe(true);
    workspace = run(workspace, 'create_receipt', { partyId: 'c-1', date: '2026-10-06', amount: outstanding(invoice), method: 'bank', dueDate: '2026-10-06', allocations: [{ invoiceId: invoice.id, amount: outstanding(invoice) }] }).workspace;
    workspace = run(workspace, 'approve_commission', { ids }).workspace;
    workspace = run(workspace, 'create_payroll', { month: '2026-11', date: '2026-10-30' }).workspace;
    const november = workspace.payrolls.find(p => p.month === '2026-11')!;
    const paidNow = sum(november.lines.flatMap(l => ids.filter(id => l.commissionIds.includes(id)).map(id => l.commissionAmounts[id])));
    const earned = sum(workspace.commissions.filter(c => ids.includes(c.id)).map(c => c.earned));
    expect(paidNow.eq(earned.mul('0.6'))).toBe(true);
  });

  it('recovers commission paid before a cheque bounced through the next payroll', () => {
    let workspace = buildDemoWorkspace();
    const invoice = run(workspace, 'create_document', { kind: 'sales_invoice', partyId: 'c-3', warehouseId: 'khi-main', date: '2026-08-05', dueDate: '2026-09-05', lines: [{ itemId: 'i-1', quantity: '10', price: '2400', employeeId: 'e-2' }] });
    workspace = run(invoice.workspace, 'submit_document', { id: invoice.recordId }).workspace;
    const total = workspace.documents.find(d => d.id === invoice.recordId)!.total;
    const receipt = run(workspace, 'create_receipt', { partyId: 'c-3', date: '2026-08-06', amount: total, method: 'cheque', chequeNo: 'T-1', dueDate: '2026-08-07', allocations: [{ invoiceId: invoice.recordId, amount: total }] });
    workspace = run(receipt.workspace, 'update_cheque', { id: receipt.recordId, status: 'deposited', date: '2026-08-07' }).workspace;
    workspace = run(workspace, 'update_cheque', { id: receipt.recordId, status: 'cleared', date: '2026-08-08' }).workspace;
    const commission = workspace.commissions.find(c => c.invoiceId === invoice.recordId)!;
    workspace = run(workspace, 'approve_commission', { ids: [commission.id] }).workspace;
    const august = run(workspace, 'create_payroll', { month: '2026-08', date: '2026-08-28' });
    workspace = august.workspace;
    for (const status of ['reviewed', 'approved', 'paid']) workspace = run(workspace, 'update_payroll', { id: august.recordId, status }).workspace;
    workspace = run(workspace, 'update_cheque', { id: receipt.recordId, status: 'bounced', date: '2026-10-07' }).workspace;
    const owed = D(workspace.commissions.find(c => c.id === commission.id)!.paid);
    expect(owed.gt(0)).toBe(true);

    const november = run(workspace, 'create_payroll', { month: '2026-11', date: '2026-10-30' });
    workspace = november.workspace;
    const line = workspace.payrolls.find(p => p.id === november.recordId)!.lines.find(l => l.employeeId === 'e-2')!;
    expect(D(line.recoveryAmounts![commission.id]).eq(owed)).toBe(true);
    for (const status of ['reviewed', 'approved', 'paid']) workspace = run(workspace, 'update_payroll', { id: november.recordId, status }).workspace;
    const recovered = workspace.commissions.find(c => c.id === commission.id)!;
    expect(recovered.paid).toBe('0.0000');
    expect(workspace.commissionMovements.some(m => m.commissionId === commission.id && m.type === 'recovery_recorded')).toBe(true);
    expect(D(commissionTotals(workspace, 'e-2').recoverable).isZero()).toBe(true);
    // Commission payable equals accrued entitlement less what remains paid.
    const payable = D(accountBalance(workspace, '2200')).negated();
    const totals = commissionTotals(workspace);
    expect(payable.eq(D(totals.earned).minus(totals.paid))).toBe(true);
    expectBalancedLedger(workspace);
  });

  it('imports records with the caller’s own role', () => {
    const accountant: Actor = { ...owner, role: 'Accountant' };
    const result = run(buildDemoWorkspace(), 'import_records', { kind: 'customers', rows: [{ name: 'Imported Customer' }] }, accountant);
    expect(result.workspace.parties.some(p => p.name === 'Imported Customer')).toBe(true);
    expect(result.workspace.audit.filter(a => a.action === 'save_party').every(a => a.role === 'Accountant')).toBe(true);
  });
});
