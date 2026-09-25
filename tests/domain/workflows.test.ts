import { describe, expect, it } from 'vitest';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { commissionTotals, execute, outstanding, stock } from '../../src/modules/erp/engine';
import { D, sum } from '../../src/modules/erp/money';
import type { Actor } from '../../src/modules/erp/types';

const owner: Actor = { id: 'test-owner', name: 'Test Owner', role: 'Owner', branchIds: [] };

describe('connected ERP workflow', () => {
  it('keeps every posted journal balanced and source unique', () => {
    const workspace = buildDemoWorkspace();
    expect(new Set(workspace.journals.map(journal => journal.sourceId)).size).toBe(workspace.journals.length);
    for (const journal of workspace.journals) {
      expect(sum(journal.lines.map(line => line.debit)).eq(sum(journal.lines.map(line => line.credit)))).toBe(true);
    }
  });

  it('releases exactly 40% of eligible commission after a 40% collection', () => {
    const workspace = buildDemoWorkspace();
    const invoice = workspace.documents.find(document => document.number === 'INV-2026-0001')!;
    expect(D(invoice.paid).div(invoice.total).eq('0.4')).toBe(true);
    const commissions = workspace.commissions.filter(commission => commission.invoiceId === invoice.id);
    expect(sum(commissions.map(commission => commission.released)).eq(sum(commissions.map(commission => commission.earned)).mul('0.4'))).toBe(true);
  });

  it('reverses collection and commission release when a cleared cheque bounces', () => {
    const workspace = buildDemoWorkspace();
    const receipt = workspace.receipts.find(item => item.status === 'bounced')!;
    const invoice = workspace.documents.find(document => document.id === receipt.allocations[0].invoiceId)!;
    expect(invoice.paid).toBe('0.0000');
    expect(workspace.commissions.filter(commission => commission.invoiceId === invoice.id).every(commission => D(commission.released).isZero())).toBe(true);
    expect(workspace.journals.some(journal => journal.sourceId === `${receipt.id}:bounce`)).toBe(true);
  });

  it('records a recoverable balance after a post-payment return', () => {
    const workspace = buildDemoWorkspace();
    const salesperson = workspace.employees.find(employee => employee.id === 'e-3')!;
    expect(D(commissionTotals(workspace, salesperson.id).recoverable).gt(0)).toBe(true);
    const returned = workspace.documents.find(document => document.kind === 'credit_note')!;
    expect(returned.parentId).toBeTruthy();
  });

  it('does not place one commission in multiple payroll runs', () => {
    const workspace = buildDemoWorkspace();
    const all = workspace.payrolls.flatMap(payroll => payroll.lines.flatMap(line => line.commissionIds));
    expect(new Set(all).size).toBe(all.length);
  });

  it('reconciles inventory valuation to its general-ledger control', () => {
    const workspace = buildDemoWorkspace();
    const subledger = sum(workspace.items.map(item => stock(workspace, item.id).value));
    const ledger = workspace.journals.flatMap(journal => journal.lines).filter(line => line.account === '1200').reduce((total, line) => total.plus(line.debit).minus(line.credit), D(0));
    expect(subledger.eq(ledger)).toBe(true);
  });

  it('blocks negative stock without mutating the original workspace', () => {
    const workspace = buildDemoWorkspace();
    const before = structuredClone(workspace);
    expect(() => execute(workspace, { type: 'stock_transfer', idempotencyKey: 'negative-stock-test', payload: { itemId: 'i-1', from: 'khi-main', to: 'lhe-main', quantity: '999999', date: '2026-10-03' } }, owner)).toThrow(/Insufficient stock/);
    expect(workspace).toEqual(before);
  });

  it('keeps outstanding receivables equal to submitted invoice balances', () => {
    const workspace = buildDemoWorkspace();
    const subledger = sum(workspace.documents.filter(document => document.kind === 'sales_invoice' && document.status === 'submitted').map(outstanding));
    const ledger = workspace.journals.flatMap(journal => journal.lines).filter(line => line.account === '1100').reduce((total, line) => total.plus(line.debit).minus(line.credit), D(0));
    expect(subledger.eq(ledger)).toBe(true);
  });
});
