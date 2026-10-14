import { describe, expect, it } from 'vitest';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { accountBalance, execute, outstanding, stock } from '../../src/modules/erp/engine';
import { D, sum } from '../../src/modules/erp/money';
import type { Actor, Workspace } from '../../src/modules/erp/types';

const owner: Actor = { id: 'o', name: 'Owner', role: 'Owner', branchIds: [] };
let n = 0;
const run = (w: Workspace, type: string, payload: Record<string, unknown>, actor = owner) => execute(w, { type, payload, idempotencyKey: `documents-${++n}` }, actor);
const line = (itemId: string, quantity: string, price: string, extra: Record<string, unknown> = {}) => ({ itemId, quantity, price, taxRate: '18', employeeId: 'e-4', ...extra });
const docOf = (w: Workspace, id: string) => w.documents.find(d => d.id === id)!;

describe('draft editing', () => {
  it('updates a draft in place, keeping id and number, and recomputes totals', () => {
    const created = run(buildDemoWorkspace(), 'create_document', { kind: 'sales_invoice', partyId: 'c-1', warehouseId: 'khi-main', date: '2026-10-15', dueDate: '2026-11-14', lines: [line('i-1', '10', '2400')] });
    const before = docOf(created.workspace, created.recordId);
    const updated = run(created.workspace, 'update_document', { id: created.recordId, partyId: 'c-2', warehouseId: 'khi-main', date: '2026-10-15', dueDate: '2026-11-30', lines: [line('i-1', '5', '2400'), line('i-2', '2', '3200', { discount: '10' })], notes: 'edited' });
    const after = docOf(updated.workspace, created.recordId);
    expect(after.number).toBe(before.number);
    expect(after.partyId).toBe('c-2');
    expect(after.lines).toHaveLength(2);
    expect(after.net).toBe(D(5 * 2400 + 2 * 3200 * 0.9).toFixed(4));
    expect(updated.workspace.documents).toHaveLength(created.workspace.documents.length);
  });

  it('refuses to edit or cancel a submitted document', () => {
    const w = buildDemoWorkspace();
    const posted = w.documents.find(d => d.kind === 'sales_invoice' && d.status === 'submitted')!;
    expect(() => run(w, 'update_document', { id: posted.id, partyId: posted.partyId, warehouseId: posted.warehouseId, date: posted.date, dueDate: posted.dueDate, lines: [line('i-1', '1', '1')] })).toThrow(/Only draft documents can be edited/);
    expect(() => run(w, 'cancel_document', { id: posted.id })).toThrow(/Only draft documents can be cancelled/);
  });

  it('cancels a draft, records the reason, and frees its parent quantity', () => {
    let w = buildDemoWorkspace();
    const order = run(w, 'create_document', { kind: 'sales_order', partyId: 'c-1', warehouseId: 'khi-main', date: '2026-10-15', dueDate: '2026-11-14', lines: [line('i-1', '10', '2400')] });
    w = run(order.workspace, 'submit_document', { id: order.recordId }).workspace;
    const first = run(w, 'convert_document', { id: order.recordId, date: '2026-10-16' });
    w = first.workspace;
    expect(() => run(w, 'convert_document', { id: order.recordId, date: '2026-10-16' })).toThrow(/at least|min|too small|Converted quantity/i);
    w = run(w, 'cancel_document', { id: first.recordId, reason: 'Customer postponed' }).workspace;
    expect(docOf(w, first.recordId).status).toBe('cancelled');
    expect(docOf(w, first.recordId).notes).toContain('Cancelled: Customer postponed');
    const again = run(w, 'convert_document', { id: order.recordId, date: '2026-10-17' });
    expect(docOf(again.workspace, again.recordId).lines[0].quantity).toBe('10.0000');
  });
});

describe('sales chain with partial conversions', () => {
  it('delivers an order in two parts and invoices each delivery at the delivery cost', () => {
    let w = buildDemoWorkspace();
    const quote = run(w, 'create_document', { kind: 'quotation', partyId: 'c-1', warehouseId: 'khi-main', date: '2026-10-15', dueDate: '2026-11-14', lines: [line('i-1', '10', '2400'), line('i-2', '4', '3200')] });
    w = run(quote.workspace, 'submit_document', { id: quote.recordId }).workspace;
    const order = run(w, 'convert_document', { id: quote.recordId, date: '2026-10-15' });
    w = run(order.workspace, 'submit_document', { id: order.recordId }).workspace;
    const stockBefore = stock(w, 'i-1', 'khi-main').quantity;
    // Partial delivery: 6 of 10 panels, no boards yet.
    const d1 = run(w, 'convert_document', { id: order.recordId, date: '2026-10-16', lines: [line('i-1', '6', '2400')] });
    w = run(d1.workspace, 'submit_document', { id: d1.recordId }).workspace;
    expect(D(stock(w, 'i-1', 'khi-main').quantity).eq(D(stockBefore).minus(6))).toBe(true);
    expect(() => run(w, 'convert_document', { id: order.recordId, date: '2026-10-16', lines: [line('i-1', '5', '2400')] })).toThrow(/Converted quantity exceeds/);
    // Invoice the first delivery: it must not move stock again and must carry the delivery's cost.
    const inv1 = run(w, 'convert_document', { id: d1.recordId, date: '2026-10-16' });
    w = run(inv1.workspace, 'submit_document', { id: inv1.recordId }).workspace;
    expect(D(stock(w, 'i-1', 'khi-main').quantity).eq(D(stockBefore).minus(6))).toBe(true);
    expect(docOf(w, inv1.recordId).lines[0].cost).toBe(docOf(w, d1.recordId).lines[0].cost);
    expect(docOf(w, inv1.recordId).total).toBe(D(6 * 2400 * 1.18).toFixed(4));
    // Second delivery takes the remainder of both lines, then the order is complete.
    const d2 = run(w, 'convert_document', { id: order.recordId, date: '2026-10-18' });
    expect(docOf(d2.workspace, d2.recordId).lines.map(l => [l.itemId, l.quantity])).toEqual([['i-1', '4.0000'], ['i-2', '4.0000']]);
    w = run(d2.workspace, 'submit_document', { id: d2.recordId }).workspace;
    expect(() => run(w, 'convert_document', { id: order.recordId, date: '2026-10-19' })).toThrow();
    for (const journal of w.journals) expect(sum(journal.lines.map(l => l.debit)).eq(sum(journal.lines.map(l => l.credit)))).toBe(true);
  });
});

