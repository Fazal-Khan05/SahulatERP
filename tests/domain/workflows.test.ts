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

  it('increases several products in one audited, balanced stock posting', () => {
    const workspace = buildDemoWorkspace();
    const first = stock(workspace, 'i-1', 'khi-main');
    const second = stock(workspace, 'i-2', 'khi-main');
    const beforeLedger = D(workspace.journals.flatMap(journal => journal.lines).filter(line => line.account === '1200').reduce((total, line) => total.plus(line.debit).minus(line.credit), D(0)));
    const result = execute(workspace, {
      type: 'bulk_stock_increase', idempotencyKey: 'bulk-increase-test',
      payload: { warehouseId: 'khi-main', date: '2026-10-03', purpose: 'count_correction', reason: 'Count correction', lines: [
        { itemId: 'i-1', quantity: '10', cost: '1500' },
        { itemId: 'i-2', quantity: '5', cost: '2000' },
      ] },
    }, owner);
    expect(D(stock(result.workspace, 'i-1', 'khi-main').quantity).minus(first.quantity).eq(10)).toBe(true);
    expect(D(stock(result.workspace, 'i-2', 'khi-main').quantity).minus(second.quantity).eq(5)).toBe(true);
    expect(result.workspace.stockMoves.filter(move => move.sourceId === result.recordId)).toHaveLength(2);
    const journal = result.workspace.journals.find(entry => entry.sourceId === result.recordId)!;
    expect(journal.lines.find(line => line.account === '1200')?.debit).toBe('25000.0000');
    expect(journal.lines.find(line => line.account === '5300')?.credit).toBe('25000.0000');
    expect(sum(journal.lines.map(line => line.debit)).eq(sum(journal.lines.map(line => line.credit)))).toBe(true);
    const afterLedger = sum(result.workspace.journals.flatMap(entry => entry.lines).filter(line => line.account === '1200').map(line => D(line.debit).minus(line.credit)));
    expect(afterLedger.minus(beforeLedger).eq(25000)).toBe(true);
    expect(result.workspace.audit.at(-1)?.action).toBe('bulk_stock_increase');
  });

  it('offsets opening stock against owner capital', () => {
    const workspace = buildDemoWorkspace();
    const result = execute(workspace, {
      type: 'bulk_stock_increase', idempotencyKey: 'opening-stock-test',
      payload: { warehouseId: 'lhe-main', date: '2026-10-03', purpose: 'opening_stock', reason: 'Starting stock count', lines: [
        { itemId: 'i-4', quantity: '3', cost: '4200' },
      ] },
    }, owner);
    const journal = result.workspace.journals.find(entry => entry.sourceId === result.recordId)!;
    expect(journal.lines.find(line => line.account === '3000')?.credit).toBe('12600.0000');
    expect(journal.lines.some(line => line.account === '5300')).toBe(false);
  });

  it('rejects an invalid bulk increase without changing any stock', () => {
    const workspace = buildDemoWorkspace();
    const before = structuredClone(workspace);
    expect(() => execute(workspace, {
      type: 'bulk_stock_increase', idempotencyKey: 'invalid-bulk-increase',
      payload: { warehouseId: 'khi-main', date: '2026-10-03', purpose: 'count_correction', reason: 'Count correction', lines: [
        { itemId: 'i-1', quantity: '10', cost: '1500' },
        { itemId: 'i-2', quantity: '5', cost: '0' },
      ] },
    }, owner)).toThrow();
    expect(workspace).toEqual(before);
  });

  it('blocks negative stock without mutating the original workspace', () => {
    const workspace = buildDemoWorkspace();
    const before = structuredClone(workspace);
    expect(() => execute(workspace, { type: 'stock_transfer', idempotencyKey: 'negative-stock-test', payload: { itemId: 'i-1', from: 'khi-main', to: 'lhe-main', quantity: '999999', date: '2026-10-03' } }, owner)).toThrow(/Insufficient stock/);
    expect(workspace).toEqual(before);
  });

  it('moves stock between warehouses without increasing company-wide quantity or value', () => {
    const workspace = buildDemoWorkspace();
    const sourceBefore = stock(workspace, 'i-1', 'khi-main');
    const destinationBefore = stock(workspace, 'i-1', 'lhe-main');
    const totalBefore = stock(workspace, 'i-1');
    const journalsBefore = workspace.journals.length;
    const result = execute(workspace, {
      type: 'stock_transfer', idempotencyKey: 'warehouse-transfer-test',
      payload: { itemId: 'i-1', from: 'khi-main', to: 'lhe-main', quantity: '50', date: '2026-10-03' },
    }, owner);
    expect(D(stock(result.workspace, 'i-1', 'khi-main').quantity).eq(D(sourceBefore.quantity).minus(50))).toBe(true);
    expect(D(stock(result.workspace, 'i-1', 'lhe-main').quantity).eq(D(destinationBefore.quantity).plus(50))).toBe(true);
    expect(stock(result.workspace, 'i-1').quantity).toBe(totalBefore.quantity);
    expect(stock(result.workspace, 'i-1').value).toBe(totalBefore.value);
    expect(result.workspace.journals).toHaveLength(journalsBefore);
    expect(result.workspace.stockMoves.filter(move => move.sourceId === result.recordId)).toHaveLength(2);
  });

  it('keeps outstanding receivables equal to submitted invoice balances', () => {
    const workspace = buildDemoWorkspace();
    const subledger = sum(workspace.documents.filter(document => document.kind === 'sales_invoice' && document.status === 'submitted').map(outstanding));
    const ledger = workspace.journals.flatMap(journal => journal.lines).filter(line => line.account === '1100').reduce((total, line) => total.plus(line.debit).minus(line.credit), D(0));
    expect(subledger.eq(ledger)).toBe(true);
  });

  it('posts invoice tax without creating an FBR simulation', () => {
    const seeded = buildDemoWorkspace();
    expect(seeded.fbr).toHaveLength(0);
    const created = execute(seeded, {
      type: 'create_document', idempotencyKey: 'invoice-without-fbr-draft',
      payload: {
        kind: 'sales_invoice', partyId: 'c-1', warehouseId: 'khi-main',
        date: '2026-10-03', dueDate: '2026-10-31', currency: 'PKR', fxRate: '1',
        lines: [{ itemId: 'i-1', quantity: '1', price: '2400', discount: '0', taxRate: '18', employeeId: 'e-4', splits: [] }],
      },
    }, owner);
    const submitted = execute(created.workspace, {
      type: 'submit_document', idempotencyKey: 'invoice-without-fbr-submit', payload: { id: created.recordId },
    }, owner);
    const invoice = submitted.workspace.documents.find(document => document.id === created.recordId)!;
    expect(D(invoice.tax).gt(0)).toBe(true);
    expect(submitted.workspace.journals.some(journal => journal.sourceId === invoice.id && journal.lines.some(line => line.account === '2100' && D(line.credit).gt(0)))).toBe(true);
    expect(submitted.workspace.fbr).toHaveLength(0);
  });
});
