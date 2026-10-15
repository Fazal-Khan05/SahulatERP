/** Regression tests for the QA defects fixed by agent A (engine money). Titles start with the defect ID. */
import { describe, expect, it } from 'vitest';
import { accountBalance, expectInvariants, firstWarehouse, freshCompany, refused, run, today, withDocument, withItem, withParty } from '../qa/helpers';
import { stock } from '../../src/modules/erp/engine';
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
