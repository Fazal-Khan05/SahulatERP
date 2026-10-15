import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
import { DocumentPreview } from '../../src/components/document-preview';
import { commandSchema } from '../../src/modules/erp/engine';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { documentPartyName, documentView, walkInName } from '../../src/modules/erp/documents';
import { csvFields, customers as customerSpec, suppliers as supplierSpec } from '../../src/modules/erp/master-data';
import { moduleRecordCounts } from '../../src/modules/erp/modules';
import { agedBalances, partyStatement } from '../../src/modules/erp/reports';
import type { Actor, Workspace } from '../../src/modules/erp/types';
import { actor, expectInvariants, firstWarehouse, freshCompany, owner, refused, run, today, withDocument, withItem, withParty } from './helpers';

const customer = (extra: Record<string, unknown> = {}) => ({ ...customerSpec.blank(freshCompany()), name: 'Al-Noor Electronics', ...extra });
const supplier = (extra: Record<string, unknown> = {}) => ({ ...supplierSpec.blank(freshCompany()), name: 'Shenzhen Bright', ...extra });
/** Payload the document editor sends for a new name the user chose to save (document-editor.tsx newParty). */
const editorParty = (name: string, type: 'customer' | 'supplier', city = '', phone = '') => ({ name, type, city, phone, email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: type === 'customer' ? 'Retailer' : 'Importer' });
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const errorOf = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return ''; };

/** A company with 10,000 units in stock at cost 10 and one customer. */
function stocked(customerExtra: Record<string, unknown> = {}) {
  let w = freshCompany(); let item: string;
  [w, item] = withItem(w, { category: 'Lighting' }, { quantity: '10000', cost: '10' });
  const c = run(w, 'save_party', customer(customerExtra));
  return { w: c.workspace, item, cust: c.recordId };
}
const invoiceLines = (item: string, amount: string) => [{ itemId: item, quantity: '1', price: amount }];
function draft(w: Workspace, kind: string, party: string, item: string, amount: string, extra: Record<string, unknown> = {}, who: Actor = owner) {
  return withDocument(w, kind, party, invoiceLines(item, amount), extra, false, who);
}
/** The shared walk-in account as it stands after a first "No, don't save" (the engine creates it inside create_document; see PTY-030). */
function walkIn(w: Workspace, type: 'customer' | 'supplier', who: Actor = owner): [Workspace, string] {
  const name = walkInName(type);
  const shared = w.parties.find(p => p.type === type && p.name.trim().toLowerCase() === name.toLowerCase());
  if (shared) return [w, shared.id];
  const created = run(w, 'save_party', editorParty(name, type), who);
  return [created.workspace, created.recordId];
}
const salesperson: Actor = actor('Salesperson', { employeeId: 'e-sp' });

