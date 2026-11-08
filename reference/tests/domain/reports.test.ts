import { describe, expect, it } from 'vitest';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { accountBalance, execute, outstanding, stock } from '../../src/modules/erp/engine';
import { D, sum } from '../../src/modules/erp/money';
import { agedBalances, balanceSheet, generalLedger, landedCostPayable, partyStatement, profitAndLoss, salesAnalysis, stockValuation, trialBalance } from '../../src/modules/erp/reports';
import type { Actor, Workspace } from '../../src/modules/erp/types';

const owner: Actor = { id: 'o', name: 'Owner', role: 'Owner', branchIds: [] };
let n = 0;
const run = (w: Workspace, type: string, payload: Record<string, unknown>) => execute(w, { type, payload, idempotencyKey: `reports-${++n}` }, owner);
const demo = buildDemoWorkspace();

describe('cash and bank accounts', () => {
  it('assigns ledger codes, posts receipts to the chosen account and refuses archiving with a balance', () => {
    let w = run(demo, 'save_bank_account', { name: 'HBL current', type: 'bank', details: 'HBL · 0001' }).workspace;
    const hbl = w.bankAccounts.find(a => a.name === 'HBL current')!;
    expect(hbl.code).toBe('1003');
    const invoice = w.documents.find(d => d.kind === 'sales_invoice' && d.status === 'submitted' && D(outstanding(d)).gt(0))!;
    w = run(w, 'create_receipt', { partyId: invoice.partyId, date: '2026-10-15', amount: '1000', method: 'bank', dueDate: '2026-10-15', accountId: hbl.id, allocations: [{ invoiceId: invoice.id, amount: '1000' }] }).workspace;
    expect(accountBalance(w, '1003')).toBe('1000.0000');
    expect(() => run(w, 'save_bank_account', { id: hbl.id, name: 'HBL current', type: 'bank', details: '', archived: true })).toThrow(/still has a balance/);
    expect(() => run(w, 'create_receipt', { partyId: invoice.partyId, date: '2026-10-15', amount: '1', method: 'cash', dueDate: '2026-10-15', accountId: 'nope', allocations: [{ invoiceId: invoice.id, amount: '1' }] })).toThrow(/Bank account not found/);
  });

  it('deposits a cheque into an account, clears it there, and reverses there on bounce', () => {
    let w = demo;
    const invoice = w.documents.find(d => d.kind === 'sales_invoice' && d.status === 'submitted' && D(outstanding(d)).gt(0))!;
    const cheque = run(w, 'create_receipt', { partyId: invoice.partyId, date: '2026-10-15', amount: '500', method: 'cheque', chequeNo: 'CHQ-1', dueDate: '2026-10-20', allocations: [{ invoiceId: invoice.id, amount: '500' }] });
    w = cheque.workspace;
    w = run(w, 'update_cheque', { id: cheque.recordId, status: 'deposited', date: '2026-10-20', accountId: 'main-bank' }).workspace;
    expect(w.receipts.find(r => r.id === cheque.recordId)!.accountId).toBe('main-bank');
    w = run(w, 'update_cheque', { id: cheque.recordId, status: 'cleared', date: '2026-10-22' }).workspace;
    expect(accountBalance(w, '1001')).toBe('500.0000');
    w = run(w, 'update_cheque', { id: cheque.recordId, status: 'bounced', date: '2026-10-25' }).workspace;
    expect(accountBalance(w, '1001')).toBe('0.0000');
  });

  it('posts transfers and petty expenses as balanced journals', () => {
    let w = run(demo, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '25000', date: '2026-10-15', memo: 'Float' }).workspace;
    expect(accountBalance(w, '1001')).toBe('-25000.0000');
    expect(accountBalance(w, '1002')).toBe('25000.0000');
    w = run(w, 'record_expense', { accountId: 'cash', amount: '1500', date: '2026-10-16', memo: 'Tea and stationery' }).workspace;
    expect(accountBalance(w, '1002')).toBe('23500.0000');
    expect(() => run(w, 'bank_transfer', { fromId: 'cash', toId: 'cash', amount: '1', date: '2026-10-16' })).toThrow(/two different accounts/);
    for (const j of w.journals) expect(sum(j.lines.map(l => l.debit)).eq(sum(j.lines.map(l => l.credit)))).toBe(true);
  });
});

