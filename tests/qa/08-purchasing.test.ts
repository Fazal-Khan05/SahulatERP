import { describe, expect, it } from 'vitest';
import { accountBalance, actor, expectInvariants, firstWarehouse, freshCompany, owner, refused, run, today, withItem, withParty, D, outstanding } from './helpers';
import { stock, summary } from '../../src/modules/erp/engine';
import { documentPartyName, documentView, receiptView } from '../../src/modules/erp/documents';
import { agedBalances, partyStatement } from '../../src/modules/erp/reports';
import { toggleModules } from '../../src/modules/erp/modules';
import type { Actor, Workspace } from '../../src/modules/erp/types';

// ---------- private helpers ----------
const L = (itemId: string, quantity = '1', price = '100', extra: Record<string, unknown> = {}) => ({ itemId, quantity, price, discount: '0', taxRate: '0', employeeId: '', splits: [], ...extra });
const docOf = (w: Workspace, id: string) => w.documents.find(d => d.id === id)!;
const qty = (w: Workspace, item: string) => stock(w, item, firstWarehouse(w)).quantity;
const journalOf = (w: Workspace, sourceId: string) => w.journals.find(j => j.sourceId === sourceId);
const byAccount = (w: Workspace, sourceId: string) => {
  const out: Record<string, string> = {};
  for (const l of journalOf(w, sourceId)?.lines ?? []) out[l.account] = D(out[l.account] ?? 0).plus(l.debit).minus(l.credit).toFixed(4);
  return out;
};
const USD = { currency: 'USD', fxRate: '280' };
function create(w: Workspace, kind: string, partyId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, who: Actor = owner) {
  return run(w, 'create_document', { kind, partyId, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines, ...extra }, who);
}
function submit(w: Workspace, id: string, who: Actor = owner) { return run(w, 'submit_document', { id }, who).workspace; }
function createSubmit(w: Workspace, kind: string, partyId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, who: Actor = owner): [Workspace, string] {
  const c = create(w, kind, partyId, lines, extra, who);
  return [submit(c.workspace, c.recordId, who), c.recordId];
}
function convert(w: Workspace, id: string, lines?: Record<string, unknown>[], who: Actor = owner) {
  return run(w, 'convert_document', { id, date: today(), ...(lines ? { lines } : {}) }, who);
}
function convertSubmit(w: Workspace, id: string, lines?: Record<string, unknown>[], who: Actor = owner): [Workspace, string] {
  const c = convert(w, id, lines, who);
  return [submit(c.workspace, c.recordId, who), c.recordId];
}
/** Company with one product (no stock) and one supplier. */
function base() {
  let w = freshCompany();
  let item: string, sup: string;
  [w, item] = withItem(w, { name: 'Desk Fan' });
  [w, sup] = withParty(w, 'supplier', { name: 'Shenzhen Bright', terms: 60 });
  return { w, item, sup };
}
/** USD PO 100 x $10 @ 280 → GRN (full) → bill, all submitted. */
function usdBill(): { w: Workspace; item: string; sup: string; po: string; grn: string; bill: string } {
  let { w, item, sup } = base();
  let po: string, grn: string, bill: string;
  [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '100', '10')], USD);
  [w, grn] = convertSubmit(w, po);
  [w, bill] = convertSubmit(w, grn);
  return { w, item, sup, po, grn, bill };
}
function pay(w: Workspace, partyId: string, allocations: { invoiceId: string; amount: string }[], amount: string, extra: Record<string, unknown> = {}, who: Actor = owner, key?: string) {
  return run(w, 'create_receipt', { partyId, date: today(), amount, method: 'bank', chequeNo: '', dueDate: today(), allocations, employeeId: '', note: 'Supplier payment', accountId: 'main-bank', ...extra }, who, key);
}
function secondBranch(w: Workspace): Workspace {
  w = run(w, 'save_branch', { name: 'Lahore' }).workspace;
  return run(w, 'save_warehouse', { name: 'Lahore store', branchId: 'lahore' }).workspace;
}

