import { describe, expect, it } from 'vitest';
import { actor, expectInvariants, firstWarehouse, freshCompany, owner, refused, run, today, withItem, withParty, D, outstanding } from './helpers';
import { stock, summary } from '../../src/modules/erp/engine';
import { documentPartyName, documentView } from '../../src/modules/erp/documents';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { toggleModules } from '../../src/modules/erp/modules';
import type { Actor, Workspace } from '../../src/modules/erp/types';

// ---------- private helpers ----------
const L = (itemId: string, quantity = '1', price = '100', extra: Record<string, unknown> = {}) => ({ itemId, quantity, price, discount: '0', taxRate: '0', employeeId: '', splits: [], ...extra });
const docOf = (w: Workspace, id: string) => w.documents.find(d => d.id === id)!;
const qty = (w: Workspace, item: string) => stock(w, item, firstWarehouse(w)).quantity;
const journalOf = (w: Workspace, sourceId: string) => w.journals.find(j => j.sourceId === sourceId);
const byAccount = (w: Workspace, sourceId: string) => Object.fromEntries((journalOf(w, sourceId)?.lines ?? []).map(l => [l.account, D(l.debit).minus(l.credit).toFixed(4)]));
function create(w: Workspace, kind: string, partyId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, who: Actor = owner) {
  return run(w, 'create_document', { kind, partyId, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines, ...extra }, who);
}
function createSubmit(w: Workspace, kind: string, partyId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, who: Actor = owner): [Workspace, string] {
  const c = create(w, kind, partyId, lines, extra, who);
  return [run(c.workspace, 'submit_document', { id: c.recordId }, who).workspace, c.recordId];
}
function convert(w: Workspace, id: string, lines?: Record<string, unknown>[], who: Actor = owner) {
  return run(w, 'convert_document', { id, date: today(), ...(lines ? { lines } : {}) }, who);
}
function submit(w: Workspace, id: string, who: Actor = owner) { return run(w, 'submit_document', { id }, who).workspace; }
/** Company with one stocked product (10 @ 60) and one customer. */
function base(opening = '10', fields: Record<string, unknown> = {}) {
  let w = freshCompany();
  let item: string, cust: string;
  [w, item] = withItem(w, { name: 'LED Panel', ...fields }, { quantity: opening, cost: '60' });
  [w, cust] = withParty(w, 'customer');
  return { w, item, cust };
}
function employee(w: Workspace, name: string): [Workspace, string] {
  const r = run(w, 'save_employee', { name, role: 'Salesperson', territory: 'Karachi', salary: '50000', allowance: '0', deduction: '0', attendance: 30, active: true });
  return [r.workspace, r.recordId];
}
function receive(w: Workspace, partyId: string, invoiceId: string, amount: string) {
  return run(w, 'create_receipt', { partyId, date: today(), amount, method: 'cash', chequeNo: '', dueDate: today(), allocations: [{ invoiceId, amount }], employeeId: '', note: '', accountId: 'cash' });
}
function secondBranch(w: Workspace): Workspace {
  w = run(w, 'save_branch', { name: 'Lahore' }).workspace;
  return run(w, 'save_warehouse', { name: 'Lahore store', branchId: 'lahore' }).workspace;
}
const sp = (employeeId: string) => actor('Salesperson', { employeeId });
/** document-editor.tsx sends an empty price/tax/discount as '0'. */
const editorValue = (v: string) => v || '0';