describe('05 parties (PTY)', () => {
  it('PTY-001 new customer with name only saves with the form defaults (Retailer, 30 days, no limit)', () => {
    const r = run(freshCompany(), 'save_party', customer());
    expect(r.message).toBe('Al-Noor Electronics saved.');
    expect(r.workspace.parties[0]).toMatchObject({ type: 'customer', customerClass: 'Retailer', terms: 30, creditLimit: '0', registered: false, phone: '' });
  });

  it('PTY-002 empty or one-character name refused', () => {
    refused(freshCompany(), 'save_party', customer({ name: '' }), />=2 characters/);
    refused(freshCompany(), 'save_party', customer({ name: 'A' }), />=2 characters/);
  });

  it('PTY-003 duplicate customer name in another case: "A customer named X already exists."', () => {
    const w = run(freshCompany(), 'save_party', customer()).workspace;
    refused(w, 'save_party', customer({ name: 'al-noor electronics' }), 'A customer named al-noor electronics already exists.');
  });

  it('PTY-004 a customer may share a supplier\'s name', () => {
    const w = run(freshCompany(), 'save_party', supplier({ name: 'Al-Noor Electronics' })).workspace;
    expect(run(w, 'save_party', customer()).workspace.parties.map(p => p.type)).toEqual(['supplier', 'customer']);
  });

  it('PTY-005 trailing spaces are trimmed and the duplicate check uses the trimmed name', () => {
    const w = run(freshCompany(), 'save_party', customer({ name: 'Ali Traders   ' })).workspace;
    expect(w.parties[0].name).toBe('Ali Traders');
    refused(w, 'save_party', customer({ name: '  Ali Traders' }), 'A customer named Ali Traders already exists.');
  });

  it('PTY-006 120-character name accepted; 121 refused', () => {
    expect(run(freshCompany(), 'save_party', customer({ name: 'C'.repeat(120) })).workspace.parties[0].name).toHaveLength(120);
    refused(freshCompany(), 'save_party', customer({ name: 'C'.repeat(121) }), /<=120 characters/);
  });

  it('PTY-007 terms 0 days saved; the editor sets due date = invoice date + terms [browser part: due-date field]', () => {
    expect(run(freshCompany(), 'save_party', customer({ terms: 0 })).workspace.parties[0].terms).toBe(0);
    expect(source('src/components/document-editor.tsx')).toContain('if (party && !dueTouched) setDueDate(addDays(date, party.terms));');
  });

  it('PTY-008 terms 365 accepted (366 refused) [browser part: due date a year later]', () => {
    expect(run(freshCompany(), 'save_party', customer({ terms: 365 })).workspace.parties[0].terms).toBe(365);
    refused(freshCompany(), 'save_party', customer({ terms: 366 }), /<=365/);
  });

  it('PTY-009 terms -1 refused', () => {
    refused(freshCompany(), 'save_party', customer({ terms: -1 }), />=0/);
  });

  it('PTY-010 terms 2.5 refused (integer)', () => {
    refused(freshCompany(), 'save_party', customer({ terms: 2.5 }), /expected int/);
  });

  it('PTY-011 credit limit 0 means no credit check', () => {
    const { w, item, cust } = stocked({ creditLimit: '0' });
    const [after] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '9999999'));
    expect(after.documents[0].status).toBe('submitted');
  });

  it('PTY-012 limit 100,000 with 90,000 outstanding: a 20,000 invoice is refused "Customer credit limit exceeded. An owner must enter an override reason."', () => {
    let { w, item, cust } = stocked({ creditLimit: '100000' });
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '90000'));
    let id: string;
    [w, id] = draft(w, 'sales_invoice', cust, item, '20000');
    refused(w, 'submit_document', { id }, 'Customer credit limit exceeded. An owner must enter an override reason.');
  });

  it('PTY-013 the same invoice with an Owner override reason submits and the reason is stored on the invoice', () => {
    let { w, item, cust } = stocked({ creditLimit: '100000' });
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '90000'));
    let id: string;
    [w, id] = draft(w, 'sales_invoice', cust, item, '20000', { creditOverride: 'Long-standing customer; cheque promised' });
    w = run(w, 'submit_document', { id }).workspace;
    expect(w.documents.find(d => d.id === id)).toMatchObject({ status: 'submitted', creditOverride: 'Long-standing customer; cheque promised' });
    expectInvariants(w);
  });

  it('PTY-014 an Accountant\'s override reason is still refused (owner only)', () => {
    let { w, item, cust } = stocked({ creditLimit: '100000' });
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '90000'));
    let id: string;
    [w, id] = draft(w, 'sales_invoice', cust, item, '20000', { creditOverride: 'Accountant says ok' }, actor('Accountant'));
    refused(w, 'submit_document', { id }, 'Customer credit limit exceeded.', actor('Accountant'));
  });

  it('PTY-015 exposure + invoice exactly equal to the limit is allowed', () => {
    let { w, item, cust } = stocked({ creditLimit: '100000' });
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '90000'));
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '10000'));
    expect(w.documents.filter(d => d.status === 'submitted')).toHaveLength(2);
  });

  it('PTY-016 limit exceeded by 0.0001 is refused', () => {
    let { w, item, cust } = stocked({ creditLimit: '100000' });
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '90000'));
    let id: string;
    [w, id] = draft(w, 'sales_invoice', cust, item, '10000.0001');
    refused(w, 'submit_document', { id }, 'Customer credit limit exceeded.');
  });

  it('PTY-017 credit check counts submitted invoices net of returns', () => {
    let { w, item, cust } = stocked({ creditLimit: '100000' });
    let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '900', price: '100' }]);
    w = run(w, 'return_document', { id: inv, lines: [{ lineId: w.documents[0].lines[0].id, quantity: '300' }] }).workspace;
    [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '400', price: '100' }]);
    expect(w.documents.filter(d => d.kind === 'sales_invoice' && d.status === 'submitted')).toHaveLength(2);
    expectInvariants(w);
  });

  it('PTY-018 credit check ignores drafts', () => {
    let { w, item, cust } = stocked({ creditLimit: '100000' });
    [w] = draft(w, 'sales_invoice', cust, item, '90000');
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '100000'));
    expect(w.documents.filter(d => d.status === 'submitted')).toHaveLength(1);
  });

  it('PTY-019 registered customer with tax id: the invoice tax snapshot marks registered', () => {
    let { w, item, cust } = stocked({ registered: true, taxId: '1234567-8' });
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '100'));
    expect(w.documents[0].taxSnapshot).toMatchObject({ registered: true, taxId: '1234567-8' });
  });

  it('PTY-020 registered with an empty tax id is allowed; the print shows no tax line', () => {
    let { w, item, cust } = stocked({ registered: true, taxId: '' });
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '100'));
    expect(documentView(w, w.documents[0]).party.taxId).toBe('');
  });

  it('PTY-021 customer class drives a class-based commission plan', () => {
    let { w, item, cust } = stocked({ customerClass: 'Wholesaler' });
    w = run(w, 'save_plan', { ...w.plans[0], type: 'customer_class', rate: '1', classRates: { Wholesaler: '4', Retailer: '2' } }).workspace;
    const emp = run(w, 'save_employee', { name: 'Sara Malik', role: 'ASM', territory: 'Karachi', salary: '0', allowance: '0', deduction: '0', attendance: 30, active: true });
    [w] = withDocument(emp.workspace, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '1000', employeeId: emp.recordId }]);
    expect(w.commissions[0].earned).toBe('40.0000');
  });

  it('PTY-022 invalid email is validated (refused "Invalid email address"), consistently with CSV import [documented]', () => {
    refused(freshCompany(), 'save_party', customer({ email: 'accounts@' }), 'Invalid email address');
    refused(freshCompany(), 'import_records', { kind: 'customers', rows: [{ name: 'Bad Mail', email: 'accounts@' }] }, /Row 2:[\s\S]*Invalid email address/);
  });

  it('PTY-023 phone "0300-1234567" saved and listed [case-corrected: party phone is not printed on documents (print shows name, city, email, NTN)]', () => {
    let { w, item, cust } = stocked({ phone: '0300-1234567' });
    expect(w.parties[0].phone).toBe('0300-1234567');
    expect(customerSpec.columns.map(c => c.key)).toContain('phone');
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '100'));
    expect(JSON.stringify(documentView(w, w.documents[0]))).not.toContain('0300-1234567');
  });

  it('PTY-024 changing a customer to supplier via API: "A party\'s type cannot be changed."', () => {
    const r = run(freshCompany(), 'save_party', customer());
    refused(r.workspace, 'save_party', customer({ id: r.recordId, type: 'supplier' }), "A party's type cannot be changed.");
  });

  it('PTY-025 archiving hides the customer from invoice suggestions', () => {
    const r = run(freshCompany(), 'save_party', customer());
    const a = run(r.workspace, 'set_archived', { kind: 'party', id: r.recordId, archived: true });
    expect(a.message).toBe('Al-Noor Electronics archived. History is kept; it no longer appears in new documents.');
    expect(source('src/components/document-editor.tsx')).toContain('const parties = workspace.parties.filter(p => !p.archived && p.type === partyType);');
  });

  it('PTY-026 creating a document for an archived customer via API: "{name} is archived. Restore it first."', () => {
    let { w, item, cust } = stocked();
    w = run(w, 'set_archived', { kind: 'party', id: cust, archived: true }).workspace;
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '1', price: '1', taxRate: '0' }] }, 'Al-Noor Electronics is archived. Restore it first.');
  });

  it('PTY-027 archiving a customer with an outstanding balance is allowed; receivables still include them', () => {
    let { w, item, cust } = stocked();
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '5000'));
    w = run(w, 'set_archived', { kind: 'party', id: cust, archived: true }).workspace;
    expect(agedBalances(w, 'customer', today()).rows).toEqual([expect.objectContaining({ partyId: cust, total: '5000.0000' })]);
    expectInvariants(w);
  });

  it('PTY-028 restoring brings the customer back', () => {
    const r = run(freshCompany(), 'save_party', customer());
    const back = run(run(r.workspace, 'set_archived', { kind: 'party', id: r.recordId, archived: true }).workspace, 'set_archived', { kind: 'party', id: r.recordId, archived: false });
    expect(back.message).toBe('Al-Noor Electronics restored.');
    expect('archived' in back.workspace.parties[0]).toBe(false);
  });

  it('PTY-029 Recovery Officer creating a customer is refused (save_party is Accountant/Sales Manager/Warehouse Manager/Owner)', () => {
    refused(freshCompany(), 'save_party', customer(), 'Your role does not permit this action.', actor('Recovery Officer'));
    expect(run(freshCompany(), 'save_party', customer(), actor('Sales Manager')).workspace.parties).toHaveLength(1);
  });

  it('PTY-030 Salesperson: "Yes, save customer" is refused, and the "No" path still works on a company without a walk-in account', () => {
    refused(freshCompany(), 'save_party', editorParty('Rashid', 'customer'), 'Your role does not permit this action.', salesperson);
    // "No, don't save" sends create_document with walkIn + partyName (document-editor.tsx); the engine creates the shared account itself.
    let { w, item } = stocked();
    w = run(w, 'save_employee', { id: 'e-sp', name: 'Sana Salesperson', role: 'Salesperson', territory: 'Karachi', salary: '0', allowance: '0', deduction: '0', attendance: 30, active: true }).workspace;
    let created: ReturnType<typeof run> | undefined;
    const noPath = errorOf(() => { created = run(w, 'create_document', { kind: 'sales_invoice', walkIn: true, partyName: 'Rashid', warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '1', price: '100', taxRate: '0', employeeId: 'e-sp' }] }, salesperson); });
    expect(noPath, 'first "No" as Salesperson must not need save_party').toBe('');
    const shared = created!.workspace.parties.find(p => p.name === 'Walk-in customer')!;
    expect(created!.workspace.documents[0]).toMatchObject({ partyId: shared.id, partyName: 'Rashid' });
    expect(source('src/components/document-editor.tsx')).toContain('...(partyId ? { partyId } : { walkIn: true })');
  });

  it.todo('PTY-031 [browser] typing an existing name exactly matches it; hint shows city/phone/terms; no prompt');
  it.todo('PTY-032 [browser] typing an existing name in a different case matches it');
  it.todo('PTY-033 [browser] typing a new name then Submit opens "Save customer?" with No/Yes');

  it('PTY-034 "Yes, save customer" creates the customer with city/phone and books the invoice to it [browser part: dialog]', () => {
    let w = stocked().w; const item = w.items[0].id;
    const created = run(w, 'save_party', editorParty('Rashid Traders', 'customer', 'Hyderabad', '0300-7654321'));
    w = created.workspace;
    expect(w.parties.find(p => p.id === created.recordId)).toMatchObject({ city: 'Hyderabad', phone: '0300-7654321', terms: 30, customerClass: 'Retailer' });
    [w] = withDocument(w, 'sales_invoice', created.recordId, invoiceLines(item, '100'));
    expect(w.documents[0].partyId).toBe(created.recordId);
    expect(w.documents[0].partyName).toBeUndefined();
  });

  it('PTY-035 "No, don\'t save" books to "Walk-in customer" with the typed name shown in lists and print; no customer created [browser part: dialog]', () => {
    let w = stocked().w; const item = w.items[0].id; let shared: string;
    const partiesBefore = w.parties.length;
    [w, shared] = walkIn(w, 'customer');
    [w] = withDocument(w, 'sales_invoice', shared, invoiceLines(item, '100'), { partyName: 'Rashid' });
    expect(w.parties.length).toBe(partiesBefore + 1);
    expect(w.parties.find(p => p.id === shared)!.name).toBe('Walk-in customer');
    expect(documentPartyName(w, w.documents[0])).toBe('Rashid');
    expect(documentView(w, w.documents[0]).party.name).toBe('Rashid');
  });

  it('PTY-036 the first "No" creates the "Walk-in customer" account automatically', () => {
    const [w, shared] = walkIn(freshCompany(), 'customer');
    expect(w.parties).toEqual([expect.objectContaining({ id: shared, name: 'Walk-in customer', type: 'customer' })]);
  });

  it('PTY-037 a second "No" reuses the same walk-in account (count stays 1)', () => {
    let w = stocked().w; const item = w.items[0].id; let first: string, second: string;
    [w, first] = walkIn(w, 'customer');
    [w] = withDocument(w, 'sales_invoice', first, invoiceLines(item, '100'), { partyName: 'Rashid' });
    [w, second] = walkIn(w, 'customer');
    expect(second).toBe(first);
    expect(w.parties.filter(p => p.name === 'Walk-in customer')).toHaveLength(1);
  });

  it('PTY-038 archived walk-in account then "No": refused with a restore hint', () => {
    let [w, shared] = walkIn(stocked().w, 'customer');
    w = run(w, 'set_archived', { kind: 'party', id: shared, archived: true }).workspace;
    expect(source('src/components/document-editor.tsx')).toContain("if (shared?.archived) return setError(`${walkIn} is archived. Restore it in ${sales ? 'Sales → Customers' : 'Purchasing → Suppliers'} first.`);");
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: shared, partyName: 'Rashid', warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [{ itemId: w.items[0].id, quantity: '1', price: '1', taxRate: '0' }] }, 'Walk-in customer is archived. Restore it first.');
  });

  it('PTY-039 typing "Walk-in customer" exactly matches the shared account and stores no display name', () => {
    let [w, shared] = walkIn(stocked().w, 'customer');
    [w] = withDocument(w, 'sales_invoice', shared, invoiceLines(w.items[0].id, '100'), { partyName: 'walk-in customer' });
    expect(w.documents[0].partyName).toBeUndefined();
  });

  it('PTY-040 after "No", a failed submit keeps the draft and a retry updates the same draft [browser part: no second prompt]', () => {
    let { w, item } = stocked(); let shared: string, id: string;
    [w, shared] = walkIn(w, 'customer');
    [w, id] = withDocument(w, 'sales_invoice', shared, [{ itemId: item, quantity: '20000', price: '1' }], { partyName: 'Rashid' }, false);
    refused(w, 'submit_document', { id }, /Insufficient stock/);
    w = run(w, 'update_document', { id, partyId: shared, partyName: 'Rashid', warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '2', price: '1', taxRate: '0' }] }).workspace;
    w = run(w, 'submit_document', { id }).workspace;
    expect(w.documents).toHaveLength(1);
    expect(w.documents[0]).toMatchObject({ status: 'submitted', partyName: 'Rashid' });
  });

  it.todo('PTY-041 [browser] changing the name after answering asks again for the new name');

  it('PTY-042 editing a walk-in draft keeps the typed name', () => {
    let { w, item } = stocked(); let shared: string, id: string;
    [w, shared] = walkIn(w, 'customer');
    [w, id] = withDocument(w, 'sales_invoice', shared, invoiceLines(item, '100'), { partyName: 'Rashid' }, false);
    w = run(w, 'update_document', { id, partyId: shared, partyName: 'Rashid', warehouseId: firstWarehouse(w), date: today(), dueDate: today(), notes: 'edited', lines: [{ itemId: item, quantity: '3', price: '100', taxRate: '0' }] }).workspace;
    expect(w.documents[0]).toMatchObject({ partyName: 'Rashid', notes: 'edited' });
  });

  it('PTY-043 converting a walk-in order → delivery → invoice carries the typed name', () => {
    let { w, item } = stocked(); let shared: string, so: string;
    [w, shared] = walkIn(w, 'customer');
    [w, so] = withDocument(w, 'sales_order', shared, invoiceLines(item, '100'), { partyName: 'Rashid' });
    const dn = run(w, 'convert_document', { id: so });
    w = run(dn.workspace, 'submit_document', { id: dn.recordId }).workspace;
    const inv = run(w, 'convert_document', { id: dn.recordId });
    w = run(inv.workspace, 'submit_document', { id: inv.recordId }).workspace;
    expect(w.documents.map(d => [d.kind, d.partyName])).toEqual([['sales_order', 'Rashid'], ['delivery', 'Rashid'], ['sales_invoice', 'Rashid']]);
    expectInvariants(w);
  });

  it('PTY-044 the credit note for a walk-in invoice shows the typed name', () => {
    let { w, item } = stocked(); let shared: string, inv: string;
    [w, shared] = walkIn(w, 'customer');
    [w, inv] = withDocument(w, 'sales_invoice', shared, [{ itemId: item, quantity: '2', price: '100' }], { partyName: 'Rashid' });
    const cn = run(w, 'return_document', { id: inv, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '1' }] });
    const note = cn.workspace.documents.find(d => d.id === cn.recordId)!;
    expect(documentView(cn.workspace, note).party.name).toBe('Rashid');
  });

  it('PTY-045 a receipt against a walk-in invoice is recorded on "Walk-in customer" [browser part: open invoices listed by number]', () => {
    let { w, item } = stocked(); let shared: string, inv: string;
    [w, shared] = walkIn(w, 'customer');
    [w, inv] = withDocument(w, 'sales_invoice', shared, invoiceLines(item, '500'), { partyName: 'Rashid' });
    w = run(w, 'create_receipt', { partyId: shared, date: today(), amount: '500', method: 'cash', dueDate: today(), allocations: [{ invoiceId: inv, amount: '500' }] }).workspace;
    expect(w.documents.find(d => d.id === inv)!.paid).toBe('500.0000');
    expectInvariants(w);
  });

  it('PTY-046 the Walk-in customer statement lists all walk-in invoices together [documented]', () => {
    let { w, item } = stocked(); let shared: string;
    [w, shared] = walkIn(w, 'customer');
    [w] = withDocument(w, 'sales_invoice', shared, invoiceLines(item, '100'), { partyName: 'Rashid' });
    [w] = withDocument(w, 'sales_invoice', shared, invoiceLines(item, '250'), { partyName: 'Bilal' });
    const st = partyStatement(w, shared, '2000-01-01', '2999-12-31');
    expect(st.lines).toHaveLength(2);
    expect(st.closing).toBe('350.0000');
  });

  it('PTY-047 a walk-in invoice is searchable by the typed name (list search uses documentPartyName) [browser part: header search]', () => {
    let { w, item } = stocked(); let shared: string;
    [w, shared] = walkIn(w, 'customer');
    [w] = withDocument(w, 'sales_invoice', shared, invoiceLines(item, '100'), { partyName: 'Rashid' });
    expect(documentPartyName(w, w.documents[0]).toLocaleLowerCase()).toContain('rashid');
    expect(source('src/components/documents-list.tsx')).toContain('documentPartyName(workspace, d)}`.toLocaleLowerCase().includes(needle)');
  });

  it.todo('PTY-048 [browser] typed name with extra inner spaces is not matched and prompts');

  it('PTY-049 typed walk-in name of 121 characters refused (max 120)', () => {
    let { w, item } = stocked(); let shared: string;
    [w, shared] = walkIn(w, 'customer');
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: shared, partyName: 'R'.repeat(121), warehouseId: firstWarehouse(w), date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '1', price: '1', taxRate: '0' }] }, /"partyName"[\s\S]*<=120 characters/);
  });

  it('PTY-050 typed name containing <b> is printed as text', () => {
    let { w, item } = stocked(); let shared: string;
    [w, shared] = walkIn(w, 'customer');
    [w] = withDocument(w, 'sales_invoice', shared, invoiceLines(item, '100'), { partyName: '<b>Rashid</b>' });
    const html = renderToStaticMarkup(createElement(DocumentPreview, { view: documentView(w, w.documents[0]), company: w.company, branding: w.branding, assets: {} }));
    expect(html).toContain('&lt;b&gt;Rashid&lt;/b&gt;');
    expect(html).not.toContain('<b>Rashid</b>');
  });

  it('PTY-051 supplier flow uses "Walk-in supplier" and prints the typed name on the PO [browser part: "Save supplier?" dialog]', () => {
    let { w, item } = stocked(); let shared: string;
    [w, shared] = walkIn(w, 'supplier');
    expect(w.parties.find(p => p.id === shared)).toMatchObject({ name: 'Walk-in supplier', type: 'supplier', customerClass: 'Importer' });
    [w] = withDocument(w, 'purchase_order', shared, invoiceLines(item, '100'), { partyName: 'Karachi Packers' }, false);
    expect(documentView(w, w.documents.at(-1)!).party.name).toBe('Karachi Packers');
  });

  it('PTY-052 a new supplier saved from the PO editor gets class Importer and 30-day terms', () => {
    const r = run(freshCompany(), 'save_party', editorParty('Karachi Packers', 'supplier'));
    expect(r.workspace.parties[0]).toMatchObject({ type: 'supplier', customerClass: 'Importer', terms: 30 });
  });

  it.todo('PTY-053 [browser] closing the Save dialog (X) returns to the editor with nothing saved');
  it.todo('PTY-054 [browser] dialog copy mentions the typed name and the walk-in account');

  it('PTY-055 hint under a new name reads "New customer. You can choose whether to save them." [browser part: placement]', () => {
    expect(source('src/components/document-editor.tsx')).toContain('New {partyType}. You can choose whether to save them.');
  });

  it.todo('PTY-056 [browser] city and phone fields appear only for new names');

  it('PTY-057 customer list search matches city', () => {
    const w = run(run(freshCompany(), 'save_party', customer({ city: 'Multan' })).workspace, 'save_party', customer({ name: 'Metro Home', city: 'Lahore' })).workspace;
    expect(w.parties.filter(p => customerSpec.searchText(p, w).toLocaleLowerCase().includes('multan')).map(p => p.name)).toEqual(['Al-Noor Electronics']);
  });

  it('PTY-058 customer CSV export columns', () => {
    expect(csvFields(customerSpec as never).map(f => f.key)).toEqual(['name', 'city', 'phone', 'email', 'taxId', 'registered', 'customerClass', 'creditLimit', 'terms']);
  });

  it('PTY-059 valid customer CSV import creates the customers', () => {
    const r = run(freshCompany(), 'import_records', { kind: 'customers', rows: [{ name: 'Alpha Traders', city: 'Karachi', creditLimit: '50000', terms: '15' }, { name: 'Beta Stores' }] });
    expect(r.message).toBe('Imported 2 customers: 2 created, 0 updated.');
    expect(r.workspace.parties[0]).toMatchObject({ creditLimit: '50000', terms: 15, customerClass: 'Retailer' });
  });

  it('PTY-060 duplicate name in the file is a row error [case-corrected: message is "X appears more than once in the file" without the "customer" prefix]', () => {
    refused(freshCompany(), 'import_records', { kind: 'customers', rows: [{ name: 'Alpha' }, { name: 'alpha' }] }, 'Row 3: alpha appears more than once in the file');
  });

  it('PTY-061 existing name in create mode: "customer X already exists"', () => {
    const w = run(freshCompany(), 'save_party', customer()).workspace;
    refused(w, 'import_records', { kind: 'customers', rows: [{ name: 'Al-Noor Electronics' }] }, 'Row 2: customer Al-Noor Electronics already exists');
  });

  it('PTY-062 update mode updates by name', () => {
    const w = run(freshCompany(), 'save_party', customer({ city: 'Karachi' })).workspace;
    const r = run(w, 'import_records', { kind: 'customers', mode: 'upsert', rows: [{ name: 'al-noor electronics', city: 'Hyderabad' }] });
    expect(r.message).toBe('Imported 1 customers: 0 created, 1 updated.');
    expect(r.workspace.parties).toEqual([expect.objectContaining({ id: w.parties[0].id, city: 'Hyderabad' })]);
  });

  it('PTY-063 credit limit "abc" in a row is a row error', () => {
    refused(freshCompany(), 'import_records', { kind: 'customers', rows: [{ name: 'Alpha', creditLimit: 'abc' }] }, /^Nothing was imported[\s\S]*Row 2:/);
  });

  it('PTY-064 terms -5 in a row is a row error', () => {
    refused(freshCompany(), 'import_records', { kind: 'customers', rows: [{ name: 'Alpha', terms: '-5' }] }, /Row 2:[\s\S]*>=0/);
  });

  it('PTY-065 registered "yes", "true" and "1" all import as true', () => {
    const w = run(freshCompany(), 'import_records', { kind: 'customers', rows: [{ name: 'Aa', registered: 'yes' }, { name: 'Bb', registered: 'TRUE' }, { name: 'Cc', registered: '1' }, { name: 'Dd', registered: 'no' }] }).workspace;
    expect(w.parties.map(p => p.registered)).toEqual([true, true, true, false]);
  });

  it('PTY-066 importing 500 customers works', () => {
    const r = run(freshCompany(), 'import_records', { kind: 'customers', rows: Array.from({ length: 500 }, (_, i) => ({ name: `Customer ${i + 1}`, city: 'Karachi' })) });
    expect(r.workspace.parties).toHaveLength(500);
  });

  it('PTY-067 suppliers are a separate list spec [browser part: Purchasing tab]', () => {
    let w = run(freshCompany(), 'save_party', customer()).workspace;
    w = run(w, 'save_party', supplier()).workspace;
    expect([customerSpec.records(w).map(p => p.name), supplierSpec.records(w).map(p => p.name)]).toEqual([['Al-Noor Electronics'], ['Shenzhen Bright']]);
    expect(supplierSpec.label).toBe('Suppliers');
  });

  it('PTY-068 supplier terms 60 saved [browser part: bill due date = date + 60]', () => {
    expect(run(freshCompany(), 'save_party', supplier({ terms: 60 })).workspace.parties[0].terms).toBe(60);
  });

  it('PTY-069 a supplier credit limit is ignored for purchases (no supplier credit check)', () => {
    let { w, item } = stocked();
    const s = run(w, 'save_party', supplier({ creditLimit: '100' }));
    [w] = withDocument(s.workspace, 'supplier_invoice', s.recordId, invoiceLines(item, '500000'));
    expect(w.documents.at(-1)!.status).toBe('submitted');
  });

  it('PTY-070 a quotation for a 0-day-terms customer may be due the same day; no validity logic', () => {
    let { w, item, cust } = stocked({ terms: 0 });
    [w] = withDocument(w, 'quotation', cust, invoiceLines(item, '100'));
    expect(w.documents[0]).toMatchObject({ status: 'submitted', date: today(), dueDate: today() });
  });

  it('PTY-071 there is no delete command for customers, only archive [browser part: no delete control]', () => {
    const types = commandSchema.shape.type.options as readonly string[];
    expect(types.filter(t => t.startsWith('delete'))).toEqual([]);
    expect(types).toContain('set_archived');
  });

  it('PTY-072 archiving a customer keeps historical invoices and the statement', () => {
    let { w, item, cust } = stocked();
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '700'));
    const before = partyStatement(w, cust, '2000-01-01', '2999-12-31');
    w = run(w, 'set_archived', { kind: 'party', id: cust, archived: true }).workspace;
    expect(w.documents).toHaveLength(1);
    expect(partyStatement(w, cust, '2000-01-01', '2999-12-31')).toEqual(before);
  });

  it('PTY-073 the Features count of customers includes archived ones [documented: counts all]', () => {
    let w = run(run(freshCompany(), 'save_party', customer()).workspace, 'save_party', customer({ name: 'Metro Home' })).workspace;
    w = run(w, 'set_archived', { kind: 'party', id: w.parties[0].id, archived: true }).workspace;
    expect(moduleRecordCounts(w, 'sales')[1]).toEqual({ label: 'customers', count: 2 });
  });

  it.todo('PTY-074 [browser] customers table phone column scrolls at phone width');
  it.todo('PTY-075 [browser] receipt dialog lists only customers');
  it.todo('PTY-076 [browser] payment dialog lists only suppliers');
  it.todo('PTY-077 [browser] follow-up dialog lists customers only');

  it('PTY-078 Salesperson receives the customer list (view) and no suppliers', () => {
    let w = run(freshCompany(), 'save_party', customer()).workspace;
    w = run(w, 'save_party', supplier()).workspace;
    expect(scopeWorkspace(w, salesperson).parties.map(p => p.type)).toEqual(['customer']);
  });

  it('PTY-079 Warehouse Manager may archive a customer (access list)', () => {
    const r = run(freshCompany(), 'save_party', customer());
    expect(run(r.workspace, 'set_archived', { kind: 'party', id: r.recordId, archived: true }, actor('Warehouse Manager')).workspace.parties[0].archived).toBe(true);
  });

  it('PTY-080 credit limit 1e12 refused (below one trillion rule)', () => {
    refused(freshCompany(), 'save_party', customer({ creditLimit: '1e12' }), 'Enter a valid number below one trillion.');
  });

  it('PTY-081 credit limit 0.5 accepted', () => {
    expect(run(freshCompany(), 'save_party', customer({ creditLimit: '0.5' })).workspace.parties[0].creditLimit).toBe('0.5');
  });

  it('PTY-082 credit override reason of 500 characters accepted; 501 refused', () => {
    const { w, item, cust } = stocked();
    expect(draft(w, 'sales_invoice', cust, item, '100', { creditOverride: 'R'.repeat(500) })[0].documents[0].creditOverride).toHaveLength(500);
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), creditOverride: 'R'.repeat(501), lines: [{ itemId: item, quantity: '1', price: '1', taxRate: '0' }] }, /"creditOverride"[\s\S]*<=500 characters/);
  });

  it('PTY-083 an empty (or blank) override reason with the limit exceeded is refused', () => {
    let { w, item, cust } = stocked({ creditLimit: '1000' });
    let id: string;
    [w, id] = draft(w, 'sales_invoice', cust, item, '2000', { creditOverride: '   ' });
    refused(w, 'submit_document', { id }, 'Customer credit limit exceeded. An owner must enter an override reason.');
  });

  it('PTY-084 a quotation over the credit limit is not checked', () => {
    let { w, item, cust } = stocked({ creditLimit: '1000' });
    [w] = withDocument(w, 'quotation', cust, invoiceLines(item, '5000'));
    expect(w.documents[0].status).toBe('submitted');
  });

  it('PTY-085 a sales order over the credit limit is not checked [documented: the check applies to sales invoices only]', () => {
    let { w, item, cust } = stocked({ creditLimit: '1000' });
    [w] = withDocument(w, 'sales_order', cust, invoiceLines(item, '5000'));
    expect(w.documents[0].status).toBe('submitted');
  });

  it('PTY-086 renaming a customer changes the name on existing invoices [documented: no name snapshot on documents]', () => {
    let { w, item, cust } = stocked();
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '100'));
    w = run(w, 'save_party', customer({ id: cust, name: 'Al-Noor Electronics (Pvt) Ltd' })).workspace;
    expect(documentView(w, w.documents[0]).party.name).toBe('Al-Noor Electronics (Pvt) Ltd');
  });

  it('PTY-087 after renaming the walk-in account, the next "No" creates a fresh "Walk-in customer" [documented: lookup is by name]', () => {
    let [w, shared] = walkIn(freshCompany(), 'customer');
    w = run(w, 'save_party', { ...editorParty('Cash sales', 'customer'), id: shared }).workspace;
    const [after, next] = walkIn(w, 'customer');
    expect(next).not.toBe(shared);
    expect(after.parties.map(p => p.name)).toEqual(['Cash sales', 'Walk-in customer']);
  });

  it.todo('PTY-088 [browser] with "Ali Traders" and "Ali Traders Ltd", typing "Ali Traders" matches the exact one');
  it.todo('PTY-089 [browser] datalist suggestions show city · phone');
  it.todo('PTY-090 [browser] suggestions on iOS Safari: datalist works or free text still saves');

  it('PTY-091 a pasted name with a trailing newline is trimmed', () => {
    expect(run(freshCompany(), 'save_party', customer({ name: 'Rashid Traders\n' })).workspace.parties[0].name).toBe('Rashid Traders');
  });

  it('PTY-092 save_party with type "employee" is a validation error', () => {
    refused(freshCompany(), 'save_party', customer({ type: 'employee' }), /"type"[\s\S]*Invalid option/);
  });

  it('PTY-093 save_party with another tenant\'s id [case-corrected: the id is treated as a new record in this tenant; no other tenant\'s data is read or changed]', () => {
    const other = run(freshCompany(), 'save_party', customer({ name: 'Other tenant customer' }));
    const mine = freshCompany();
    const r = run(mine, 'save_party', customer({ id: other.recordId, name: 'My customer' }));
    expect(r.workspace.parties).toEqual([expect.objectContaining({ id: other.recordId, name: 'My customer' })]);
    expect(other.workspace.parties[0].name).toBe('Other tenant customer');
  });

  it('PTY-094 a party created from the invoice path is audited as save_party', () => {
    const w = run(freshCompany(), 'save_party', editorParty('Rashid Traders', 'customer'), actor('Sales Manager')).workspace;
    expect(w.audit.at(-1)).toMatchObject({ action: 'save_party', role: 'Sales Manager', detail: 'Rashid Traders saved.' });
  });

  it('PTY-095 free-text class "VIP" saved and usable by a class plan', () => {
    let { w, item, cust } = stocked({ customerClass: 'VIP' });
    w = run(w, 'save_plan', { ...w.plans[0], type: 'customer_class', rate: '1', classRates: { VIP: '6' } }).workspace;
    const emp = run(w, 'save_employee', { name: 'Sara Malik', role: 'ASM', territory: 'Karachi', salary: '0', allowance: '0', deduction: '0', attendance: 30, active: true });
    [w] = withDocument(emp.workspace, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '1000', employeeId: emp.recordId }]);
    expect(w.parties[0].customerClass).toBe('VIP');
    expect(w.commissions[0].earned).toBe('60.0000');
  });

  it('PTY-096 tax id with spaces saved as typed', () => {
    expect(run(freshCompany(), 'save_party', customer({ taxId: ' 1234567 - 8 ' })).workspace.parties[0].taxId).toBe(' 1234567 - 8 ');
  });

  it('PTY-097 an invoice\'s registered tax snapshot is unchanged after the customer becomes unregistered', () => {
    let { w, item, cust } = stocked({ registered: true, taxId: '1234567-8' });
    [w] = withDocument(w, 'sales_invoice', cust, invoiceLines(item, '100'));
    w = run(w, 'save_party', customer({ id: cust, registered: false, taxId: '' })).workspace;
    expect(w.documents[0].taxSnapshot).toMatchObject({ registered: true, taxId: '1234567-8' });
  });

  it.todo('PTY-098 [browser] 10,000 customers: suggestion datalist still usable (capped at 50 and filtered by the typed text in document-editor.tsx)');

  it('PTY-099 supplier statement shows bill, return and payment with a running balance (payment reduces the balance) [defect]', () => {
    let { w, item } = stocked(); let bill: string;
    const s = run(w, 'save_party', supplier());
    [w, bill] = withDocument(s.workspace, 'supplier_invoice', s.recordId, [{ itemId: item, quantity: '10', price: '100' }]);
    w = run(w, 'return_document', { id: bill, lines: [{ lineId: w.documents.find(d => d.id === bill)!.lines[0].id, quantity: '2' }] }).workspace;
    w = run(w, 'create_receipt', { partyId: s.recordId, date: today(), amount: '500', method: 'bank', dueDate: today(), allocations: [{ invoiceId: bill, amount: '500' }] }).workspace;
    const st = partyStatement(w, s.recordId, '2000-01-01', '2999-12-31');
    expect(st.lines.map(l => [l.description, l.balance])).toEqual([['Supplier bill', '1000.0000'], ['Return to supplier', '800.0000'], ['Payment · bank', '300.0000']]);
    expectInvariants(w);
  });

  it('PTY-100 end to end: new customer via "Yes", limit 50,000, 60,000 invoice refused, owner override, receipt clears, statement balances', () => {
    let w = stocked().w; const item = w.items[0].id;
    const created = run(w, 'save_party', editorParty('Rashid Traders', 'customer', 'Hyderabad'));
    w = run(created.workspace, 'save_party', { ...editorParty('Rashid Traders', 'customer', 'Hyderabad'), id: created.recordId, creditLimit: '50000' }).workspace;
    const cust = created.recordId;
    let id: string;
    [w, id] = draft(w, 'sales_invoice', cust, item, '60000');
    refused(w, 'submit_document', { id }, 'Customer credit limit exceeded.', actor('Sales Manager'));
    w = run(w, 'update_document', { id, partyId: cust, warehouseId: firstWarehouse(w), date: today(), dueDate: today(), creditOverride: 'Owner approved', lines: [{ itemId: item, quantity: '1', price: '60000', taxRate: '0' }] }).workspace;
    w = run(w, 'submit_document', { id }).workspace;
    w = run(w, 'create_receipt', { partyId: cust, date: today(), amount: '60000', method: 'bank', dueDate: today(), allocations: [{ invoiceId: id, amount: '60000' }] }).workspace;
    const st = partyStatement(w, cust, '2000-01-01', '2999-12-31');
    expect(st.lines.map(l => l.balance)).toEqual(['60000.0000', '0.0000']);
    expect(st.closing).toBe('0.0000');
    expectInvariants(w);
  });
});