describe('reports reconcile to the ledger', () => {
  it('aged receivables total the AR control and bucket by due date', () => {
    const aged = agedBalances(demo, 'customer', '2026-12-31');
    expect(aged.totals.total).toBe(accountBalance(demo, '1100'));
    expect(D(aged.totals.d90).gt(0)).toBe(true); // demo invoices due 31 Oct 2026 are 61 days old at year end (61–90 bucket)
    expect(aged.rows.some(r => D(r.current).lt(0))).toBe(true); // INV-2026-0002 customer credit
    const asOfOct = agedBalances(demo, 'customer', '2026-10-15');
    expect(asOfOct.totals.total).toBe(aged.totals.total);
    expect(D(asOfOct.totals.current).gt(0)).toBe(true);
  });

  it('aged payables cover the USD bill in PKR', () => {
    // The AP control also carries import charges allocated to landed cost, which have no bill; bills plus those charges equal the control.
    const aged = agedBalances(demo, 'supplier', '2026-12-31');
    expect(D(aged.totals.total).plus(landedCostPayable(demo)).eq(D(accountBalance(demo, '2000')).negated())).toBe(true);
    expect(D(aged.totals.total).gt(0)).toBe(true);
  });

  it('customer statement ends at the customer’s outstanding balance', () => {
    const statement = partyStatement(demo, 'c-1', '2026-01-01', '2026-12-31');
    const open = sum(demo.documents.filter(d => d.partyId === 'c-1' && d.kind === 'sales_invoice' && d.status === 'submitted').map(outstanding));
    expect(statement.closing).toBe(open.toFixed(4));
    expect(statement.lines.map(l => l.description)).toContain('Receipt · bank');
    expect(statement.lines.every((l, i, all) => i === 0 || all[i - 1].date <= l.date)).toBe(true);
  });

  it('stock valuation equals the inventory control', () => {
    const valuation = stockValuation(demo);
    expect(valuation.total).toBe(accountBalance(demo, '1200'));
    expect(valuation.rows.every(r => D(r.value).eq(stock(demo, r.itemId, r.warehouseId).value))).toBe(true);
  });

  it('sales analysis nets returns and agrees across groupings', () => {
    const byCustomer = salesAnalysis(demo, '2026-01-01', '2026-12-31', 'customer');
    const byItem = salesAnalysis(demo, '2026-01-01', '2026-12-31', 'item');
    const bySalesperson = salesAnalysis(demo, '2026-01-01', '2026-12-31', 'salesperson');
    expect(byCustomer.total.netOfReturns).toBe(byItem.total.netOfReturns);
    expect(byItem.total.netOfReturns).toBe(bySalesperson.total.netOfReturns);
    expect(D(byCustomer.total.returns).gt(0)).toBe(true);
    expect(D(byCustomer.total.netOfReturns).eq(D(accountBalance(demo, '4000')).negated())).toBe(true);
  });

  it('P&L, balance sheet and trial balance tie out', () => {
    const pl = profitAndLoss(demo, '2026-01-01', '2026-12-31');
    const bs = balanceSheet(demo, '2026-12-31');
    expect(bs.difference).toBe('0.0000');
    expect(bs.equity.find(r => r.name.startsWith('Retained'))!.amount).toBe(pl.netProfit);
    const tb = trialBalance(demo, '2026-12-31');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const gl = generalLedger(demo, '1100', '2026-09-01', '2026-12-31');
    expect(gl.closing).toBe(accountBalance(demo, '1100'));
    const mid = generalLedger(demo, '1100', '2026-09-15', '2026-12-31');
    expect(D(mid.opening).plus(sum(mid.rows.map(r => r.debit || 0))).minus(sum(mid.rows.map(r => r.credit || 0))).toFixed(4)).toBe(mid.closing);
  });
});