describe('07 Sales documents and the invoice editor (SAL)', () => {
  it('SAL-001 one-step Submit sales invoice: create then submit, stock -1, journal posted', () => {
    const { w: w0, item, cust } = base();
    const created = create(w0, 'sales_invoice', cust, [L(item)]);
    expect(created.message).toBe('Draft saved. Review and submit to post it.');
    const posted = run(created.workspace, 'submit_document', { id: created.recordId });
    const w = posted.workspace;
    const doc = docOf(w, created.recordId);
    expect(posted.message).toBe(`${doc.number} submitted. Related balances updated.`);
    expect(doc.status).toBe('submitted');
    expect(qty(w, item)).toBe('9.0000');
    expect(journalOf(w, doc.id)).toBeDefined();
    expectInvariants(w);
  });

  it('SAL-002 Save draft has no stock or journal effect', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item)]);
    expect(docOf(r.workspace, r.recordId).status).toBe('draft');
    expect(r.workspace.stockMoves.filter(m => m.sourceId === r.recordId)).toHaveLength(0);
    expect(journalOf(r.workspace, r.recordId)).toBeUndefined();
    expect(qty(r.workspace, item)).toBe('10.0000');
  });

  it('SAL-003 submit a draft from the list (submit_document) [browser: list Submit button]', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item)]);
    expect(docOf(submit(r.workspace, r.recordId), r.recordId).status).toBe('submitted');
  });

  it('SAL-004 submit a draft from document details (same submit_document) [browser: details Submit button]', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item, '2')]);
    const w = submit(r.workspace, r.recordId);
    expect(docOf(w, r.recordId).status).toBe('submitted');
    expect(qty(w, item)).toBe('8.0000');
  });

  it('SAL-005 insufficient stock: draft kept, submit refused with exact message [browser: red "Saved as a draft but not submitted." prefix]', () => {
    const { w: w0, item, cust } = base('5');
    const r = create(w0, 'sales_invoice', cust, [L(item, '9')]);
    refused(r.workspace, 'submit_document', { id: r.recordId }, 'Insufficient stock for LED Panel in Main store. Requested: 9, available: 5.');
    expect(docOf(r.workspace, r.recordId).status).toBe('draft');
  });

  it('SAL-006 fix qty and Submit again updates the same draft and submits it; exactly one document', () => {
    const { w: w0, item, cust } = base('5');
    const r = create(w0, 'sales_invoice', cust, [L(item, '9')]);
    // Editor keeps draftId and sends update_document then submit_document.
    const u = run(r.workspace, 'update_document', { id: r.recordId, partyId: cust, warehouseId: firstWarehouse(r.workspace), date: today(), dueDate: today(), lines: [L(item, '4')] });
    expect(u.recordId).toBe(r.recordId);
    const w = submit(u.workspace, r.recordId);
    expect(w.documents.filter(d => d.kind === 'sales_invoice')).toHaveLength(1);
    expect(docOf(w, r.recordId).status).toBe('submitted');
    expect(qty(w, item)).toBe('1.0000');
  });

  it('SAL-007 empty customer: engine refuses with "Party not found." [browser: editor message "Enter the customer\'s name."]', () => {
    const { w, item } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: '', warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item)] }, 'Party not found.');
  });

  it('SAL-008 no product line refused (lines min 1) [browser: editor message "Add at least one product line."]', () => {
    const { w, cust } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [] }, /expected array to have >=1 items/);
  });

  it('SAL-009 qty empty refused by engine "Amount must be greater than zero.", never a raw library error [browser: editor message "Enter a quantity on line 1."]', () => {
    const { w, item, cust } = base();
    const message = refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '')] }, 'Amount must be greater than zero.');
    expect(message).not.toContain('DecimalError');
  });

  it('SAL-010 qty 0 refused "Amount must be greater than zero." [browser: editor "Enter a quantity on line 1."]', () => {
    const { w, item, cust } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '0')] }, 'Amount must be greater than zero.');
  });

  it('SAL-011 qty negative refused "Amount must be greater than zero."', () => {
    const { w, item, cust } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '-1')] }, 'Amount must be greater than zero.');
  });

  it('SAL-012 qty 0.0001 accepted and posts', () => {
    const { w: w0, item, cust } = base();
    const [w, id] = createSubmit(w0, 'sales_invoice', cust, [L(item, '0.0001')]);
    expect(docOf(w, id).status).toBe('submitted');
    expect(qty(w, item)).toBe('9.9999');
    expect(docOf(w, id).net).toBe('0.0100');
  });

  it('SAL-013 qty 0.00001 (below 4 dp) is refused', () => {
    const { w, item, cust } = base();
    // Quantity precision is 4 dp (half-up), so 0.00001 rounds to 0 and is refused.
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '0.00001')] }, /greater than zero|quantity/i);
  });

  it('SAL-014 qty 1,000,000 accepted when stocked', () => {
    const { w: w0, item, cust } = base('1000000');
    const [w, id] = createSubmit(w0, 'sales_invoice', cust, [L(item, '1000000', '1')]);
    expect(docOf(w, id).status).toBe('submitted');
    expect(qty(w, item)).toBe('0.0000');
    expect(docOf(w, id).total).toBe('1000000.0000');
  });

  it.todo('SAL-015 [browser] price prefilled from the product and editable');
  it.todo('SAL-016 [browser] product with price 0 shows empty price with placeholder 0.00');

  it('SAL-017 empty price is sent as 0 by the editor; line total 0', () => {
    const { w: w0, item, cust } = base();
    // document-editor.tsx maps an empty price to '0'.
    const r = create(w0, 'sales_invoice', cust, [L(item, '2', editorValue(''))]);
    expect(docOf(r.workspace, r.recordId).net).toBe('0.0000');
    expect(docOf(r.workspace, r.recordId).total).toBe('0.0000');
  });

  it('SAL-018 negative price refused "Amount cannot be negative."', () => {
    const { w, item, cust } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '1', '-5')] }, 'Amount cannot be negative.');
  });

  it('SAL-019 discount 10% gives line total x0.9', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item, '2', '100', { discount: '10' })]);
    expect(docOf(r.workspace, r.recordId).net).toBe('180.0000');
  });

  it('SAL-020 discount 100% gives line total 0', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item, '2', '100', { discount: '100' })]);
    expect(docOf(r.workspace, r.recordId).net).toBe('0.0000');
  });

  it('SAL-021 discount 101 refused "Percentage cannot exceed 100."', () => {
    const { w, item, cust } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '1', '100', { discount: '101' })] }, 'Percentage cannot exceed 100.');
  });

  it('SAL-022 tax 18 = net x 18% [browser: totals update live]', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item, '10', '100', { taxRate: '18' })]);
    const d = docOf(r.workspace, r.recordId);
    expect([d.net, d.tax, d.total]).toEqual(['1000.0000', '180.0000', '1180.0000']);
  });

  it('SAL-023 tax 0 and blank both 0 (editor sends blank as "0") [documented: engine defaults taxRate to 18 when the field is omitted entirely]', () => {
    const { w: w0, item, cust } = base();
    const zero = create(w0, 'sales_invoice', cust, [L(item, '1', '100', { taxRate: '0' })]);
    expect(docOf(zero.workspace, zero.recordId).tax).toBe('0.0000');
    const blank = create(w0, 'sales_invoice', cust, [L(item, '1', '100', { taxRate: editorValue('') })]);
    expect(docOf(blank.workspace, blank.recordId).tax).toBe('0.0000');
    const omitted = create(w0, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    expect(docOf(omitted.workspace, omitted.recordId).tax).toBe('18.0000');
  });

  it('SAL-024 tax 150 refused "Percentage cannot exceed 100."', () => {
    const { w, item, cust } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '1', '100', { taxRate: '150' })] }, 'Percentage cannot exceed 100.');
  });

  it.todo('SAL-025 [browser] default tax rate from Settings prefilled on new sales lines');

  it('SAL-026 same product on two lines refused "Use one line per product."', () => {
    const { w, item, cust } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item), L(item)] }, 'Use one line per product.');
  });

  it('SAL-027 removing every line is refused by the engine [browser: add/remove line and live totals]', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item)]);
    refused(r.workspace, 'update_document', { id: r.recordId, partyId: cust, warehouseId: firstWarehouse(r.workspace), date: today(), dueDate: today(), lines: [] }, /expected array to have >=1 items/);
  });

  it('SAL-028 100 lines accepted; 101 refused', () => {
    let w = freshCompany();
    const items: string[] = [];
    for (let i = 0; i < 101; i++) { let id: string; [w, id] = withItem(w); items.push(id); }
    let cust: string; [w, cust] = withParty(w);
    const ok = create(w, 'sales_invoice', cust, items.slice(0, 100).map(i => L(i)));
    expect(docOf(ok.workspace, ok.recordId).lines).toHaveLength(100);
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: items.map(i => L(i)) }, /expected array to have <=100 items/);
  });

  it('SAL-029 Salesperson must book lines to their own employee id [browser: salesperson column select]', () => {
    let { w, item, cust } = base();
    let e1: string; [w, e1] = employee(w, 'Rep One');
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item)] }, 'Salespeople can create their own sales only.', sp(e1));
    const r = create(w, 'sales_invoice', cust, [L(item, '1', '100', { employeeId: e1 })], {}, sp(e1));
    expect(docOf(r.workspace, r.recordId).lines[0].employeeId).toBe(e1);
  });

  it('SAL-030 Salesperson with another salesperson on a line refused', () => {
    let { w, item, cust } = base();
    let e1: string, e2: string; [w, e1] = employee(w, 'Rep One'); [w, e2] = employee(w, 'Rep Two');
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '1', '100', { employeeId: e2 })] }, 'Salespeople can create their own sales only.', sp(e1));
  });

  it("SAL-031 Salesperson editing another's draft refused", () => {
    let { w, item, cust } = base();
    let e1: string, e2: string; [w, e1] = employee(w, 'Rep One'); [w, e2] = employee(w, 'Rep Two');
    const r = create(w, 'sales_invoice', cust, [L(item, '1', '100', { employeeId: e2 })], {}, sp(e2));
    refused(r.workspace, 'update_document', { id: r.recordId, partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '2', '100', { employeeId: e1 })] }, 'Salespeople can edit their own drafts only.', sp(e1));
  });

  it('SAL-032 Salesperson cannot submit [documented: role gate refuses first with "Your role does not permit this action."]', () => {
    let { w, item, cust } = base();
    let e1: string; [w, e1] = employee(w, 'Rep One');
    const r = create(w, 'sales_invoice', cust, [L(item, '1', '100', { employeeId: e1 })], {}, sp(e1));
    refused(r.workspace, 'submit_document', { id: r.recordId }, 'Your role does not permit this action.', sp(e1));
  });

  it('SAL-033 Warehouse Manager creating an invoice refused', () => {
    const { w, item, cust } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item)] }, 'Warehouse users can create receipts and deliveries only.', actor('Warehouse Manager'));
  });

  it('SAL-034 Recovery Officer creating an invoice refused', () => {
    const { w, item, cust } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item)] }, 'Your role does not permit this action.', actor('Recovery Officer'));
  });

  it('SAL-035 Accountant creates and submits an invoice', () => {
    const { w: w0, item, cust } = base();
    const [w, id] = createSubmit(w0, 'sales_invoice', cust, [L(item)], {}, actor('Accountant'));
    expect(docOf(w, id).status).toBe('submitted');
  });

  it('SAL-036 quotation submit then convert to sales order copies lines and sets parentId', () => {
    const { w: w0, item, cust } = base();
    const [w1, q] = createSubmit(w0, 'quotation', cust, [L(item, '3', '120', { discount: '5', taxRate: '18' })]);
    const c = convert(w1, q);
    expect(c.message).toBe('Next document created as a draft.');
    const so = docOf(c.workspace, c.recordId);
    expect(so.kind).toBe('sales_order');
    expect(so.parentId).toBe(q);
    expect(so.number).toMatch(/^SO-\d{4}-0001$/);
    expect(so.lines.map(l => [l.itemId, l.quantity, l.price, l.discount, l.taxRate])).toEqual([[item, '3.0000', '120', '5', '18']]);
  });

  it('SAL-037 converting a draft quotation refused', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'quotation', cust, [L(item)]);
    refused(r.workspace, 'convert_document', { id: r.recordId, date: today() }, 'Submit the source document first.');
  });

  it('SAL-038 deliver part of a sales order line', () => {
    const { w: w0, item, cust } = base();
    const [w1, so] = createSubmit(w0, 'sales_order', cust, [L(item, '10')]);
    const c = convert(w1, so, [L(item, '4')]);
    const dn = docOf(c.workspace, c.recordId);
    expect([dn.kind, dn.status, dn.lines[0].quantity]).toEqual(['delivery', 'draft', '4']);
  });

  it('SAL-039 delivering more than remaining refused', () => {
    const { w: w0, item, cust } = base();
    const [w1, so] = createSubmit(w0, 'sales_order', cust, [L(item, '10')]);
    const w2 = convert(w1, so, [L(item, '4')]).workspace;
    refused(w2, 'convert_document', { id: so, date: today(), lines: [L(item, '7')] }, 'Converted quantity exceeds the remaining source quantity.');
  });

  it('SAL-040 deliver remaining later: order fully delivered, nothing left to convert [browser: Deliver button hidden]', () => {
    const { w: w0, item, cust } = base();
    const [w1, so] = createSubmit(w0, 'sales_order', cust, [L(item, '10')]);
    const w2 = convert(w1, so, [L(item, '4')]).workspace;
    const second = convert(w2, so); // default = remaining
    expect(docOf(second.workspace, second.recordId).lines[0].quantity).toBe('6.0000');
    // Nothing remains: a default conversion has no lines left and is refused.
    refused(second.workspace, 'convert_document', { id: so, date: today() }, /expected array to have >=1 items/);
  });

  it('SAL-041 submit delivery: stock out, COGS posted, no receivable', () => {
    const { w: w0, item, cust } = base();
    const [w1, so] = createSubmit(w0, 'sales_order', cust, [L(item, '4')]);
    const c = convert(w1, so);
    const w = submit(c.workspace, c.recordId);
    expect(qty(w, item)).toBe('6.0000');
    expect(byAccount(w, c.recordId)).toEqual({ '5000': '240.0000', '1200': '-240.0000' });
    expectInvariants(w);
  });

  it('SAL-042 invoice from a delivery does not move stock again', () => {
    const { w: w0, item, cust } = base();
    const [w1, so] = createSubmit(w0, 'sales_order', cust, [L(item, '4')]);
    const dn = convert(w1, so);
    const w2 = submit(dn.workspace, dn.recordId);
    const inv = convert(w2, dn.recordId);
    expect(docOf(inv.workspace, inv.recordId).kind).toBe('sales_invoice');
    const w = submit(inv.workspace, inv.recordId);
    expect(qty(w, item)).toBe('6.0000');
    expect(w.stockMoves.filter(m => m.sourceId === inv.recordId)).toHaveLength(0);
    expect(byAccount(w, inv.recordId)).toEqual({ '1100': '400.0000', '4000': '-400.0000' });
    expectInvariants(w);
  });

  it('SAL-043 direct invoice moves stock', () => {
    const { w: w0, item, cust } = base();
    const [w] = createSubmit(w0, 'sales_invoice', cust, [L(item, '3')]);
    expect(qty(w, item)).toBe('7.0000');
  });

  it('SAL-044 converting an invoice refused', () => {
    const { w: w0, item, cust } = base();
    const [w, id] = createSubmit(w0, 'sales_invoice', cust, [L(item)]);
    refused(w, 'convert_document', { id, date: today() }, 'This document cannot be converted.');
  });

  it('SAL-045 conversion with a different warehouse via API refused', () => {
    let { w, item, cust } = base();
    w = secondBranch(w);
    const [w1, so] = createSubmit(w, 'sales_order', cust, [L(item, '2')]);
    refused(w1, 'create_document', { kind: 'delivery', parentId: so, partyId: cust, warehouseId: 'lahore-store', date: today(), dueDate: today(), lines: [L(item, '1')] }, 'Source party, warehouse and currency must match.');
  });

  it('SAL-046 quotation directly to delivery via API refused', () => {
    const { w: w0, item, cust } = base();
    const [w, q] = createSubmit(w0, 'quotation', cust, [L(item, '2')]);
    refused(w, 'create_document', { kind: 'delivery', parentId: q, partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '1')] }, 'Invalid document conversion.');
  });

  it('SAL-047 cancel a draft with reason: cancelled, reason appended, parent quantity freed', () => {
    const { w: w0, item, cust } = base();
    const [w1, so] = createSubmit(w0, 'sales_order', cust, [L(item, '5')]);
    const dn = convert(w1, so);
    const c = run(dn.workspace, 'cancel_document', { id: dn.recordId, reason: 'Customer postponed' });
    const d = docOf(c.workspace, dn.recordId);
    expect(c.message).toBe(`${d.number} cancelled.`);
    expect(d.status).toBe('cancelled');
    expect(d.notes).toBe('Cancelled: Customer postponed');
    const again = convert(c.workspace, so);
    expect(docOf(again.workspace, again.recordId).lines[0].quantity).toBe('5.0000');
  });

  it('SAL-048 cancelling a submitted invoice refused', () => {
    const { w: w0, item, cust } = base();
    const [w, id] = createSubmit(w0, 'sales_invoice', cust, [L(item)]);
    refused(w, 'cancel_document', { id, reason: 'x' }, 'Only draft documents can be cancelled. Use a return or reversal for posted documents.');
  });

  it('SAL-049 editing a submitted invoice refused', () => {
    const { w: w0, item, cust } = base();
    const [w, id] = createSubmit(w0, 'sales_invoice', cust, [L(item)]);
    refused(w, 'update_document', { id, partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '2')] }, 'Only draft documents can be edited. Use a return or reversal for posted documents.');
  });

  it('SAL-050 submit twice: retry with same key is a no-op, new key refused; one journal', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item)]);
    const k = 'qa-sal-050-submit-key';
    const first = run(r.workspace, 'submit_document', { id: r.recordId }, owner, k);
    const retry = run(first.workspace, 'submit_document', { id: r.recordId }, owner, k);
    expect(retry.message).toBe('This operation was already completed.');
    expect(retry.workspace).toBe(first.workspace);
    refused(first.workspace, 'submit_document', { id: r.recordId }, 'Only draft documents can be submitted.');
    expect(first.workspace.journals.filter(j => j.sourceId === r.recordId)).toHaveLength(1);
  });

  it('SAL-051 return 1 unit (damaged) posts CN, restores stock, reduces balance', () => {
    const { w: w0, item, cust } = base();
    const [w1, id] = createSubmit(w0, 'sales_invoice', cust, [L(item, '3', '100', { taxRate: '18' })]);
    const line = docOf(w1, id).lines[0].id;
    const r = run(w1, 'return_document', { id, date: today(), reason: 'Damaged', lines: [{ lineId: line, quantity: '1' }] });
    expect(r.message).toBe('Return posted. Stock, balances and commission updated.');
    const cn = docOf(r.workspace, r.recordId);
    expect(cn.kind).toBe('credit_note');
    expect(cn.number).toMatch(/^CN-\d{4}-0001$/);
    expect(cn.status).toBe('submitted');
    expect(cn.notes).toBe('Damaged');
    expect(cn.total).toBe('118.0000');
    expect(qty(r.workspace, item)).toBe('8.0000');
    expect(docOf(r.workspace, id).returned).toBe('118.0000');
    expect(outstanding(docOf(r.workspace, id))).toBe('236.0000');
    expectInvariants(r.workspace);
  });

  it('SAL-052 return more than unreturned refused', () => {
    const { w: w0, item, cust } = base();
    const [w1, id] = createSubmit(w0, 'sales_invoice', cust, [L(item, '2')]);
    const line = docOf(w1, id).lines[0].id;
    const w2 = run(w1, 'return_document', { id, lines: [{ lineId: line, quantity: '1' }] }).workspace;
    refused(w2, 'return_document', { id, lines: [{ lineId: line, quantity: '2' }] }, 'Return exceeds the unreturned quantity.');
  });

  it('SAL-053 same return line twice in one request refused', () => {
    const { w: w0, item, cust } = base();
    const [w, id] = createSubmit(w0, 'sales_invoice', cust, [L(item, '2')]);
    const line = docOf(w, id).lines[0].id;
    refused(w, 'return_document', { id, lines: [{ lineId: line, quantity: '1' }, { lineId: line, quantity: '1' }] }, 'Duplicate return line.');
  });

  it('SAL-054 return all lines: balance 0, credit note total = invoice total', () => {
    let { w, item, cust } = base();
    let item2: string; [w, item2] = withItem(w, {}, { quantity: '5', cost: '30' });
    const [w1, id] = createSubmit(w, 'sales_invoice', cust, [L(item, '2', '100', { taxRate: '18' }), L(item2, '3', '50', { discount: '10' })]);
    const inv = docOf(w1, id);
    const r = run(w1, 'return_document', { id, lines: inv.lines.map(l => ({ lineId: l.id, quantity: l.quantity })) });
    expect(docOf(r.workspace, r.recordId).total).toBe(inv.total);
    expect(outstanding(docOf(r.workspace, id))).toBe('0.0000');
    expectInvariants(r.workspace);
  });

  it('SAL-055 return after partial payment leaves a customer credit (negative balance)', () => {
    const { w: w0, item, cust } = base();
    const [w1, id] = createSubmit(w0, 'sales_invoice', cust, [L(item, '2')]);
    const w2 = receive(w1, cust, id, '150').workspace;
    const line = docOf(w2, id).lines[0].id;
    const w3 = run(w2, 'return_document', { id, lines: [{ lineId: line, quantity: '1' }] }).workspace;
    expect(outstanding(docOf(w3, id))).toBe('-50.0000');
    const totals = documentView(w3, docOf(w3, id)).totals;
    expect(totals.at(-1)).toEqual({ label: 'Customer credit', value: '50.0000', emphasis: true, credit: true });
    expectInvariants(w3);
  });

  it('SAL-056 return on a draft invoice refused', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item)]);
    refused(r.workspace, 'return_document', { id: r.recordId, lines: [{ lineId: docOf(r.workspace, r.recordId).lines[0].id, quantity: '1' }] }, 'Select a submitted sales or supplier invoice.');
  });

  it('SAL-057 credit note print model shows typed walk-in name, lines and reason [browser: rendered print]', () => {
    let { w, item } = base();
    const walk = run(w, 'save_party', { name: 'Walk-in customer', type: 'customer', city: '', phone: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Retailer' });
    w = walk.workspace;
    const [w1, id] = createSubmit(w, 'sales_invoice', walk.recordId, [L(item, '2')], { partyName: 'Bilal Store' });
    const r = run(w1, 'return_document', { id, reason: 'Wrong colour', lines: [{ lineId: docOf(w1, id).lines[0].id, quantity: '1' }] });
    const view = documentView(r.workspace, docOf(r.workspace, r.recordId));
    expect(view.title).toBe('Credit note');
    expect(view.party.name).toBe('Bilal Store');
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].quantity).toBe('1');
    expect(view.notes).toBe('Wrong colour');
  });

  it('SAL-058 return journal reverses revenue, tax, receivable and COGS/stock proportionally', () => {
    const { w: w0, item, cust } = base();
    const [w1, id] = createSubmit(w0, 'sales_invoice', cust, [L(item, '4', '100', { taxRate: '18' })]);
    const r = run(w1, 'return_document', { id, lines: [{ lineId: docOf(w1, id).lines[0].id, quantity: '1' }] });
    expect(byAccount(r.workspace, r.recordId)).toEqual({ '4000': '100.0000', '2100': '18.0000', '1100': '-118.0000', '1200': '60.0000', '5000': '-60.0000' });
  });

  it('SAL-059 invoice dated in the future accepted [browser: due date computed from terms in the editor]', () => {
    const { w: w0, item, cust } = base();
    const future = `${Number(today().slice(0, 4)) + 1}-01-15`;
    const [w, id] = createSubmit(w0, 'sales_invoice', cust, [L(item)], { date: future, dueDate: future });
    expect(docOf(w, id).status).toBe('submitted');
    expect(journalOf(w, id)!.date).toBe(future);
  });

  it('SAL-060 invoice in a locked period refused', () => {
    const { w: w0, item, cust } = base();
    const w = run(w0, 'set_period', { month: '2026-01', locked: true }).workspace;
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: '2026-01-15', dueDate: '2026-01-15', lines: [L(item)] }, 'Accounting period 2026-01 is locked.');
    // A draft saved before the lock cannot be submitted after it.
    const draft = create(w0, 'sales_invoice', cust, [L(item)], { date: '2026-01-15', dueDate: '2026-01-15' });
    const locked = run(draft.workspace, 'set_period', { month: '2026-01', locked: true }).workspace;
    refused(locked, 'submit_document', { id: draft.recordId }, 'Accounting period 2026-01 is locked.');
  });

  it('SAL-061 due date before the document date [documented: accepted, no ordering check]', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item)], { date: today(), dueDate: '2026-01-01' });
    expect(docOf(r.workspace, r.recordId).dueDate).toBe('2026-01-01');
  });

  it('SAL-062 date 2026-13-01 refused by validation', () => {
    const { w, item, cust } = base();
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: '2026-13-01', dueDate: today(), lines: [L(item)] }, /invalid_format|Invalid ISO date/);
  });

  it('SAL-063 notes 2,000 chars accepted; 2,001 refused', () => {
    const { w, item, cust } = base();
    const ok = create(w, 'sales_invoice', cust, [L(item)], { notes: 'n'.repeat(2000) });
    expect(docOf(ok.workspace, ok.recordId).notes).toHaveLength(2000);
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item)], notes: 'n'.repeat(2001) }, /<=2000 characters/);
  });

  it('SAL-064 notes with newlines kept in the print model [browser: printed with line breaks]', () => {
    const { w, item, cust } = base();
    const r = create(w, 'sales_invoice', cust, [L(item)], { notes: 'Line one\nLine two' });
    expect(documentView(r.workspace, docOf(r.workspace, r.recordId)).notes).toBe('Line one\nLine two');
  });

  it('SAL-065 numbering INV-YYYY-0001, 0002 per year; a cancelled draft keeps its number and is not reused', () => {
    const { w: w0, item, cust } = base();
    const year = today().slice(0, 4);
    const a = create(w0, 'sales_invoice', cust, [L(item)]);
    const b = create(a.workspace, 'sales_invoice', cust, [L(item)]);
    const cancelled = run(b.workspace, 'cancel_document', { id: b.recordId, reason: 'dup' }).workspace;
    const c = create(cancelled, 'sales_invoice', cust, [L(item)]);
    expect([a, b, c].map(x => docOf(c.workspace, x.recordId).number)).toEqual([`INV-${year}-0001`, `INV-${year}-0002`, `INV-${year}-0003`]);
    const nextYear = create(c.workspace, 'sales_invoice', cust, [L(item)], { date: `${Number(year) + 1}-01-02`, dueDate: `${Number(year) + 1}-01-02` });
    expect(docOf(nextYear.workspace, nextYear.recordId).number).toBe(`INV-${Number(year) + 1}-0001`);
  });

  it.todo('SAL-066 [manual] two users create invoices at once: needs real Supabase commits (code review: api/workspace/route.ts:59 returns 409 "Another change was saved first. Refresh and try again." with no transparent retry; engine numbers from the same base revision collide)');
  it.todo('SAL-067 [browser] document list filters (type, status, customer, dates, search) combine; Clear filters');

  it('SAL-068 walk-in typed name is the document party name used by list search [browser: search box]', () => {
    let { w, item } = base();
    const walk = run(w, 'save_party', { name: 'Walk-in customer', type: 'customer', city: '', phone: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Retailer' });
    const [w1, id] = createSubmit(walk.workspace, 'sales_invoice', walk.recordId, [L(item)], { partyName: 'Rashid Kiryana' });
    const d = docOf(w1, id);
    expect(documentPartyName(w1, d)).toBe('Rashid Kiryana');
    // documents-list.tsx searches `${number} ${documentPartyName}`.
    expect(`${d.number} ${documentPartyName(w1, d)}`.toLocaleLowerCase().includes('rashid')).toBe(true);
  });

  it.todo('SAL-069 [browser] list ordering newest first');
  it.todo('SAL-070 [browser] details view shows chain, lines, totals, payments and returns');
  it.todo('SAL-071 [browser] details Print button opens the print view');

  it('SAL-072 edit a draft to change customer; credit check on submit uses the new customer', () => {
    let { w, item, cust } = base();
    let tight: string; [w, tight] = withParty(w, 'customer', { creditLimit: '50' });
    const r = create(w, 'sales_invoice', cust, [L(item)]);
    const u = run(r.workspace, 'update_document', { id: r.recordId, partyId: tight, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item)] });
    expect(docOf(u.workspace, r.recordId).partyId).toBe(tight);
    refused(u.workspace, 'submit_document', { id: r.recordId }, 'Customer credit limit exceeded. An owner must enter an override reason.', actor('Accountant'));
  });

  it('SAL-073 edit a draft removing all lines refused', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item)]);
    refused(r.workspace, 'update_document', { id: r.recordId, partyId: cust, warehouseId: firstWarehouse(w0), date: today(), dueDate: today(), lines: [] }, /expected array to have >=1 items/);
  });

  it.todo('SAL-074 [browser] editor on phone: bottom sheet, line table scrolls horizontally, sticky actions');
  it.todo('SAL-075 [browser] three buttons Cancel, Save draft (outline), Submit (violet)');
  it.todo('SAL-076 [browser] spinner only on the pressed button');
  it.todo('SAL-077 [browser] placeholders Qty / 0.00 / 0 / 0');
  it.todo('SAL-078 [browser] unit hint under qty after product chosen');
  it.todo('SAL-079 [browser] line total and Net/Tax/Total formatted like Rs 4,500');
  it.todo('SAL-080 [browser] Escape closes the editor with unsaved changes (no confirm) — document');
  it.todo('SAL-081 [browser] Overview "Recent sales" shows last 5 with walk-in names');

  it('SAL-082 Total sales metric = submitted invoices net of returns (summary().sales) [browser: Overview card]', () => {
    const { w: w0, item, cust } = base();
    const [w1, id] = createSubmit(w0, 'sales_invoice', cust, [L(item, '10', '100', { taxRate: '18' })]);
    const w2 = run(w1, 'return_document', { id, lines: [{ lineId: docOf(w1, id).lines[0].id, quantity: '1' }] }).workspace;
    const draft = create(w2, 'sales_invoice', cust, [L(item, '5')]).workspace; // drafts excluded
    expect(summary(draft).sales).toBe('900.0000');
  });

  it('SAL-083 credit limit: Owner with override reason submits; Accountant refused [browser: reason field visibility]', () => {
    let { w, item } = base();
    let tight: string; [w, tight] = withParty(w, 'customer', { creditLimit: '50' });
    const noReason = create(w, 'sales_invoice', tight, [L(item)]);
    refused(noReason.workspace, 'submit_document', { id: noReason.recordId }, 'Customer credit limit exceeded. An owner must enter an override reason.');
    const withReason = create(w, 'sales_invoice', tight, [L(item)], { creditOverride: 'Long-standing customer' });
    refused(withReason.workspace, 'submit_document', { id: withReason.recordId }, 'Customer credit limit exceeded.', actor('Accountant'));
    expect(docOf(submit(withReason.workspace, withReason.recordId), withReason.recordId).status).toBe('submitted');
  });

  it('SAL-084 tax snapshot (registered flag, tax id) frozen on the invoice', () => {
    let { w, item } = base();
    let reg: string; [w, reg] = withParty(w, 'customer', { registered: true, taxId: '1234567-8', name: 'Registered Buyer' });
    const [w1, id] = createSubmit(w, 'sales_invoice', reg, [L(item)]);
    const changed = run(w1, 'save_party', { ...w1.parties.find(p => p.id === reg)!, registered: false, taxId: '' }).workspace;
    expect(docOf(changed, id).taxSnapshot).toEqual({ registered: true, taxId: '1234567-8', policy: 'Configured demonstration tax rates; not statutory advice' });
  });

  it('SAL-085 invoice paid updates on receipt; outstanding = total - paid - returned', () => {
    const { w: w0, item, cust } = base();
    const [w1, id] = createSubmit(w0, 'sales_invoice', cust, [L(item, '3')]);
    const w2 = receive(w1, cust, id, '120').workspace;
    const w3 = run(w2, 'return_document', { id, lines: [{ lineId: docOf(w2, id).lines[0].id, quantity: '1' }] }).workspace;
    const d = docOf(w3, id);
    expect([d.total, d.paid, d.returned, outstanding(d)]).toEqual(['300.0000', '120.0000', '100.0000', '80.0000']);
  });

  it('SAL-086 direct invoice journal: Dr 1100 total / Cr 4000 net / Cr 2100 tax; Dr 5000 / Cr 1200 cost', () => {
    const { w: w0, item, cust } = base();
    const [w, id] = createSubmit(w0, 'sales_invoice', cust, [L(item, '2', '100', { taxRate: '18' })]);
    expect(journalOf(w, id)!.lines).toEqual([
      { account: '5000', debit: '120.0000', credit: '0.0000' }, { account: '1200', debit: '0.0000', credit: '120.0000' },
      { account: '1100', debit: '236.0000', credit: '0.0000' }, { account: '4000', debit: '0.0000', credit: '200.0000' }, { account: '2100', debit: '0.0000', credit: '36.0000' },
    ]);
  });

  it('SAL-087 journal memo names the invoice and source = invoice id', () => {
    const { w: w0, item, cust } = base();
    const [w, id] = createSubmit(w0, 'sales_invoice', cust, [L(item)]);
    const j = journalOf(w, id)!;
    expect(j.sourceId).toBe(id);
    expect(j.memo).toBe(`sales invoice · ${docOf(w, id).number}`);
    expect(j.status).toBe('posted');
  });

  it('SAL-088 quotation submit has no stock or ledger effect', () => {
    const { w: w0, item, cust } = base();
    const [w, id] = createSubmit(w0, 'quotation', cust, [L(item, '5')]);
    expect(docOf(w, id).status).toBe('submitted');
    expect(qty(w, item)).toBe('10.0000');
    expect(journalOf(w, id)).toBeUndefined();
  });

  it('SAL-089 sales order submit has no stock or ledger effect', () => {
    const { w: w0, item, cust } = base();
    const [w, id] = createSubmit(w0, 'sales_order', cust, [L(item, '5')]);
    expect(qty(w, item)).toBe('10.0000');
    expect(journalOf(w, id)).toBeUndefined();
  });

  it('SAL-090 delivery note print model [documented: quantities AND rates/amounts/totals are shown]', () => {
    const { w: w0, item, cust } = base();
    const [w1, so] = createSubmit(w0, 'sales_order', cust, [L(item, '4')]);
    const dn = convert(w1, so);
    const view = documentView(dn.workspace, docOf(dn.workspace, dn.recordId));
    expect(view.title).toBe('Delivery note');
    expect(view.lines[0].quantity).toBe('4');
    expect(view.lines[0].rate).toBe('100.0000');
    expect(view.totals.map(t => t.label)).toEqual(['Subtotal', 'Total']);
  });

  it('SAL-091 order with two products converted partially twice tracks remaining per line', () => {
    let { w, item, cust } = base();
    let item2: string; [w, item2] = withItem(w, {}, { quantity: '10', cost: '20' });
    const [w1, so] = createSubmit(w, 'sales_order', cust, [L(item, '5'), L(item2, '8')]);
    const w2 = convert(w1, so, [L(item, '2'), L(item2, '3')]).workspace;
    const third = convert(w2, so, [L(item2, '4')]);
    const last = convert(third.workspace, so);
    expect(docOf(last.workspace, last.recordId).lines.map(l => [l.itemId, l.quantity])).toEqual([[item, '3.0000'], [item2, '1.0000']]);
    refused(third.workspace, 'convert_document', { id: so, date: today(), lines: [L(item2, '2')] }, 'Converted quantity exceeds the remaining source quantity.');
  });

  it('SAL-092 cancelling a delivery draft frees the order quantity', () => {
    const { w: w0, item, cust } = base();
    const [w1, so] = createSubmit(w0, 'sales_order', cust, [L(item, '5')]);
    const dn = convert(w1, so);
    refused(dn.workspace, 'convert_document', { id: so, date: today(), lines: [L(item, '1')] }, 'Converted quantity exceeds the remaining source quantity.');
    const w2 = run(dn.workspace, 'cancel_document', { id: dn.recordId }).workspace;
    expect(docOf(convert(w2, so, [L(item, '5')]).workspace, dn.recordId).status).toBe('cancelled');
  });

  it('SAL-093 product archived after drafting [documented: create refuses archived products but submit of an existing draft still succeeds]', () => {
    const { w: w0, item, cust } = base();
    const r = create(w0, 'sales_invoice', cust, [L(item)]);
    const archived = run(r.workspace, 'set_archived', { kind: 'item', id: item, archived: true }).workspace;
    refused(archived, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(archived), date: today(), dueDate: today(), lines: [L(item)] }, 'LED Panel is archived. Restore it first.');
    expect(docOf(submit(archived, r.recordId), r.recordId).status).toBe('submitted');
  });

  it('SAL-094 Salesperson sees only own documents (scopeWorkspace)', () => {
    let { w, item, cust } = base();
    let e1: string, e2: string; [w, e1] = employee(w, 'Rep One'); [w, e2] = employee(w, 'Rep Two');
    const a = create(w, 'sales_invoice', cust, [L(item, '1', '100', { employeeId: e1 })]);
    const b = create(a.workspace, 'sales_invoice', cust, [L(item, '1', '100', { employeeId: e2 })]);
    const seen = scopeWorkspace(b.workspace, sp(e1)).documents.map(d => d.id);
    expect(seen).toEqual([a.recordId]);
  });

  it('SAL-095 Sales Manager sees all sales documents', () => {
    let { w, item, cust } = base();
    let e1: string, e2: string; [w, e1] = employee(w, 'Rep One'); [w, e2] = employee(w, 'Rep Two');
    const a = create(w, 'sales_invoice', cust, [L(item, '1', '100', { employeeId: e1 })]);
    const b = create(a.workspace, 'sales_invoice', cust, [L(item, '1', '100', { employeeId: e2 })]);
    const c = create(b.workspace, 'quotation', cust, [L(item)]);
    expect(scopeWorkspace(c.workspace, actor('Sales Manager')).documents.map(d => d.id).sort()).toEqual([a.recordId, b.recordId, c.recordId].sort());
  });

  it('SAL-096 commission splits totalling 90% refused', () => {
    let { w, item, cust } = base();
    let e1: string, e2: string; [w, e1] = employee(w, 'Rep One'); [w, e2] = employee(w, 'Rep Two');
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '1', '100', { employeeId: e1, splits: [{ employeeId: e1, share: '50' }, { employeeId: e2, share: '40' }] })] }, 'Commission splits must total 100%.');
  });

  it('SAL-097 invoice with 100 lines submits in under 3 s', () => {
    let w = freshCompany();
    const items: string[] = [];
    for (let i = 0; i < 100; i++) { let id: string; [w, id] = withItem(w, {}, { quantity: '5', cost: '10' }); items.push(id); }
    let cust: string; [w, cust] = withParty(w);
    const r = create(w, 'sales_invoice', cust, items.map(i => L(i, '2', '25', { taxRate: '18' })));
    const started = performance.now();
    const done = submit(r.workspace, r.recordId);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(docOf(done, r.recordId).status).toBe('submitted');
    expectInvariants(done);
  });

  it('SAL-098 hidden Sales module: API refuses sales commands [browser: Sales view gone]', () => {
    const { w: w0, item, cust } = base();
    const off = run(w0, 'set_modules', { enabled: toggleModules.filter(m => !['sales', 'collections', 'commissions'].includes(m)) });
    expect(off.workspace.modules).not.toContain('sales');
    refused(off.workspace, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w0), date: today(), dueDate: today(), lines: [L(item)] }, 'Sales is turned off for this company. Turn it on in Settings → Features.');
  });

  it('SAL-099 branch-limited member invoicing in another branch refused [case-corrected: message is "This warehouse is outside your permitted branches."]', () => {
    let { w, item, cust } = base();
    w = secondBranch(w);
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: 'lahore-store', date: today(), dueDate: today(), lines: [L(item)] }, 'This warehouse is outside your permitted branches.', actor('Sales Manager', { branchIds: ['main'] }));
  });

  it('SAL-100 end to end: quotation → order → two deliveries → invoices → partial return → receipt; reconciled', () => {
    let { w, item, cust } = base('20');
    let q: string, so: string;
    [w, q] = createSubmit(w, 'quotation', cust, [L(item, '10', '100', { taxRate: '18' })]);
    const o = convert(w, q); w = submit(o.workspace, o.recordId); so = o.recordId;
    const d1 = convert(w, so, [L(item, '6', '100', { taxRate: '18' })]); w = submit(d1.workspace, d1.recordId);
    const d2 = convert(w, so); w = submit(d2.workspace, d2.recordId);
    expect(qty(w, item)).toBe('10.0000');
    const i1 = convert(w, d1.recordId); w = submit(i1.workspace, i1.recordId);
    const i2 = convert(w, d2.recordId); w = submit(i2.workspace, i2.recordId);
    expect(qty(w, item)).toBe('10.0000');
    expect([docOf(w, i1.recordId).total, docOf(w, i2.recordId).total]).toEqual(['708.0000', '472.0000']);
    w = run(w, 'return_document', { id: i1.recordId, reason: 'Damaged', lines: [{ lineId: docOf(w, i1.recordId).lines[0].id, quantity: '1' }] }).workspace;
    expect(qty(w, item)).toBe('11.0000');
    w = receive(w, cust, i1.recordId, '590').workspace;
    expect(outstanding(docOf(w, i1.recordId))).toBe('0.0000');
    expect(outstanding(docOf(w, i2.recordId))).toBe('472.0000');
    expect(summary(w).receivables).toBe('472.0000');
    expectInvariants(w);
  });
});
