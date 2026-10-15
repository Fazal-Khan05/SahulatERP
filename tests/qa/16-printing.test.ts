/**
 * SQA pack 16 — Printing, PDF and document view (PRN).
 * Executed here: the real /print/[kind]/[id] server page rendered to static HTML (membership, scoping and
 * branding resolved through the real workspace-store with an in-memory Supabase fake), the DocumentPreview
 * template, documentView/receiptView, partyStatement and static checks of print.css.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { firstWarehouse, freshCompany, owner, run, today, withDocument, withItem, withParty, actor } from './helpers';
import type { Role, Workspace } from '../../src/modules/erp/types';
import { partyStatement } from '../../src/modules/erp/reports';

type Row = Record<string, unknown>;
const S = vi.hoisted(() => {
  const state = {
    user: null as null | { id: string; email?: string; user_metadata: Record<string, unknown> },
    memberships: [] as Row[], snapshots: new Map<string, { data: unknown; revision: number }>(), signed: [] as [string, number][],
    table(rows: () => Row[]) {
      const filters: ((r: Row) => boolean)[] = []; let single = false;
      const q: Record<string, unknown> = {
        select: () => q, order: () => q,
        eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q; },
        in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return q; },
        single: () => { single = true; return q; },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          const data = rows().filter(r => filters.every(f => f(r)));
          return Promise.resolve(single ? (data[0] ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } }) : { data, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  return state;
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: async () => ({ auth: { getUser: async () => ({ data: { user: S.user } }) }, from: () => S.table(() => S.memberships) }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => ({
  from: () => S.table(() => [...S.snapshots].map(([tenant_id, v]) => ({ tenant_id, data: v.data, revision: v.revision }))),
  storage: { from: () => ({ createSignedUrl: async (p: string, s: number) => { S.signed.push([p, s]); return { data: { signedUrl: `https://storage.example/${p}?expires=${s}` } }; } }) },
}) }));
vi.mock('@/lib/workspace-store', () => import('../../src/lib/workspace-store'));
vi.mock('@/lib/branding-store', () => import('../../src/lib/branding-store'));
vi.mock('@/modules/erp/access', () => import('../../src/modules/erp/access'));
vi.mock('@/modules/erp/codec', () => import('../../src/modules/erp/codec'));
vi.mock('@/modules/erp/documents', () => import('../../src/modules/erp/documents'));
vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/components/document-preview', () => import('../../src/components/document-preview'));
vi.mock('@/components/print-actions', () => import('../../src/components/print-actions'));
import PrintPage from '../../src/app/print/[kind]/[id]/page';

const root = resolve(__dirname, '../..');
const printCss = readFileSync(resolve(root, 'src/app/print/print.css'), 'utf8');
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const T = 'qa-tenant';
const OTHER = 'other-tenant';
const tableRows = (html: string) => [...html.matchAll(/<tr[^>]*><th>([^<]*)<\/th><td>([^<]*)<\/td><\/tr>/g)].map(m => [m[1], m[2]]);

let F: {
  w: Workspace; cust: string; walkin: string; supp: string; emp: string; emp2: string; a: string; b: string; c: string; d: string;
  inv: string; walkInv: string; paidInv: string; creditInv: string; draftInv: string; cancelledInv: string; credit: string; quote: string; so: string; dn: string; chainInv: string;
  po: string; grn: string; bill: string; supReturn: string; receipt: string; cheque: string; voucher: string; bigInv: string; zeroInv: string; xssInv: string; emojiInv: string; otherBranchInv: string; emp2Inv: string;
};

function build() {
  let w = freshCompany(undefined, { name: 'Print Test Traders', taxId: 'NTN-1234567', phone: '+92 300 0000000', email: 'print@qa.example' });
  w = run(w, 'save_branding', { template: 'standard', accent: '#aa3300', footer: 'Bank: QA Bank\nAccount 0001-2' }).workspace;
  let a: string, b: string, c: string, d: string, cust: string, walkin: string, supp: string;
  [w, a] = withItem(w, { name: 'LED Panel Light', sku: 'EL-001', unit: 'pcs' }, { quantity: '2000000', cost: '1' });
  [w, b] = withItem(w, { name: 'Loose Part', sku: 'LP-1', unit: '' }, { quantity: '100', cost: '5' });
  [w, c] = withItem(w, { name: 'Copper Wire', sku: 'CW-1', unit: 'kg' }, { quantity: '100', cost: '50' });
  [w, d] = withItem(w, { name: 'Screws', sku: 'SC-1', unit: '1000 pcs' }, { quantity: '100', cost: '5' });
  [w, cust] = withParty(w, 'customer', { name: 'Al-Noor Electronics', city: 'Karachi', email: 'accounts@alnoor.example', taxId: '1234567-8', registered: true, terms: 30 });
  [w, walkin] = withParty(w, 'customer', { name: 'Walk-in customer', city: '', terms: 0 });
  [w, supp] = withParty(w, 'supplier', { name: 'Shenzhen Bright', city: 'Shenzhen', terms: 60 });
  const e1 = run(w, 'save_employee', { name: 'Hamza Khan', role: 'Order Booker', territory: 'Karachi', salary: '1', allowance: '0', deduction: '0', attendance: 30, active: true }); w = e1.workspace;
  const e2 = run(w, 'save_employee', { name: 'Sara Malik', role: 'Order Booker', territory: 'Karachi', salary: '1', allowance: '0', deduction: '0', attendance: 30, active: true }); w = e2.workspace;
  const line = (itemId: string, quantity: string, price: string, extra: Row = {}) => ({ itemId, quantity, price, ...extra });
  let inv: string, walkInv: string, paidInv: string, creditInv: string, draftInv: string, cancelledInv: string, bigInv: string, zeroInv: string, xssInv: string, emojiInv: string, emp2Inv: string;
  [w, inv] = withDocument(w, 'sales_invoice', cust, [line(a, '2', '100', { discount: '10', taxRate: '18', employeeId: e1.recordId }), line(c, '0.5', '200'), line(b, '3', '10'), line(d, '1', '7')]);
  [w, walkInv] = withDocument(w, 'sales_invoice', walkin, [line(a, '1', '50')], { partyName: 'Ali Raza' });
  [w, paidInv] = withDocument(w, 'sales_invoice', cust, [line(a, '1', '100')]);
  [w, creditInv] = withDocument(w, 'sales_invoice', cust, [line(a, '2', '100')]);
  [w, draftInv] = withDocument(w, 'sales_invoice', cust, [line(a, '1', '100')], {}, false);
  let cancelledDraft: string; [w, cancelledDraft] = withDocument(w, 'sales_invoice', cust, [line(a, '1', '100')], {}, false);
  w = run(w, 'cancel_document', { id: cancelledDraft, reason: 'Customer changed order' }).workspace; cancelledInv = cancelledDraft;
  [w, bigInv] = withDocument(w, 'sales_invoice', cust, [line(a, '1234567', '1')]);
  [w, zeroInv] = withDocument(w, 'sales_invoice', cust, [line(a, '1', '0')]);
  [w, xssInv] = withDocument(w, 'sales_invoice', cust, [line(a, '1', '1')], { notes: '<img src=x onerror=alert(1)><script>alert(2)</script>' });
  [w, emojiInv] = withDocument(w, 'sales_invoice', cust, [line(a, '1', '1')], { notes: 'Thanks 🙏 بہت شکریہ' });
  [w, emp2Inv] = withDocument(w, 'sales_invoice', cust, [line(a, '1', '1', { employeeId: e2.recordId })]);
  // Partial payment and partial return on the main invoice; full payment; payment then full return (customer credit).
  const docOf = (id: string) => w.documents.find(x => x.id === id)!;
  w = run(w, 'create_receipt', { partyId: cust, date: today(), amount: '100', method: 'bank', dueDate: today(), allocations: [{ invoiceId: inv, amount: '100' }] }).workspace;
  const receipt = w.receipts.at(-1)!.id;
  w = run(w, 'return_document', { id: inv, date: today(), lines: [{ lineId: docOf(inv).lines[2].id, quantity: '1' }], reason: 'Damaged' }).workspace;
  const credit = w.documents.at(-1)!.id;
  w = run(w, 'create_receipt', { partyId: cust, date: today(), amount: docOf(paidInv).total, method: 'cash', dueDate: today(), allocations: [{ invoiceId: paidInv, amount: docOf(paidInv).total }] }).workspace;
  w = run(w, 'create_receipt', { partyId: cust, date: today(), amount: docOf(creditInv).total, method: 'cash', dueDate: today(), allocations: [{ invoiceId: creditInv, amount: docOf(creditInv).total }] }).workspace;
  w = run(w, 'return_document', { id: creditInv, date: today(), lines: [{ lineId: docOf(creditInv).lines[0].id, quantity: '2' }] }).workspace;
  // Cheque that bounces.
  w = run(w, 'create_receipt', { partyId: cust, date: today(), amount: '10', method: 'cheque', chequeNo: 'CHQ-778', dueDate: today(), allocations: [{ invoiceId: inv, amount: '10' }] }).workspace;
  const cheque = w.receipts.at(-1)!.id;
  w = run(w, 'update_cheque', { id: cheque, status: 'deposited', date: today() }).workspace;
  w = run(w, 'update_cheque', { id: cheque, status: 'bounced', date: today() }).workspace;
  // Chain QUO → SO → DN → INV.
  let quote: string; [w, quote] = withDocument(w, 'quotation', cust, [line(a, '5', '100')]);
  const so = run(w, 'convert_document', { id: quote, date: today() }); w = run(so.workspace, 'submit_document', { id: so.recordId }).workspace;
  const dn = run(w, 'convert_document', { id: so.recordId, date: today() }); w = run(dn.workspace, 'submit_document', { id: dn.recordId }).workspace;
  const ci = run(w, 'convert_document', { id: dn.recordId, date: today() }); w = run(ci.workspace, 'submit_document', { id: ci.recordId }).workspace;
  // Purchasing: USD purchase order, GRN, supplier bill, supplier return, supplier payment.
  let po: string; [w, po] = withDocument(w, 'purchase_order', supp, [line(a, '10', '10')], { currency: 'USD', fxRate: '280.5' });
  let grn: string; [w, grn] = withDocument(w, 'goods_receipt', supp, [line(a, '4', '100')]);
  let bill: string; [w, bill] = withDocument(w, 'supplier_invoice', supp, [line(c, '2', '100')]);
  w = run(w, 'return_document', { id: bill, date: today(), lines: [{ lineId: docOf(bill).lines[0].id, quantity: '1' }] }).workspace;
  const supReturn = w.documents.at(-1)!.id;
  w = run(w, 'create_receipt', { partyId: supp, date: today(), amount: '50', method: 'bank', dueDate: today(), allocations: [{ invoiceId: bill, amount: '50' }] }).workspace;
  const voucher = w.receipts.at(-1)!.id;
  // Second branch with its own warehouse and an invoice there.
  w = run(w, 'save_branch', { name: 'Lahore' }).workspace;
  const lahore = w.branches.find(x => x.name === 'Lahore')!.id;
  w = run(w, 'save_warehouse', { name: 'Lahore store', branchId: lahore }).workspace;
  const lhe = w.warehouses.find(x => x.branchId === lahore)!.id;
  w = run(w, 'bulk_stock_increase', { warehouseId: lhe, date: today(), purpose: 'opening_stock', reason: 'QA', lines: [{ itemId: a, quantity: '10', cost: '1' }] }).workspace;
  const ob = run(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: lhe, date: today(), dueDate: today(), lines: [{ ...line(a, '1', '10'), discount: '0', taxRate: '0', employeeId: '', splits: [] }] });
  w = run(ob.workspace, 'submit_document', { id: ob.recordId }).workspace;
  F = { w, cust, walkin, supp, emp: e1.recordId, emp2: e2.recordId, a, b, c, d, inv, walkInv, paidInv, creditInv, draftInv, cancelledInv, credit, quote, so: so.recordId, dn: dn.recordId, chainInv: ci.recordId, po, grn, bill, supReturn, receipt, cheque, voucher, bigInv, zeroInv, xssInv, emojiInv, otherBranchInv: ob.recordId, emp2Inv };
}

function seed(workspaces: Workspace[], memberships: [string, Role, Row?][]) {
  S.user = { id: 'u-print', email: 'p@qa.example', user_metadata: { display_name: 'Printer' } };
  S.snapshots = new Map(workspaces.map(x => [x.tenantId, { data: JSON.parse(JSON.stringify(x)), revision: x.revision }]));
  S.memberships = memberships.map(([tenant_id, role, extra]) => ({ tenant_id, user_id: 'u-print', role, branch_ids: [], employee_id: null, active: true, ...extra }));
}
async function print(kind: string, id: string, tenant: string | null = T): Promise<string> {
  return renderToStaticMarkup(await PrintPage({ params: Promise.resolve({ kind, id }), searchParams: Promise.resolve(tenant === null ? {} : { tenant }) }));
}
async function status(kind: string, id: string, tenant: string | null = T): Promise<number> {
  try { await print(kind, id, tenant); return 200; } catch (e) { if (String((e as { digest?: string }).digest ?? (e as Error).message).includes('404')) return 404; throw e; }
}
const docOf = (id: string) => F.w.documents.find(x => x.id === id)!;
const totals = (html: string) => Object.fromEntries(tableRows(html.slice(html.indexOf('doc-totals'))));

beforeAll(() => build());
beforeEach(() => { seed([F.w], [[T, 'Owner']]); S.signed = []; });

describe('16 printing', () => {
  it('PRN-001 submitted sales invoice: company header, SALES INVOICE title, number, date, due', async () => {
    const html = await print('sales_invoice', F.inv); const t = text(html); const doc = docOf(F.inv);
    for (const s of ['Print Test Traders', '12 Jodia Bazar, Karachi', '+92 300 0000000 · print@qa.example', 'Sales invoice', doc.number, doc.date]) expect(t).toContain(s);
    expect(tableRows(html)).toEqual(expect.arrayContaining([['Number', doc.number], ['Date', doc.date], ['Due', doc.dueDate]]));
    expect(printCss).toMatch(/\.doc-title h1, \.doc-title-text \{[^}]*text-transform: uppercase/);
  });
  it('PRN-002 uploaded logo printed top-left via short-lived signed URL, aspect kept [case-corrected: logo box is 22mm (≈83px) square with object-fit: contain]', async () => {
    seed([{ ...F.w, branding: { ...F.w.branding, logoPath: `${T}/logo.png` } }], [[T, 'Owner']]);
    const html = await print('sales_invoice', F.inv);
    expect(html).toContain(`<img class="doc-logo" src="https://storage.example/${T}/logo.png?expires=600" alt="Print Test Traders logo"/>`);
    expect(printCss).toContain('.doc-logo { width: 22mm; height: 22mm; object-fit: contain; }');
  });
  it('PRN-003 no logo → company initial tile in accent colour', async () => {
    const html = await print('sales_invoice', F.inv);
    expect(html).toContain(`<span class="doc-logo-fallback" aria-hidden="true">${F.w.company.logo}</span>`);
    expect(printCss).toMatch(/\.doc-logo-fallback \{[^}]*background: var\(--doc-accent\)/);
  });
  it('PRN-004 letterhead replaces the whole header; company name not duplicated', async () => {
    seed([{ ...F.w, branding: { ...F.w.branding, letterheadPath: `${T}/letterhead.png` } }], [[T, 'Owner']]);
    const html = await print('sales_invoice', F.inv);
    expect(html).toContain('class="doc-letterhead"');
    expect(html).not.toContain('doc-company');
    expect(html).not.toContain('doc-identity');
  });
  it('PRN-005 accent colour applied to heading and table header', async () => {
    expect(await print('sales_invoice', F.inv)).toContain('style="--doc-accent:#aa3300"');
    expect(printCss).toMatch(/\.doc-title h1, \.doc-title-text \{[^}]*color: var\(--doc-accent\)/);
    expect(printCss).toMatch(/\.doc-lines th \{[^}]*background: var\(--doc-accent\)/);
  });
  it('PRN-006 footer text printed with line breaks kept', async () => {
    expect(await print('sales_invoice', F.inv)).toContain('<p>Bank: QA Bank\nAccount 0001-2</p>');
    expect(printCss).toContain('.doc-footer p { margin: 0 0 2mm; white-space: pre-wrap; }');
  });
  it('PRN-007 NTN / STRN line when set', async () => {
    expect(text(await print('sales_invoice', F.inv))).toContain('NTN / STRN: NTN-1234567');
  });
  it('PRN-008 bill-to block shows only present fields (name, city, email, tax id)', async () => {
    const html = await print('sales_invoice', F.inv);
    const block = html.slice(html.indexOf('doc-parties'), html.indexOf('doc-meta'));
    expect(text(block)).toContain('Bill to Al-Noor Electronics Karachi accounts@alnoor.example NTN / STRN: 1234567-8');
    const walk = await print('sales_invoice', F.walkInv);
    const wblock = walk.slice(walk.indexOf('doc-parties'), walk.indexOf('doc-lines'));
    expect(wblock).not.toContain('NTN / STRN');
    expect(wblock).not.toContain('@');
  });
  it('PRN-009 walk-in invoice prints the typed name and no address', async () => {
    const html = await print('sales_invoice', F.walkInv);
    const block = html.slice(html.indexOf('doc-parties'), html.indexOf('doc-meta'));
    expect(block).toMatch(/<span class="doc-label">Bill to<\/span><strong>Ali Raza<\/strong><\/div>/);
    expect(html).not.toContain('Walk-in customer');
  });
  it('PRN-010 terms line from customer terms [documented: walk-in invoices show the shared walk-in account terms, here "0 days"]', async () => {
    expect(tableRows((await print('sales_invoice', F.inv)).replace(/<div><dt>([^<]*)<\/dt><dd>([^<]*)<\/dd><\/div>/g, '<tr><th>$1</th><td>$2</td></tr>'))).toContainEqual(['Terms', '30 days']);
    expect(await print('sales_invoice', F.walkInv)).toContain('<dt>Terms</dt><dd>0 days</dd>');
  });
  it('PRN-011 salesperson line when set', async () => {
    expect(await print('sales_invoice', F.inv)).toContain('<dt>Salesperson</dt><dd>Hamza Khan</dd>');
    expect(await print('sales_invoice', F.walkInv)).not.toContain('Salesperson');
  });
  it('PRN-012 line columns: description, SKU small, qty + unit, rate, disc %, tax %, amount', async () => {
    const html = await print('sales_invoice', F.inv);
    expect(html).toContain('<td><strong>LED Panel Light</strong><small>EL-001</small></td><td class="num">2 pcs</td><td class="num">Rs 100</td><td class="num">10%</td><td class="num">18%</td><td class="num">Rs 180</td>');
    expect(html).toMatch(/<thead><tr><th>Description<\/th><th class="num">Qty<\/th><th class="num">Rate<\/th><th class="num">Disc\.<\/th><th class="num">Tax<\/th><th class="num">Amount<\/th><\/tr><\/thead>/);
  });
  it('PRN-013 blank unit prints quantity only', async () => {
    expect(await print('sales_invoice', F.inv)).toContain('<td class="num">3 </td>');
  });
  it('PRN-014 unit "1000 pcs" printed verbatim [documented]', async () => {
    expect(await print('sales_invoice', F.inv)).toContain('<td class="num">1 1000 pcs</td>');
  });
  it('PRN-015 quantity 0.5 prints "0.5 kg"', async () => {
    expect(await print('sales_invoice', F.inv)).toContain('<td class="num">0.5 kg</td>');
  });
  it('PRN-016 quantity 1,234,567 printed with thousands separators', async () => {
    const html = await print('sales_invoice', F.bigInv);
    expect(html).not.toContain('1234567 pcs');
    expect(html).toContain('<td class="num">1,234,567 pcs</td>');
  });
  it('PRN-017 totals: subtotal, tax, total, paid, returns, balance due with correct arithmetic', async () => {
    const doc = docOf(F.inv);
    // 2×100×0.9=180 (+18% tax 32.4) + 0.5×200=100 + 3×10=30 + 1×7=7 → net 317, tax 32.4, total 349.4; paid 100 (bounced cheque reversed); return 1×10 → 10.
    expect([doc.net, doc.tax, doc.total, doc.paid, doc.returned]).toEqual(['317.0000', '32.4000', '349.4000', '100.0000', '10.0000']);
    expect(totals(await print('sales_invoice', F.inv))).toEqual({ Subtotal: 'Rs 317', 'Sales tax 18%': 'Rs 32.4', Total: 'Rs 349.4', Paid: '− Rs 100', 'Returns / credits': '− Rs 10', 'Balance due': 'Rs 239.4' });
  });
  it('PRN-018 fully paid invoice shows balance due 0', async () => {
    expect(totals(await print('sales_invoice', F.paidInv))['Balance due']).toBe('Rs 0');
  });
  it('PRN-019 overpaid / credited invoice shows a "Customer credit" line', async () => {
    const html = await print('sales_invoice', F.creditInv);
    expect(totals(html)['Customer credit']).toBe('Rs 200');
    expect(html).toContain('class="emphasis credit"');
  });
  it('PRN-020 draft invoice print shows a visible DRAFT status', async () => {
    const html = await print('sales_invoice', F.draftInv);
    expect(docOf(F.draftInv).status).toBe('draft');
    expect(text(html).toUpperCase()).toContain('DRAFT');
  });
  it('PRN-021 cancelled invoice print shows CANCELLED', async () => {
    const html = await print('sales_invoice', F.cancelledInv);
    expect(text(html)).toContain('Cancelled: Customer changed order');
    expect(text(html).replace('Cancelled: Customer changed order', '').toUpperCase()).toContain('CANCELLED');
  });
  it('PRN-022 credit note print: title "Credit note" with reference to the invoice', async () => {
    const html = await print('credit_note', F.credit);
    expect(html).toContain('<h1>Credit note</h1>');
    expect(html).toContain(`<dt>Reference</dt><dd>${docOf(F.inv).number}</dd>`);
  });
  it('PRN-023 quotation print: title, no payment lines [documented: Due row still printed from dueDate]', async () => {
    const html = await print('quotation', F.quote);
    expect(html).toContain('<h1>Quotation</h1>');
    expect(Object.keys(totals(html))).toEqual(['Subtotal', 'Total']);
    expect(tableRows(html)).toContainEqual(['Due', docOf(F.quote).dueDate]);
  });
  it('PRN-024 sales order print has the correct title', async () => {
    expect(await print('sales_order', F.so)).toContain('<h1>Sales order</h1>');
  });
  it('PRN-025 delivery note print shows quantities [documented: prices and amounts are printed too]', async () => {
    const html = await print('delivery', F.dn);
    expect(html).toContain('<h1>Delivery note</h1>');
    expect(html).toContain('<td class="num">5 pcs</td><td class="num">Rs 100</td>');
  });
  it('PRN-026 USD purchase order shows currency, rate and totals in both currencies', async () => {
    const html = await print('purchase_order', F.po);
    expect(html).toContain('<dt>Exchange rate</dt><dd>1 USD = 280.5 PKR</dd>');
    expect(text(html)).toContain('amounts in USD');
    const t = totals(html);
    expect(t.Total).not.toMatch(/^Rs/);
    expect(text(html)).toContain('28,050');
  });
  it('PRN-027 GRN print shows received quantities', async () => {
    const html = await print('goods_receipt', F.grn);
    expect(html).toContain('<h1>Goods receipt note</h1>');
    expect(html).toContain('<td class="num">4 pcs</td>');
  });
  it('PRN-028 supplier bill print with due date [documented: Due is the date entered on the bill, not recomputed from supplier terms]', async () => {
    const html = await print('supplier_invoice', F.bill);
    expect(html).toContain('<h1>Supplier bill</h1>');
    expect(tableRows(html)).toContainEqual(['Due', docOf(F.bill).dueDate]);
    expect(html).toContain('<dt>Terms</dt><dd>60 days</dd>');
  });
  it('PRN-029 supplier return print title', async () => {
    expect(await print('supplier_return', F.supReturn)).toContain('<h1>Supplier return</h1>');
  });
  it('PRN-030 receipt print: "Receipt", "Received from", method, allocations', async () => {
    const html = await print('receipt', F.receipt); const t = text(html);
    expect(html).toContain('<h1>Receipt</h1>');
    expect(t).toContain('Received from Al-Noor Electronics');
    expect(html).toContain('<dt>Method</dt><dd>Bank transfer</dd>');
    expect(t).toContain(`Sales invoice ${docOf(F.inv).number}`);
    expect(totals(html)).toEqual({ Amount: 'Rs 100' });
    expect(await print('receipt', F.cheque)).toContain('<dt>Method</dt><dd>Cheque CHQ-778</dd>');
  });
  it('PRN-031 payment voucher print: "Payment voucher", "Paid to"', async () => {
    const html = await print('receipt', F.voucher);
    expect(html).toContain('<h1>Payment voucher</h1>');
    expect(text(html)).toContain('Paid to Shenzhen Bright');
  });
  it('PRN-032 customer statement: period and running balance [documented: printed from Reports → statement via browser print; no /print/statement route]', async () => {
    expect(await status('statement', F.cust)).toBe(404);
    const s = partyStatement(F.w, F.cust, '2000-01-01', '2099-12-31');
    let running = Number(s.opening);
    for (const l of s.lines) { running += Number(l.debit || 0) - Number(l.credit || 0); expect(Number(l.balance)).toBeCloseTo(running, 4); }
    expect(s.closing).toBe(s.lines.at(-1)!.balance);
  });
  it("PRN-033 another tenant's document id → not found", async () => {
    let o = freshCompany(undefined, { name: 'Other Co' }); o = { ...o, tenantId: OTHER };
    let oi: string, oc: string, od: string; [o, oi] = withItem(o, {}, { quantity: '5', cost: '1' }); [o, oc] = withParty(o); [o, od] = withDocument(o, 'sales_invoice', oc, [{ itemId: oi, quantity: '1', price: '1' }]);
    seed([F.w, o], [[T, 'Owner']]);
    expect(await status('sales_invoice', od, OTHER)).toBe(404);
    expect(await status('sales_invoice', od, T)).toBe(404);
  });
  it('PRN-034 print while signed out → sign-in message, no document', async () => {
    S.user = null;
    const html = await print('sales_invoice', F.inv);
    expect(text(html)).toBe('Sign in to print documents. Go to sign in');
  });
  it("PRN-035 salesperson printing another salesperson's invoice → not found (scoped)", async () => {
    seed([F.w], [[T, 'Salesperson', { employee_id: F.emp }]]);
    expect(await status('sales_invoice', F.emp2Inv)).toBe(404);
    expect(await status('sales_invoice', F.inv)).toBe(200);
  });
  it('PRN-036 branch-limited user printing another branch document → not found', async () => {
    const main = F.w.warehouses[0].branchId;
    seed([F.w], [[T, 'Accountant', { branch_ids: [main] }]]);
    expect(await status('sales_invoice', F.otherBranchInv)).toBe(404);
    expect(await status('sales_invoice', F.inv)).toBe(200);
  });
  it('PRN-037 logo URL is signed and short-lived [documented: 600 s expiry; expired-link failure needs hosted storage]', async () => {
    seed([{ ...F.w, branding: { ...F.w.branding, logoPath: `${T}/logo.png` } }], [[T, 'Owner']]);
    await print('sales_invoice', F.inv);
    expect(S.signed).toEqual([[`${T}/logo.png`, 600]]);
  });
  it('PRN-041 print CSS: no sidebar, top bar or buttons in the printed output', async () => {
    const html = await print('sales_invoice', F.inv);
    expect(html).not.toMatch(/sidebar|topbar/);
    expect(printCss).toMatch(/@media print \{[\s\S]*\.print-actions \{ display: none; \}/);
  });
  it('PRN-042 accent colours preserved in print (print-color-adjust: exact)', () => {
    const block = printCss.slice(printCss.indexOf('@media print'));
    expect(block).toContain('.doc-lines th { print-color-adjust: exact; -webkit-print-color-adjust: exact; }');
    expect(block).toContain('.doc-logo-fallback { print-color-adjust: exact; -webkit-print-color-adjust: exact; }');
  });
  it('PRN-043 print fonts [case-corrected: the print template uses Arial/Helvetica with "Noto Naskh Arabic" fallback, not Geist]', () => {
    expect(printCss).toContain('font-family: Arial, Helvetica, "Noto Naskh Arabic", sans-serif;');
    expect(printCss).not.toMatch(/geist/i);
  });
  it('PRN-050 emoji and Urdu in notes render without crashing [documented: glyph rendering needs a browser]', async () => {
    expect(await print('sales_invoice', F.emojiInv)).toContain('<p>Thanks 🙏 بہت شکریہ</p>');
  });
  it('PRN-055 in-app document details use the same documentView as print', () => {
    const details = readFileSync(resolve(root, 'src/components/document-details.tsx'), 'utf8');
    expect(details).toContain("import { documentTitle, documentView } from '@/modules/erp/documents';");
    expect(details).toContain('const view = documentView(workspace, doc);');
  });
  it('PRN-063 tenant param of another membership looks the doc up there (not found); correct tenant works [documented: a non-member tenant falls back to the first membership]', async () => {
    let o = freshCompany(undefined, { name: 'Second Co' }); o = { ...o, tenantId: OTHER };
    seed([F.w, o], [[T, 'Owner'], [OTHER, 'Owner']]);
    expect(await status('sales_invoice', F.inv, OTHER)).toBe(404);
    expect(await status('sales_invoice', F.inv, T)).toBe(200);
    expect(await status('sales_invoice', F.inv, 'not-a-member')).toBe(200);
  });
  it('PRN-064 print URL without tenant param falls back to the first membership [documented: memberships[0], unlike the app entry which prefers the non-demo company]', async () => {
    let o = freshCompany(undefined, { name: 'Second Co' }); o = { ...o, tenantId: OTHER };
    seed([F.w, o], [[T, 'Owner'], [OTHER, 'Owner']]);
    expect(await status('sales_invoice', F.inv, null)).toBe(200);
    seed([F.w, o], [[OTHER, 'Owner'], [T, 'Owner']]);
    expect(await status('sales_invoice', F.inv, null)).toBe(404);
  });
  it('PRN-065 a receipt id via a document route is not found; the receipt route works', async () => {
    expect(await status('sales_invoice', F.receipt)).toBe(404);
    expect(await status('receipt', F.receipt)).toBe(200);
    expect(await status('credit_note', F.inv)).toBe(404);
  });
  it('PRN-066 unknown kind /print/foo/<id> → 404', async () => {
    expect(await status('foo', F.inv)).toBe(404);
  });
  it('PRN-067 company still in setup [documented: print is allowed; there are no documents so any id is not found]', async () => {
    const setup = { ...freshCompany(), setup: { complete: false as const, step: 1 as const } };
    seed([setup], [[T, 'Owner']]);
    expect(await status('sales_invoice', F.inv)).toBe(404);
  });
  it('PRN-068 branding changed after the invoice: reprint shows the new branding [documented: branding is not snapshotted]', async () => {
    const changed = run(F.w, 'save_branding', { template: 'standard', accent: '#123456', footer: 'New footer' }).workspace;
    seed([changed], [[T, 'Owner']]);
    const html = await print('sales_invoice', F.inv);
    expect(html).toContain('--doc-accent:#123456');
    expect(html).toContain('<p>New footer</p>');
  });
  it('PRN-069 printed tax details come from the invoice-time tax snapshot', async () => {
    const doc = docOf(F.inv);
    expect(doc.taxSnapshot).toMatchObject({ registered: true, taxId: '1234567-8' });
    const party = F.w.parties.find(p => p.id === F.cust)!;
    const changed = run(F.w, 'save_party', { ...party, taxId: '9999999-9', registered: false }).workspace;
    seed([changed], [[T, 'Owner']]);
    const t = text(await print('sales_invoice', F.inv));
    expect(t).toContain('NTN / STRN: 1234567-8');
    // Registered at invoice time, so the later de-registration and new tax id do not reach the reprint.
    expect(t).not.toContain('9999999-9');
    expect(t).not.toContain('Unregistered for sales tax');
  });
  it('PRN-070 amount in words [documented: not present on the template]', async () => {
    expect(text(await print('sales_invoice', F.inv))).not.toMatch(/\bonly\b|rupees/i);
  });
  it('PRN-071 footer states "amounts in PKR"; USD documents state their currency', async () => {
    expect(text(await print('sales_invoice', F.inv))).toContain('Computer-generated document · Print Test Traders · amounts in PKR');
    expect(text(await print('purchase_order', F.po))).toContain('amounts in USD');
  });
  it('PRN-072 rate formatting "Rs 2,400" for PKR and "$10.00" for USD', async () => {
    expect(await print('sales_invoice', F.inv)).toContain('<td class="num">Rs 100</td>');
    const po = await print('purchase_order', F.po);
    expect(po).not.toContain('<td class="num">Rs 10</td>');
    expect(po).toContain('<td class="num">$10.00</td>');
  });
  it('PRN-073 discount column [case-corrected: "0%" is printed for zero discounts as well, not only when non-zero]', async () => {
    const html = await print('sales_invoice', F.inv);
    expect(html).toContain('<td class="num">10%</td>');
    expect(html).toContain('<td class="num">Rs 200</td><td class="num">0%</td>');
  });
  it('PRN-074 tax column shows "0%" consistently (never blank) [documented]', async () => {
    const html = await print('sales_invoice', F.inv);
    const taxCells = [...html.matchAll(/<td class="num">([^<]*)<\/td><td class="num">Rs [\d,.]+<\/td><\/tr>/g)].map(m => m[1]);
    expect(taxCells).toEqual(['18%', '0%', '0%', '0%']);
  });
  it('PRN-078 page title carries the document number [case-corrected: title is "<Kind> <number>", e.g. "Sales invoice INV-…", set client-side by PrintActions]', async () => {
    const html = await print('sales_invoice', F.inv);
    expect(html).toContain(`<div class="print-actions"><span>Sales invoice ${docOf(F.inv).number}</span>`);
    expect(readFileSync(resolve(root, 'src/components/print-actions.tsx'), 'utf8')).toContain('useEffect(() => { document.title = title; }, [title]);');
  });
  it('PRN-080 table header uses <thead> so browsers repeat it on each printed page [documented: repetition itself needs a browser]', async () => {
    expect(await print('sales_invoice', F.inv)).toMatch(/<table class="doc-lines"><thead>/);
  });
  it('PRN-081 page margins [case-corrected: @page margins are 14mm sides/top and 16mm bottom, A4]', () => {
    expect(printCss).toContain('@page { size: A4; margin: 14mm 14mm 16mm; }');
  });
  it('PRN-082 dark-mode OS: print stays light (no dark media query; explicit light colours)', () => {
    expect(printCss).not.toContain('prefers-color-scheme');
    expect(printCss).toMatch(/\.print-page \.doc \{[^}]*background: white/);
  });
  it('PRN-084 print a document while its module is hidden [documented: allowed; document kept]', async () => {
    const hidden = { ...F.w, modules: F.w.modules.filter(m => m !== 'sales' && m !== 'collections' && m !== 'commissions') };
    seed([hidden], [[T, 'Owner']]);
    expect(await status('sales_invoice', F.inv)).toBe(200);
  });
  it('PRN-085 statement for the walk-in account [documented: all walk-in documents are grouped under the one shared account]', () => {
    const s = partyStatement(F.w, F.walkin, '2000-01-01', '2099-12-31');
    expect(s.lines.map(l => l.reference)).toEqual([docOf(F.walkInv).number]);
  });
  it('PRN-086 receipt print for a bounced cheque shows status bounced', async () => {
    expect(await print('receipt', F.cheque)).toContain('<dt>Status</dt><dd>bounced</dd>');
  });
  it('PRN-088 invoice converted from a delivery shows the chain reference', async () => {
    expect(await print('sales_invoice', F.chainInv)).toContain(`<dt>Reference</dt><dd>${docOf(F.dn).number}</dd>`);
  });
  it('PRN-089 partially returned invoice shows a returns line', async () => {
    expect(totals(await print('sales_invoice', F.inv))['Returns / credits']).toBe('− Rs 10');
  });
  it('PRN-090 invoice number barcode/QR [documented: not present]', async () => {
    expect(await print('sales_invoice', F.inv)).not.toMatch(/<canvas|qr|barcode/i);
  });
  it('PRN-091 company address with newlines prints line breaks in the header', async () => {
    const multi = run(F.w, 'save_company', { name: 'Print Test Traders', address: 'Plot 12\nJodia Bazar\nKarachi', phone: '', email: '', taxId: '' }).workspace;
    seed([multi], [[T, 'Owner']]);
    expect(await print('sales_invoice', F.inv)).toContain('<span>Plot 12\nJodia Bazar\nKarachi</span>');
    expect(printCss).toMatch(/\.doc-identity[^{]*span[^{]*\{[^}]*white-space: pre-(line|wrap)/);
  });
  it('PRN-092 "·" separator appears only between present phone/email values', async () => {
    const phoneOnly = run(F.w, 'save_company', { name: 'Print Test Traders', address: 'Karachi', phone: '+92 300 1', email: '', taxId: '' }).workspace;
    seed([phoneOnly], [[T, 'Owner']]);
    const html = await print('sales_invoice', F.inv);
    expect(html).toContain('<span>+92 300 1</span>');
    expect(html.slice(0, html.indexOf('doc-title'))).not.toContain('·');
  });
  it('PRN-093 letterhead + NTN [documented: NTN is omitted with the letterhead, consistently]', async () => {
    seed([{ ...F.w, branding: { ...F.w.branding, letterheadPath: `${T}/letterhead.png` } }], [[T, 'Owner']]);
    const html = await print('sales_invoice', F.inv);
    expect(html.slice(0, html.indexOf('doc-parties'))).not.toContain('NTN');
  });
  it('PRN-094 document with zero total prints "Rs 0"', async () => {
    expect(totals(await print('sales_invoice', F.zeroInv))).toMatchObject({ Subtotal: 'Rs 0', Total: 'Rs 0', 'Balance due': 'Rs 0' });
  });
  it('PRN-095 negative balance due uses credit wording', async () => {
    const t = totals(await print('sales_invoice', F.creditInv));
    expect(t['Balance due']).toBeUndefined();
    expect(t['Customer credit']).toBe('Rs 200');
  });
  it("PRN-096 print HTML contains only this document's data", async () => {
    const html = await print('sales_invoice', F.inv);
    const others = F.w.documents.filter(x => x.id !== F.inv && x.number !== docOf(F.inv).number).map(x => x.number);
    for (const n of others) expect(html).not.toContain(n);
    expect(html).not.toContain(F.w.receipts[0].number);
  });
  it('PRN-097 notes with <img onerror> / <script> are escaped', async () => {
    const html = await print('sales_invoice', F.xssInv);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).not.toMatch(/<img src=x|<script>/);
  });
  it('PRN-098 print page without JS: the server HTML already contains the whole document', async () => {
    const t = text(await print('sales_invoice', F.inv));
    for (const s of ['Sales invoice', docOf(F.inv).number, 'LED Panel Light', 'Balance due', 'Computer-generated document']) expect(t).toContain(s);
  });
  it('PRN-100 end to end content: logo, NTN, footer, walk-in name, partial payment and return [documented: A4 layout needs a browser]', async () => {
    let w = F.w;
    w = run(w, 'create_receipt', { partyId: F.walkin, date: today(), amount: '20', method: 'cash', dueDate: today(), allocations: [{ invoiceId: F.walkInv, amount: '20' }] }).workspace;
    const walkDoc = w.documents.find(x => x.id === F.walkInv)!;
    w = run(w, 'return_document', { id: F.walkInv, date: today(), lines: [{ lineId: walkDoc.lines[0].id, quantity: '0.1' }] }).workspace;
    seed([{ ...w, branding: { ...w.branding, logoPath: `${T}/logo.png` } }], [[T, 'Owner']]);
    const html = await print('sales_invoice', F.walkInv); const t = text(html);
    expect(html).toContain('class="doc-logo"');
    for (const s of ['NTN / STRN: NTN-1234567', 'Bank: QA Bank', 'Ali Raza']) expect(t).toContain(s);
    expect(totals(html)).toEqual({ Subtotal: 'Rs 50', Total: 'Rs 50', Paid: '− Rs 20', 'Returns / credits': '− Rs 5', 'Balance due': 'Rs 25' });
  });

  const todo: [string, string][] = [
    ['PRN-038', '[browser] "Print / Save as PDF" opens the print dialog; the button is hidden in print output'],
    ['PRN-039', '[browser] A4 portrait preview: 10 lines fit one page; 60 lines break without splitting a row'],
    ['PRN-040', '[browser] Letter-size print preview fits'],
    ['PRN-044', '[browser] 100-line invoice paginates; totals on the last page'],
    ['PRN-045', '[browser] 120-char product name wraps within its column'],
    ['PRN-046', '[browser] 2,000-char notes wrap, not clipped'],
    ['PRN-047', '[browser] 500-char footer wraps'],
    ['PRN-048', '[browser] 120-char company name wraps; header intact'],
    ['PRN-049', '[browser] Urdu/Arabic party names render right-to-left correctly'],
    ['PRN-051', '[browser] 1×1 px logo scales without breaking layout'],
    ['PRN-052', '[browser] very wide 2000×100 logo is constrained'],
    ['PRN-053', '[browser] transparent PNG logo readable'],
    ['PRN-054', '[manual] iPhone Share → Print layout fits without clipping'],
    ['PRN-056', '[browser] details dialog shows QUO → SO → DN → INV chain links'],
    ['PRN-057', '[browser] details dialog lists payments with cheque status'],
    ['PRN-058', '[browser] details dialog lists returns'],
    ['PRN-059', '[browser] details Submit/Return/Convert/Print buttons by state and role'],
    ['PRN-060', '[browser] details for walk-in invoice show the typed name'],
    ['PRN-061', '[browser] details for a cancelled draft show the reason in notes'],
    ['PRN-062', '[browser] details dialog on phone is a scrollable bottom sheet'],
    ['PRN-075', '[browser] Save as PDF suggested filename (from the tab title)'],
    ['PRN-076', '[browser] print page loads in < 1.5 s'],
    ['PRN-077', '[browser] print page has no console errors'],
    ['PRN-079', '[browser] back from print returns to app state (print opens in a new tab)'],
    ['PRN-083', '[browser] Ctrl/Cmd+P gives the same output'],
    ['PRN-087', '[browser] two tabs printing different documents are independent'],
    ['PRN-099', '[manual] print page in Safari matches Chrome'],
  ];
  for (const [id, title] of todo) it.todo(`${id} ${title}`);
});

void firstWarehouse; void owner; void actor;