describe('payments with several allocations', () => {
  it('settles two customer invoices with one bank receipt and releases commission on both', () => {
    let w = buildDemoWorkspace();
    const open = w.documents.filter(d => d.kind === 'sales_invoice' && d.status === 'submitted' && d.partyId === 'c-1' && D(outstanding(d)).gt(0));
    const extra = run(w, 'create_document', { kind: 'sales_invoice', partyId: 'c-1', warehouseId: 'khi-main', date: '2026-10-15', dueDate: '2026-11-14', lines: [line('i-6', '10', '1850')] });
    w = run(extra.workspace, 'submit_document', { id: extra.recordId }).workspace;
    const targets = [...open, docOf(w, extra.recordId)];
    const total = sum(targets.map(outstanding));
    const receipt = run(w, 'create_receipt', { partyId: 'c-1', date: '2026-10-20', amount: total.toFixed(4), method: 'bank', dueDate: '2026-10-20', allocations: targets.map(d => ({ invoiceId: d.id, amount: outstanding(d) })) });
    w = receipt.workspace;
    for (const d of targets) expect(outstanding(docOf(w, d.id))).toBe('0.0000');
    expect(w.commissions.filter(c => targets.some(t => t.id === c.invoiceId)).every(c => c.released === c.earned)).toBe(true);
    expect(() => run(w, 'create_receipt', { partyId: 'c-1', date: '2026-10-21', amount: '1', method: 'cash', dueDate: '2026-10-21', allocations: [{ invoiceId: targets[0].id, amount: '1' }] })).toThrow(/Invalid invoice allocation/);
  });

  it('pays a USD supplier bill and posts the exchange difference', () => {
    let w = buildDemoWorkspace();
    const bill = w.documents.find(d => d.kind === 'supplier_invoice' && d.status === 'submitted')!;
    const payableBefore = D(accountBalance(w, '2000'));
    const fxBefore = D(accountBalance(w, '5400'));
    // Bill is in USD at 280; paying at 285 costs more PKR than booked.
    const usd = D(outstanding(bill));
    const pkr = usd.mul('285');
    w = run(w, 'create_receipt', { partyId: bill.partyId, date: '2026-10-20', amount: pkr.toFixed(4), method: 'bank', dueDate: '2026-10-20', allocations: [{ invoiceId: bill.id, amount: usd.toFixed(4) }] }).workspace;
    expect(outstanding(docOf(w, bill.id))).toBe('0.0000');
    expect(D(accountBalance(w, '2000')).minus(payableBefore).eq(usd.mul('280'))).toBe(true);
    expect(D(accountBalance(w, '5400')).minus(fxBefore).eq(usd.mul(5))).toBe(true);
  });
});

describe('returns', () => {
  it('caps a return at the un-returned quantity and reduces the balance', () => {
    const w = buildDemoWorkspace();
    const invoice = w.documents.find(d => d.number === 'INV-2026-0001')!;
    const first = invoice.lines[0];
    expect(() => run(w, 'return_document', { id: invoice.id, date: '2026-10-15', lines: [{ lineId: first.id, quantity: D(first.quantity).plus(1).toString() }] })).toThrow(/Return exceeds/);
    const ok = run(w, 'return_document', { id: invoice.id, date: '2026-10-15', reason: 'Damaged', lines: [{ lineId: first.id, quantity: '2' }] });
    const after = docOf(ok.workspace, invoice.id);
    expect(D(after.returned).gt(0)).toBe(true);
    expect(ok.workspace.documents.find(d => d.kind === 'credit_note' && d.parentId === invoice.id)!.lines[0].quantity).toBe('2');
  });
});

describe('credit limits', () => {
  it('treats a zero limit as no limit and enforces a positive one', () => {
    let w = run(buildDemoWorkspace(), 'save_party', { name: 'Walk-in Buyer', type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 0, customerClass: 'Retailer' }).workspace;
    const buyer = w.parties.find(p => p.name === 'Walk-in Buyer')!.id;
    const big = run(w, 'create_document', { kind: 'sales_invoice', partyId: buyer, warehouseId: 'khi-main', date: '2026-10-15', dueDate: '2026-10-15', lines: [line('i-1', '100', '2400')] });
    expect(() => run(big.workspace, 'submit_document', { id: big.recordId })).not.toThrow();
    w = run(w, 'save_party', { ...w.parties.find(p => p.id === buyer)!, creditLimit: '1000' }).workspace;
    const capped = run(w, 'create_document', { kind: 'sales_invoice', partyId: buyer, warehouseId: 'khi-main', date: '2026-10-15', dueDate: '2026-10-15', lines: [line('i-1', '1', '2400')] });
    expect(() => run(capped.workspace, 'submit_document', { id: capped.recordId })).toThrow(/credit limit exceeded/);
  });
});