describe('08 Purchasing, foreign currency, supplier payments (PUR)', () => {
  it('PUR-001 purchase order created and submitted: no stock, no ledger', () => {
    const { w: w0, item, sup } = base();
    const [w, po] = createSubmit(w0, 'purchase_order', sup, [L(item, '10', '50')]);
    expect(docOf(w, po).status).toBe('submitted');
    expect(qty(w, item)).toBe('0.0000');
    expect(journalOf(w, po)).toBeUndefined();
  });

  it('PUR-002 Save draft leaves a draft PO', () => {
    const { w: w0, item, sup } = base();
    const r = create(w0, 'purchase_order', sup, [L(item)]);
    expect(docOf(r.workspace, r.recordId).status).toBe('draft');
  });

  it('PUR-003 empty supplier: engine refuses "Party not found." [browser: editor message "Enter the supplier\'s name."]', () => {
    const { w, item } = base();
    refused(w, 'create_document', { kind: 'purchase_order', partyId: '', warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item)] }, 'Party not found.');
  });

  it('PUR-004 "Save supplier?" Yes creates the supplier [documented: Importer class, 30-day default terms]', () => {
    const { w: w0, item } = base();
    // Editor: save_party with plain defaults, then create_document for the new id.
    const created = run(w0, 'save_party', { name: 'Guangzhou Home', type: 'supplier', city: '', phone: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Importer' });
    const party = created.workspace.parties.find(p => p.id === created.recordId)!;
    expect([party.type, party.customerClass, party.terms]).toEqual(['supplier', 'Importer', 30]);
    const r = create(created.workspace, 'purchase_order', party.id, [L(item)]);
    expect(docOf(r.workspace, r.recordId).partyName).toBeUndefined();
  });

  it('PUR-005 "Save supplier?" No books to "Walk-in supplier" and keeps the typed name', () => {
    const { w: w0, item } = base();
    const walk = run(w0, 'save_party', { name: 'Walk-in supplier', type: 'supplier', city: '', phone: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Importer' });
    const r = create(walk.workspace, 'purchase_order', walk.recordId, [L(item)], { partyName: 'Karachi Spares' });
    const d = docOf(r.workspace, r.recordId);
    expect(d.partyId).toBe(walk.recordId);
    expect(documentPartyName(r.workspace, d)).toBe('Karachi Spares');
  });

  it('PUR-006 USD at 280, 100 x $10: total $1,000 and rate shown [browser: PKR 280,000 equivalent in editor]', () => {
    const { w: w0, item, sup } = base();
    const r = create(w0, 'purchase_order', sup, [L(item, '100', '10')], USD);
    const d = docOf(r.workspace, r.recordId);
    expect([d.currency, d.fxRate, d.total]).toEqual(['USD', '280', '1000.0000']);
    expect(D(d.total).mul(d.fxRate).toFixed(4)).toBe('280000.0000');
    expect(documentView(r.workspace, d).meta).toContainEqual({ label: 'Exchange rate', value: '1 USD = 280 PKR' });
  });

  it('PUR-007 USD with empty rate refused with a clear message', () => {
    const { w, item, sup } = base();
    refused(w, 'create_document', { kind: 'purchase_order', partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), currency: 'USD', fxRate: '', lines: [L(item)] }, 'Amount must be greater than zero.');
  });

  it('PUR-008 PKR with rate 280 refused', () => {
    const { w, item, sup } = base();
    refused(w, 'create_document', { kind: 'purchase_order', partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), currency: 'PKR', fxRate: '280', lines: [L(item)] }, 'PKR exchange rate must be 1.');
  });

  it('PUR-009 rate 0.0001 accepted', () => {
    const { w: w0, item, sup } = base();
    const r = create(w0, 'purchase_order', sup, [L(item)], { currency: 'USD', fxRate: '0.0001' });
    expect(docOf(r.workspace, r.recordId).fxRate).toBe('0.0001');
  });

  it('PUR-010 rate 1e12 refused (below one trillion)', () => {
    const { w, item, sup } = base();
    refused(w, 'create_document', { kind: 'purchase_order', partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), currency: 'USD', fxRate: '1000000000000', lines: [L(item)] }, 'Enter a valid number below one trillion.');
  });

  it('PUR-011 EUR via API refused (PKR/USD/CNY only)', () => {
    const { w, item, sup } = base();
    refused(w, 'create_document', { kind: 'purchase_order', partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), currency: 'EUR', fxRate: '300', lines: [L(item)] }, /Invalid option: expected one of/);
  });

  it('PUR-012 CNY order works like USD (GRN valued at price x rate)', () => {
    let { w, item, sup } = base();
    let po: string, grn: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '10', '50')], { currency: 'CNY', fxRate: '39' });
    [w, grn] = convertSubmit(w, po);
    expect(docOf(w, grn).currency).toBe('CNY');
    expect(stock(w, item).value).toBe('19500.0000');
  });

  it.todo('PUR-013 [browser] rate placeholder "e.g. 280" shown when empty');

  it('PUR-014 PO → Receive (full) → GRN submit puts stock in at PKR cost (price x rate)', () => {
    let { w, item, sup } = base();
    let po: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '100', '10')], USD);
    const c = convert(w, po);
    expect(docOf(c.workspace, c.recordId).kind).toBe('goods_receipt');
    w = submit(c.workspace, c.recordId);
    expect(stock(w, item)).toEqual({ quantity: '100.0000', value: '280000.0000', average: '2800.0000' });
  });

  it('PUR-015 receive part (40 of 100); 60 remain for the next Receive', () => {
    let { w, item, sup } = base();
    let po: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '100', '10')], USD);
    [w] = convertSubmit(w, po, [L(item, '40', '10')]);
    const next = convert(w, po);
    expect(docOf(next.workspace, next.recordId).lines[0].quantity).toBe('60.0000');
  });

  it('PUR-016 receiving 61 when 60 remain refused', () => {
    let { w, item, sup } = base();
    let po: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '100', '10')], USD);
    [w] = convertSubmit(w, po, [L(item, '40', '10')]);
    refused(w, 'convert_document', { id: po, date: today(), lines: [L(item, '61', '10')] }, 'Converted quantity exceeds the remaining source quantity.');
  });

  it('PUR-017 receiving the remaining 60 completes the PO [browser: Receive button gone]', () => {
    let { w, item, sup } = base();
    let po: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '100', '10')], USD);
    [w] = convertSubmit(w, po, [L(item, '40', '10')]);
    [w] = convertSubmit(w, po, [L(item, '60', '10')]);
    expect(qty(w, item)).toBe('100.0000');
    refused(w, 'convert_document', { id: po, date: today() }, /expected array to have >=1 items/);
  });

  it('PUR-018 GRN journal Dr 1200 / Cr 2010 at PKR value [case-corrected: credit goes to 2010 Goods received, not billed]', () => {
    const { w, grn } = usdBill();
    expect(byAccount(w, grn)).toEqual({ '1200': '280000.0000', '2010': '-280000.0000' });
  });

  it('PUR-019 GRN → bill: payable in USD at the bill rate, PKR value posted', () => {
    const { w, bill } = usdBill();
    const b = docOf(w, bill);
    expect([b.kind, b.currency, b.fxRate, outstanding(b)]).toEqual(['supplier_invoice', 'USD', '280', '1000.0000']);
    expect(byAccount(w, bill)).toEqual({ '2010': '280000.0000', '2000': '-280000.0000' });
    expect(accountBalance(w, '2010')).toBe('0.0000');
    expectInvariants(w);
  });

  it('PUR-020 bill rate different from GRN rate posts the difference to FX and clears GRNI', () => {
    let { w, item, sup } = base();
    let po: string, grn: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '100', '10')], USD);
    [w, grn] = convertSubmit(w, po);
    const c = convert(w, grn);
    const u = run(c.workspace, 'update_document', { id: c.recordId, partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), currency: 'USD', fxRate: '285', lines: [L(item, '100', '10')] });
    w = submit(u.workspace, c.recordId);
    // GRNI (2010) is cleared at the GRN value (280,000) and the 5,000 rate difference posts to 5400.
    expect(accountBalance(w, '2010')).toBe('0.0000');
    expect(accountBalance(w, '5400')).toBe('5000.0000');
    expectInvariants(w);
  });

  it('PUR-021 GRN converted to a bill with another currency via API refused', () => {
    const { w: w0, item, sup, po } = (() => { let { w, item, sup } = base(); let po: string; [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '5', '10')], USD); return { w, item, sup, po }; })();
    const [w, grn] = convertSubmit(w0, po);
    refused(w, 'create_document', { kind: 'supplier_invoice', parentId: grn, partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), currency: 'CNY', fxRate: '39', lines: [L(item, '5', '10')] }, 'Source party, warehouse and currency must match.');
  });

  it('PUR-022 PO directly to bill via API refused', () => {
    let { w, item, sup } = base();
    let po: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '5')]);
    refused(w, 'create_document', { kind: 'supplier_invoice', parentId: po, partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item, '5')] }, 'Invalid document conversion.');
  });

  it('PUR-023 converting a draft PO refused', () => {
    const { w, item, sup } = base();
    const r = create(w, 'purchase_order', sup, [L(item)]);
    refused(r.workspace, 'convert_document', { id: r.recordId, date: today() }, 'Submit the source document first.');
  });

  it('PUR-024 supplier return of 1 unit on a bill: PR submitted, stock -1, payable reduced', () => {
    const { w: w0, item, bill } = usdBill();
    const r = run(w0, 'return_document', { id: bill, reason: 'Broken', lines: [{ lineId: docOf(w0, bill).lines[0].id, quantity: '1' }] });
    const pr = docOf(r.workspace, r.recordId);
    expect([pr.kind, pr.status]).toEqual(['supplier_return', 'submitted']);
    expect(pr.number).toMatch(/^PR-\d{4}-0001$/);
    expect(qty(r.workspace, item)).toBe('99.0000');
    expect(outstanding(docOf(r.workspace, bill))).toBe('990.0000');
    expect(byAccount(r.workspace, r.recordId)).toEqual({ '2000': '2800.0000', '1200': '-2800.0000' });
    expectInvariants(r.workspace);
  });

  it('PUR-025 returning more than received refused', () => {
    const { w, bill } = usdBill();
    refused(w, 'return_document', { id: bill, lines: [{ lineId: docOf(w, bill).lines[0].id, quantity: '101' }] }, 'Return exceeds the unreturned quantity.');
  });

  it('PUR-026 return on a GRN refused', () => {
    const { w, grn } = usdBill();
    refused(w, 'return_document', { id: grn, lines: [{ lineId: docOf(w, grn).lines[0].id, quantity: '1' }] }, 'Select a submitted sales or supplier invoice.');
  });

  it('PUR-027 return when the stock was already sold refused for insufficient stock', () => {
    let { w, item, bill } = usdBill();
    let cust: string; [w, cust] = withParty(w, 'customer');
    [w] = createSubmit(w, 'sales_invoice', cust, [L(item, '100', '3000')]);
    refused(w, 'return_document', { id: bill, lines: [{ lineId: docOf(w, bill).lines[0].id, quantity: '1' }] }, 'Insufficient stock for Desk Fan in Main store. Requested: 1, available: 0.');
  });

  it('PUR-028 USD 1,000 payment allocated to the bill clears it and the payable', () => {
    const { w: w0, sup, bill } = usdBill();
    const r = pay(w0, sup, [{ invoiceId: bill, amount: '1000' }], '280000');
    expect(r.message).toBe('Payment posted and allocated.');
    expect(outstanding(docOf(r.workspace, bill))).toBe('0.0000');
    expect(accountBalance(r.workspace, '2000')).toBe('0.0000');
    expectInvariants(r.workspace);
  });

  it('PUR-029 PKR actually paid above the booked value posts an exchange loss', () => {
    const { w: w0, sup, bill } = usdBill();
    const r = pay(w0, sup, [{ invoiceId: bill, amount: '1000' }], '281500');
    expect(accountBalance(r.workspace, '5400')).toBe('1500.0000');
    expect(accountBalance(r.workspace, '2000')).toBe('0.0000');
  });

  it('PUR-030 PKR paid below the booked value posts an exchange gain', () => {
    const { w: w0, sup, bill } = usdBill();
    const r = pay(w0, sup, [{ invoiceId: bill, amount: '1000' }], '279000');
    expect(accountBalance(r.workspace, '5400')).toBe('-1000.0000');
    expect(accountBalance(r.workspace, '1001')).toBe('-279000.0000');
  });

  it('PUR-031 allocation above the bill outstanding refused [case-corrected: message is "Invalid invoice allocation."]', () => {
    const { w, sup, bill } = usdBill();
    refused(w, 'create_receipt', { partyId: sup, date: today(), amount: '282800', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: bill, amount: '1010' }], employeeId: '', note: '', accountId: 'main-bank' }, 'Invalid invoice allocation.');
  });

  it('PUR-032 supplier payment whose amount differs from its allocations is refused', () => {
    let { w, item, sup } = base();
    let po: string, grn: string, bill: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '10', '400')]);
    [w, grn] = convertSubmit(w, po);
    [w, bill] = convertSubmit(w, grn);
    // PKR bill of 4,000; paying 5,000 while allocating 4,000 is refused (only a foreign-currency bill can carry an exchange difference).
    refused(w, 'create_receipt', { partyId: sup, date: today(), amount: '5000', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: bill, amount: '4000' }], employeeId: '', note: '', accountId: 'main-bank' }, 'Allocations must equal the receipt amount.');
  });

  it('PUR-033 same bill twice in allocations refused', () => {
    const { w, sup, bill } = usdBill();
    refused(w, 'create_receipt', { partyId: sup, date: today(), amount: '280000', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: bill, amount: '500' }, { invoiceId: bill, amount: '500' }], employeeId: '', note: '', accountId: 'main-bank' }, 'Duplicate allocation.');
  });

  it("PUR-034 allocation to another supplier's bill refused [case-corrected: message is \"Invalid invoice allocation.\"]", () => {
    let { w, bill } = usdBill();
    let other: string; [w, other] = withParty(w, 'supplier');
    refused(w, 'create_receipt', { partyId: other, date: today(), amount: '280000', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: bill, amount: '1000' }], employeeId: '', note: '', accountId: 'main-bank' }, 'Invalid invoice allocation.');
  });

  it('PUR-035 allocation to a draft bill refused [case-corrected: message is "Invalid invoice allocation."]', () => {
    let { w, item, sup } = base();
    let po: string, grn: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '10', '400')]);
    [w, grn] = convertSubmit(w, po);
    const draft = convert(w, grn);
    refused(draft.workspace, 'create_receipt', { partyId: sup, date: today(), amount: '4000', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: draft.recordId, amount: '4000' }], employeeId: '', note: '', accountId: 'main-bank' }, 'Invalid invoice allocation.');
  });

  it('PUR-036 Recovery Officer cannot pay suppliers', () => {
    const { w, sup, bill } = usdBill();
    refused(w, 'create_receipt', { partyId: sup, date: today(), amount: '280000', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: bill, amount: '1000' }], employeeId: '', note: '', accountId: 'main-bank' }, 'Recovery officers cannot pay suppliers.', actor('Recovery Officer'));
  });

  it('PUR-037 cash payment from Cash in hand credits the cash account (1002)', () => {
    const { w: w0, sup, bill } = usdBill();
    const r = pay(w0, sup, [{ invoiceId: bill, amount: '100' }], '28000', { method: 'cash', accountId: 'cash' });
    expect(byAccount(r.workspace, `${r.recordId}:cleared`)).toEqual({ '2000': '28000.0000', '1002': '-28000.0000' });
  });

  it('PUR-038 bank payment credits the chosen bank account', () => {
    let { w, sup, bill } = usdBill();
    const acct = run(w, 'save_bank_account', { name: 'HBL Current', type: 'bank', details: '' });
    w = acct.workspace;
    const code = w.bankAccounts.find(a => a.id === acct.recordId)!.code;
    const r = pay(w, sup, [{ invoiceId: bill, amount: '100' }], '28000', { accountId: acct.recordId });
    expect(accountBalance(r.workspace, code)).toBe('-28000.0000');
  });

  it('PUR-039 outgoing cheque [documented: recorded as status received with no journal; follows the same deposit/clear state machine, posting on clear]', () => {
    const { w: w0, sup, bill } = usdBill();
    const r = pay(w0, sup, [{ invoiceId: bill, amount: '1000' }], '280000', { method: 'cheque', chequeNo: 'OUT-001', accountId: undefined });
    expect(r.message).toBe('Cheque recorded. Commission releases only on clearance.');
    expect(r.workspace.receipts.find(x => x.id === r.recordId)!.status).toBe('received');
    expect(journalOf(r.workspace, `${r.recordId}:cleared`)).toBeUndefined();
    let w = run(r.workspace, 'update_cheque', { id: r.recordId, status: 'deposited', accountId: 'main-bank' }).workspace;
    w = run(w, 'update_cheque', { id: r.recordId, status: 'cleared' }).workspace;
    expect(outstanding(docOf(w, bill))).toBe('0.0000');
    expect(accountBalance(w, '1001')).toBe('-280000.0000');
  });

  it('PUR-040 payment amount 0 refused', () => {
    const { w, sup, bill } = usdBill();
    refused(w, 'create_receipt', { partyId: sup, date: today(), amount: '0', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: bill, amount: '1000' }], employeeId: '', note: '', accountId: 'main-bank' }, 'Amount must be greater than zero.');
  });

  it('PUR-041 payment in a locked period refused', () => {
    let { w, sup, bill } = usdBill();
    w = run(w, 'set_period', { month: '2026-01', locked: true }).workspace;
    refused(w, 'create_receipt', { partyId: sup, date: '2026-01-20', amount: '280000', method: 'bank', chequeNo: '', dueDate: '2026-01-20', allocations: [{ invoiceId: bill, amount: '1000' }], employeeId: '', note: '', accountId: 'main-bank' }, 'Accounting period 2026-01 is locked.');
  });

  it('PUR-042 partial payment reduces the bill outstanding and aged payables', () => {
    const { w: w0, sup, bill } = usdBill();
    const w = pay(w0, sup, [{ invoiceId: bill, amount: '400' }], '112000').workspace;
    expect(outstanding(docOf(w, bill))).toBe('600.0000');
    expect(agedBalances(w, 'supplier', today()).totals.total).toBe('168000.0000');
    expectInvariants(w);
  });

  it('PUR-043 two partial payments sum; the second cannot exceed the remainder', () => {
    const { w: w0, sup, bill } = usdBill();
    let w = pay(w0, sup, [{ invoiceId: bill, amount: '400' }], '112000').workspace;
    refused(w, 'create_receipt', { partyId: sup, date: today(), amount: '170000', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: bill, amount: '601' }], employeeId: '', note: '', accountId: 'main-bank' }, 'Invalid invoice allocation.');
    w = pay(w, sup, [{ invoiceId: bill, amount: '600' }], '168000').workspace;
    expect(docOf(w, bill).paid).toBe('1000.0000');
    expect(outstanding(docOf(w, bill))).toBe('0.0000');
  });

  it('PUR-044 supplier statement: bill, return and payment with a correct running balance; PO not shown [case-corrected: GRNs are not listed either] [defect]', () => {
    const { w: w0, sup, bill } = usdBill();
    let w = run(w0, 'return_document', { id: bill, lines: [{ lineId: docOf(w0, bill).lines[0].id, quantity: '1' }] }).workspace;
    w = pay(w, sup, [{ invoiceId: bill, amount: '500' }], '140000').workspace;
    const st = partyStatement(w, sup, '2000-01-01', '2999-12-31');
    expect(st.lines.map(l => l.description)).toEqual(['Supplier bill', 'Return to supplier', 'Payment · bank']);
    // Owed: 280,000 - 2,800 - 140,000 = 137,200 (= outstanding 490 x 280). Actual 417,200: reports.ts partyStatement negates receipts for suppliers too, so payments add to the balance.
    expect(st.closing).toBe('137200.0000');
  });

  it('PUR-045 Salesperson cannot create purchase documents [browser: Purchasing not visible]', () => {
    const { w, item, sup } = base();
    refused(w, 'create_document', { kind: 'purchase_order', partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item)] }, 'Your role cannot create purchase documents.', actor('Salesperson', { employeeId: 'x' }));
  });

  it('PUR-046 Sales Manager submitting a PO refused', () => {
    const { w: w0, item, sup } = base();
    const r = create(w0, 'purchase_order', sup, [L(item)]);
    refused(r.workspace, 'submit_document', { id: r.recordId }, 'Your role can submit sales documents only.', actor('Sales Manager'));
  });

  it('PUR-047 Warehouse Manager creating a PO refused', () => {
    const { w, item, sup } = base();
    refused(w, 'create_document', { kind: 'purchase_order', partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item)] }, 'Warehouse users can create receipts and deliveries only.', actor('Warehouse Manager'));
  });

  it('PUR-048 Warehouse Manager submits a GRN', () => {
    let { w, item, sup } = base();
    let po: string; [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '5', '10')]);
    const wm = actor('Warehouse Manager');
    const [w2, grn] = convertSubmit(w, po, undefined, wm);
    expect(docOf(w2, grn).status).toBe('submitted');
    expect(qty(w2, item)).toBe('5.0000');
  });

  it('PUR-049 Warehouse Manager submitting a bill refused', () => {
    let { w, item, sup } = base();
    let po: string, grn: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '5', '10')]);
    [w, grn] = convertSubmit(w, po);
    const draft = convert(w, grn);
    refused(draft.workspace, 'submit_document', { id: draft.recordId }, 'Your role can submit warehouse documents only.', actor('Warehouse Manager'));
  });

  it('PUR-050 Accountant runs the full chain PO → GRN → bill → payment', () => {
    let { w, item, sup } = base();
    const acc = actor('Accountant');
    let po: string, grn: string, bill: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '5', '10')], USD, acc);
    [w, grn] = convertSubmit(w, po, undefined, acc);
    [w, bill] = convertSubmit(w, grn, undefined, acc);
    w = pay(w, sup, [{ invoiceId: bill, amount: '50' }], '14000', {}, acc).workspace;
    expect(outstanding(docOf(w, bill))).toBe('0.0000');
    expectInvariants(w);
  });

  it('PUR-051 PO print model shows currency and rate [case-corrected: totals are in the document currency only; PKR equivalent appears only via the exchange-rate line]', () => {
    const { w: w0, item, sup } = base();
    const r = create(w0, 'purchase_order', sup, [L(item, '100', '10')], USD);
    const view = documentView(r.workspace, docOf(r.workspace, r.recordId));
    expect(view.currency).toBe('USD');
    expect(view.meta).toContainEqual({ label: 'Exchange rate', value: '1 USD = 280 PKR' });
    expect(view.totals).toEqual([{ label: 'Subtotal', value: '1000.0000' }, { label: 'Total', value: '1000.0000', emphasis: true }]);
  });

  it('PUR-052 bill print model: supplier and due date', () => {
    const { w, bill } = usdBill();
    const view = documentView(w, docOf(w, bill));
    expect(view.title).toBe('Supplier bill');
    expect(view.partyLabel).toBe('Supplier');
    expect(view.party.name).toBe('Shenzhen Bright');
    expect(view.dueDate).toBe(docOf(w, bill).dueDate);
    expect(view.meta).toContainEqual({ label: 'Terms', value: '60 days' });
  });

  it.todo('PUR-053 [browser] due date defaults to date + supplier terms (computed by the editor; engine stores what is sent)');

  it('PUR-054 editing a draft PO currency after lines recomputes it', () => {
    const { w: w0, item, sup } = base();
    const r = create(w0, 'purchase_order', sup, [L(item, '100', '10')], USD);
    const u = run(r.workspace, 'update_document', { id: r.recordId, partyId: sup, warehouseId: firstWarehouse(w0), date: today(), dueDate: today(), currency: 'CNY', fxRate: '39', lines: [L(item, '100', '10')] });
    const d = docOf(u.workspace, r.recordId);
    expect([d.currency, d.fxRate, d.total]).toEqual(['CNY', '39', '1000.0000']);
    expect(u.message).toBe(`${d.number} updated.`);
  });

  it('PUR-055 submitting a PO in a locked period refused', () => {
    const { w: w0, item, sup } = base();
    const r = create(w0, 'purchase_order', sup, [L(item)], { date: '2026-01-10', dueDate: '2026-01-10' });
    const w = run(r.workspace, 'set_period', { month: '2026-01', locked: true }).workspace;
    refused(w, 'submit_document', { id: r.recordId }, 'Accounting period 2026-01 is locked.');
  });

  it('PUR-056 cancelling a draft GRN frees the PO remaining', () => {
    let { w, item, sup } = base();
    let po: string; [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '10', '10')]);
    const g = convert(w, po);
    w = run(g.workspace, 'cancel_document', { id: g.recordId, reason: 'Wrong truck' }).workspace;
    const again = convert(w, po);
    expect(docOf(again.workspace, again.recordId).lines[0].quantity).toBe('10.0000');
  });

  it('PUR-057 cancelling a submitted GRN refused', () => {
    const { w, grn } = usdBill();
    refused(w, 'cancel_document', { id: grn }, 'Only draft documents can be cancelled. Use a return or reversal for posted documents.');
  });

  it('PUR-058 GRN with 3 lines updates each product average independently', () => {
    let w = freshCompany();
    let a: string, b: string, c: string, sup: string;
    [w, a] = withItem(w, {}, { quantity: '10', cost: '100' });
    [w, b] = withItem(w);
    [w, c] = withItem(w, {}, { quantity: '5', cost: '20' });
    [w, sup] = withParty(w, 'supplier');
    [w] = createSubmit(w, 'goods_receipt', sup, [L(a, '10', '200'), L(b, '4', '50'), L(c, '5', '40')]);
    expect([stock(w, a).average, stock(w, b).average, stock(w, c).average]).toEqual(['150.0000', '50.0000', '30.0000']);
  });

  it('PUR-059 rounding: $0.3333 x 3 at 280 rounds PKR value at 4 dp; journal balanced', () => {
    let { w, item, sup } = base();
    let grn: string;
    [w, grn] = createSubmit(w, 'goods_receipt', sup, [L(item, '3', '0.3333')], USD);
    expect(stock(w, item).value).toBe('279.9720');
    expect(byAccount(w, grn)).toEqual({ '1200': '279.9720', '2010': '-279.9720' });
    expectInvariants(w);
  });

  it('PUR-060 payable control (2000) reconciles to open bills', () => {
    const { w: w0, sup, bill } = usdBill();
    const w = pay(w0, sup, [{ invoiceId: bill, amount: '250' }], '70000').workspace;
    expect(D(accountBalance(w, '2000')).negated().toFixed(4)).toBe('210000.0000');
    expectInvariants(w);
  });

  it('PUR-061 input tax on a bill with tax 18 debits 1300 [case-corrected: input tax account is 1300 Recoverable tax]', () => {
    let { w, item, sup } = base();
    let bill: string;
    [w, bill] = createSubmit(w, 'supplier_invoice', sup, [L(item, '10', '100', { taxRate: '18' })]);
    expect(byAccount(w, bill)).toEqual({ '1200': '1000.0000', '1300': '180.0000', '2000': '-1180.0000' });
  });

  it('PUR-062 tax 0 on purchases posts no tax line', () => {
    let { w, item, sup } = base();
    let bill: string;
    [w, bill] = createSubmit(w, 'supplier_invoice', sup, [L(item, '10', '100')]);
    expect(Object.keys(byAccount(w, bill)).sort()).toEqual(['1200', '2000']);
  });

  it('PUR-063 PO line discount: GRN PKR value is net of discount', () => {
    let { w, item, sup } = base();
    let po: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '10', '10', { discount: '10' })], USD);
    [w] = convertSubmit(w, po);
    expect(stock(w, item).value).toBe('25200.0000');
  });

  it('PUR-064 PO with 100 lines accepted', () => {
    let w = freshCompany();
    const items: string[] = [];
    for (let i = 0; i < 100; i++) { let id: string; [w, id] = withItem(w); items.push(id); }
    let sup: string; [w, sup] = withParty(w, 'supplier');
    const [w2, po] = createSubmit(w, 'purchase_order', sup, items.map(i => L(i, '2', '5')));
    expect(docOf(w2, po).lines).toHaveLength(100);
  });

  it('PUR-065 quantity 0.5 kg accepted', () => {
    let { w, item, sup } = base();
    [w] = createSubmit(w, 'goods_receipt', sup, [L(item, '0.5', '300')]);
    expect(stock(w, item)).toEqual({ quantity: '0.5000', value: '150.0000', average: '300.0000' });
  });

  it('PUR-066 numbering PO-, GRN-, BILL-, PR- per year', () => {
    const { w: w0, bill } = usdBill();
    const w = run(w0, 'return_document', { id: bill, lines: [{ lineId: docOf(w0, bill).lines[0].id, quantity: '1' }] }).workspace;
    const y = today().slice(0, 4);
    expect(w.documents.map(d => d.number)).toEqual([`PO-${y}-0001`, `GRN-${y}-0001`, `BILL-${y}-0001`, `PR-${y}-0001`]);
  });

  it.todo('PUR-067 [browser] purchasing list filters by type/status/supplier/date');

  it('PUR-068 walk-in supplier typed name is searchable [browser: search box]', () => {
    const { w: w0, item } = base();
    const walk = run(w0, 'save_party', { name: 'Walk-in supplier', type: 'supplier', city: '', phone: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Importer' });
    const r = create(walk.workspace, 'purchase_order', walk.recordId, [L(item)], { partyName: 'Hafeez Traders' });
    const d = docOf(r.workspace, r.recordId);
    expect(`${d.number} ${documentPartyName(r.workspace, d)}`.toLocaleLowerCase()).toContain('hafeez');
  });

  it.todo('PUR-069 [browser] Supplier payments tab lists payments with status');
  it.todo('PUR-070 [browser] overdue bill in the attention queue (code review: workbench.tsx attentionItems has no supplier-bill entry — likely fails)');
  it.todo('PUR-071 [browser] Receive dialog shows remaining per line');

  it('PUR-072 Receive with one line at 0: the dialog drops it; converting only the other line works [browser: dialog behaviour]', () => {
    let w = freshCompany();
    let a: string, b: string, sup: string;
    [w, a] = withItem(w); [w, b] = withItem(w); [w, sup] = withParty(w, 'supplier');
    let po: string; [w, po] = createSubmit(w, 'purchase_order', sup, [L(a, '5'), L(b, '5')]);
    refused(w, 'convert_document', { id: po, date: today(), lines: [L(a, '0'), L(b, '5')] }, 'Amount must be greater than zero.');
    const g = convert(w, po, [L(b, '5')]);
    expect(docOf(g.workspace, g.recordId).lines.map(l => l.itemId)).toEqual([b]);
  });

  it('PUR-073 receiving with every line 0 refused', () => {
    let { w, item, sup } = base();
    let po: string; [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '5')]);
    refused(w, 'convert_document', { id: po, date: today(), lines: [] }, /expected array to have >=1 items/);
  });

  it('PUR-074 GRN warehouse must equal the PO warehouse', () => {
    let { w, item, sup } = base();
    w = secondBranch(w);
    let po: string; [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '5')]);
    refused(w, 'create_document', { kind: 'goods_receipt', parentId: po, partyId: sup, warehouseId: 'lahore-store', date: today(), dueDate: today(), lines: [L(item, '5')] }, 'Source party, warehouse and currency must match.');
  });

  it.todo('PUR-075 [browser] warehouse select hidden on PO when only one warehouse');

  it('PUR-076 direct bill without GRN allowed [case-corrected: a direct bill DOES move stock in and debits 1200]', () => {
    let { w, item, sup } = base();
    let bill: string;
    [w, bill] = createSubmit(w, 'supplier_invoice', sup, [L(item, '4', '250')]);
    expect(qty(w, item)).toBe('4.0000');
    expect(byAccount(w, bill)).toEqual({ '1200': '1000.0000', '2000': '-1000.0000' });
    expectInvariants(w);
  });

  it('PUR-077 return on a walk-in supplier bill carries the typed name', () => {
    let { w, item } = base();
    const walk = run(w, 'save_party', { name: 'Walk-in supplier', type: 'supplier', city: '', phone: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Importer' });
    let bill: string;
    [w, bill] = createSubmit(walk.workspace, 'supplier_invoice', walk.recordId, [L(item, '3', '100')], { partyName: 'Hafeez Traders' });
    const r = run(w, 'return_document', { id: bill, lines: [{ lineId: docOf(w, bill).lines[0].id, quantity: '1' }] });
    expect(documentPartyName(r.workspace, docOf(r.workspace, r.recordId))).toBe('Hafeez Traders');
    expect(documentView(r.workspace, docOf(r.workspace, r.recordId)).party.name).toBe('Hafeez Traders');
  });

  it('PUR-078 supplier archived after PO: GRN conversion refused', () => {
    let { w, item, sup } = base();
    let po: string; [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '5')]);
    w = run(w, 'set_archived', { kind: 'party', id: sup, archived: true }).workspace;
    refused(w, 'convert_document', { id: po, date: today() }, 'Shenzhen Bright is archived. Restore it first.');
  });

  it('PUR-079 product archived after PO: conversion refused', () => {
    let { w, item, sup } = base();
    let po: string; [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '5')]);
    w = run(w, 'set_archived', { kind: 'item', id: item, archived: true }).workspace;
    refused(w, 'convert_document', { id: po, date: today() }, 'Desk Fan is archived. Restore it first.');
  });

  it('PUR-080 idempotent retry of GRN submit gives one stock move', () => {
    let { w, item, sup } = base();
    let po: string; [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '5')]);
    const g = convert(w, po);
    const k = 'qa-pur-080-submit-grn';
    const first = run(g.workspace, 'submit_document', { id: g.recordId }, owner, k);
    const retry = run(first.workspace, 'submit_document', { id: g.recordId }, owner, k);
    expect(retry.message).toBe('This operation was already completed.');
    expect(retry.workspace.stockMoves.filter(m => m.sourceId === g.recordId)).toHaveLength(1);
    expect(qty(retry.workspace, item)).toBe('5.0000');
  });

  it('PUR-081 idempotent retry of a payment gives one receipt and one journal', () => {
    const { w: w0, sup, bill } = usdBill();
    const k = 'qa-pur-081-payment';
    const first = pay(w0, sup, [{ invoiceId: bill, amount: '1000' }], '280000', {}, owner, k);
    const retry = pay(first.workspace, sup, [{ invoiceId: bill, amount: '1000' }], '280000', {}, owner, k);
    expect(retry.message).toBe('This operation was already completed.');
    expect(retry.workspace.receipts).toHaveLength(1);
    expect(retry.workspace.journals.filter(j => j.sourceId.endsWith(':cleared'))).toHaveLength(1);
  });

  it('PUR-082 payment note 1,000 chars accepted; 1,001 refused', () => {
    const { w, sup, bill } = usdBill();
    const ok = pay(w, sup, [{ invoiceId: bill, amount: '10' }], '2800', { note: 'n'.repeat(1000) });
    expect(ok.workspace.receipts[0].note).toHaveLength(1000);
    refused(w, 'create_receipt', { partyId: sup, date: today(), amount: '2800', method: 'bank', chequeNo: '', dueDate: today(), allocations: [{ invoiceId: bill, amount: '10' }], employeeId: '', note: 'n'.repeat(1001), accountId: 'main-bank' }, /<=1000 characters/);
  });

  it('PUR-083 outgoing cheque number of 100 chars accepted', () => {
    const { w, sup, bill } = usdBill();
    const r = pay(w, sup, [{ invoiceId: bill, amount: '10' }], '2800', { method: 'cheque', chequeNo: 'C'.repeat(100), accountId: undefined });
    expect(r.workspace.receipts[0].chequeNo).toHaveLength(100);
  });

  it.todo('PUR-084 [browser] payment dialog lists open bills oldest first; typed total spreads oldest first');
  it.todo('PUR-085 [browser] "PKR actually paid" only for non-PKR bills (document-dialogs.tsx shows it only when the supplier has an open foreign-currency bill; engine side: PUR-032)');
  it.todo('PUR-086 [browser] purchase editor usable on phone');

  it('PUR-087 branch-limited Accountant submitting a GRN in another branch refused', () => {
    let { w, item, sup } = base();
    w = secondBranch(w);
    const g = create(w, 'goods_receipt', sup, [L(item, '5')], { warehouseId: 'lahore-store' });
    refused(g.workspace, 'submit_document', { id: g.recordId }, 'This warehouse is outside your permitted branches.', actor('Accountant', { branchIds: ['main'] }));
  });

  it('PUR-088 hidden Purchasing: API refuses purchase documents [browser: view gone]', () => {
    const { w: w0, item, sup } = base();
    const w = run(w0, 'set_modules', { enabled: toggleModules.filter(m => !['purchasing', 'imports'].includes(m)) }).workspace;
    refused(w, 'create_document', { kind: 'purchase_order', partyId: sup, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [L(item)] }, 'Purchasing is turned off for this company. Turn it on in Settings → Features.');
  });

  it('PUR-089 Imports off: shipment commands refused [browser: no shipment button on GRN]', () => {
    const { w: w0, grn } = usdBill();
    const w = run(w0, 'set_modules', { enabled: toggleModules.filter(m => m !== 'imports') }).workspace;
    refused(w, 'create_shipment', { documentId: grn }, 'Imports & costing is turned off for this company. Turn it on in Settings → Features.');
  });

  it('PUR-090 Imports on: shipment can be created from a submitted GRN and bill [browser: "Create shipment" button — code review found no create_shipment call anywhere in src/components]', () => {
    const { w, grn, bill } = usdBill();
    expect(run(w, 'create_shipment', { documentId: grn }).workspace.shipments).toHaveLength(1);
    expect(run(w, 'create_shipment', { documentId: bill }).workspace.shipments).toHaveLength(1);
  });

  it('PUR-091 FX: bill at 280, payment at 285 for $1,000 → loss 5,000; payable cleared exactly', () => {
    const { w: w0, sup, bill } = usdBill();
    const r = pay(w0, sup, [{ invoiceId: bill, amount: '1000' }], '285000');
    expect(byAccount(r.workspace, `${r.recordId}:cleared`)).toEqual({ '2000': '280000.0000', '1001': '-285000.0000', '5400': '5000.0000' });
    expect(accountBalance(r.workspace, '2000')).toBe('0.0000');
    expectInvariants(r.workspace);
  });

  it('PUR-092 FX: payment at 275 → gain 5,000', () => {
    const { w: w0, sup, bill } = usdBill();
    const r = pay(w0, sup, [{ invoiceId: bill, amount: '1000' }], '275000');
    expect(byAccount(r.workspace, `${r.recordId}:cleared`)).toEqual({ '2000': '280000.0000', '1001': '-275000.0000', '5400': '-5000.0000' });
  });

  it('PUR-093 partial FX payments at different rates each compare to the bill rate', () => {
    const { w: w0, sup, bill } = usdBill();
    const a = pay(w0, sup, [{ invoiceId: bill, amount: '400' }], '114000');
    const b = pay(a.workspace, sup, [{ invoiceId: bill, amount: '600' }], '162000');
    expect(byAccount(a.workspace, `${a.recordId}:cleared`)['5400']).toBe('2000.0000');
    expect(byAccount(b.workspace, `${b.recordId}:cleared`)['5400']).toBe('-6000.0000');
    expect(accountBalance(b.workspace, '2000')).toBe('0.0000');
    expectInvariants(b.workspace);
  });

  it('PUR-094 rate with 4 decimals 280.1234 stored', () => {
    const { w: w0, item, sup } = base();
    const r = create(w0, 'purchase_order', sup, [L(item)], { currency: 'USD', fxRate: '280.1234' });
    expect(docOf(r.workspace, r.recordId).fxRate).toBe('280.1234');
  });

  it('PUR-095 rate with 5 decimals is rounded to 4', () => {
    const { w: w0, item, sup } = base();
    const r = create(w0, 'purchase_order', sup, [L(item)], { currency: 'USD', fxRate: '280.12345' });
    expect(docOf(r.workspace, r.recordId).fxRate).toBe('280.1235');
  });

  it('PUR-096 supplier payment print model is a "Payment voucher"', () => {
    const { w: w0, sup, bill } = usdBill();
    const r = pay(w0, sup, [{ invoiceId: bill, amount: '1000' }], '280000');
    const view = receiptView(r.workspace, r.workspace.receipts.find(x => x.id === r.recordId)!);
    expect(view.title).toBe('Payment voucher');
    expect(view.partyLabel).toBe('Paid to');
  });

  it.todo('PUR-097 [browser] 500 POs in the list; filters respond < 1 s');

  it('PUR-098 overview summary computes without error after a purchasing chain [browser: Overview renders]', () => {
    const { w: w0, sup, bill } = usdBill();
    const w = pay(w0, sup, [{ invoiceId: bill, amount: '500' }], '140000').workspace;
    const s = summary(w);
    expect(s.payables).toBe('140000.0000');
    expect(s.inventory).toBe('280000.0000');
  });

  it('PUR-099 aged payables buckets after the chain', () => {
    let { w, item, sup } = base();
    let b1: string, b2: string;
    [w, b1] = createSubmit(w, 'supplier_invoice', sup, [L(item, '1', '1000')], { date: '2026-08-01', dueDate: '2026-08-01' });
    [w, b2] = createSubmit(w, 'supplier_invoice', sup, [L(item, '1', '500')], { date: '2026-10-01', dueDate: '2026-10-31' });
    const aged = agedBalances(w, 'supplier', '2026-10-14');
    expect(aged.totals).toMatchObject({ current: '500.0000', d30: '0.0000', d60: '0.0000', d90: '1000.0000', total: '1500.0000' });
    expect([b1, b2]).toHaveLength(2);
  });

  it('PUR-100 end to end: USD PO → two GRNs → bills → return 1 → payment with FX loss; reconciled', () => {
    let { w, item, sup } = base();
    let po: string, g1: string, g2: string, b1: string, b2: string;
    [w, po] = createSubmit(w, 'purchase_order', sup, [L(item, '100', '10')], USD);
    [w, g1] = convertSubmit(w, po, [L(item, '60', '10')]);
    [w, g2] = convertSubmit(w, po);
    expect(qty(w, item)).toBe('100.0000');
    [w, b1] = convertSubmit(w, g1);
    [w, b2] = convertSubmit(w, g2);
    w = run(w, 'return_document', { id: b1, reason: 'Broken', lines: [{ lineId: docOf(w, b1).lines[0].id, quantity: '1' }] }).workspace;
    expect(qty(w, item)).toBe('99.0000');
    const p = pay(w, sup, [{ invoiceId: b1, amount: '590' }], '168150');
    w = p.workspace;
    expect(byAccount(w, `${p.recordId}:cleared`)['5400']).toBe('2950.0000');
    expect(outstanding(docOf(w, b1))).toBe('0.0000');
    expect(outstanding(docOf(w, b2))).toBe('400.0000');
    expect(D(accountBalance(w, '2000')).negated().toFixed(4)).toBe('112000.0000');
    expect(accountBalance(w, '2010')).toBe('0.0000');
    expectInvariants(w);
  });
});
