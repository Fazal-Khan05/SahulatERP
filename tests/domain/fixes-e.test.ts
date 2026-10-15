/** Regression tests for the printing fixes (agent E): the document template, money formatting and document views. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { execute } from '../../src/modules/erp/engine';
import { formatMoney } from '../../src/modules/erp/money';
import { documentView, receiptView, sampleInvoiceView, type DocumentView } from '../../src/modules/erp/documents';
import type { Actor, Workspace } from '../../src/modules/erp/types';

vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/modules/erp/documents', () => import('../../src/modules/erp/documents'));
import { DocumentPreview } from '../../src/components/document-preview';

const printCss = readFileSync(resolve(__dirname, '../../src/app/print/print.css'), 'utf8');
const company = { ...blankWorkspace(false).company, name: 'Fix Traders', address: '12 Jodia Bazar, Karachi', logo: 'F' };
const render = (view: DocumentView) => renderToStaticMarkup(createElement(DocumentPreview, { view, company, branding: { template: 'standard', accent: '#087f69', footer: 'Bank: QA' }, assets: {} }));
const owner: Actor = { id: 'o', name: 'Owner', role: 'Owner', branchIds: [] };
let n = 0;
const run = (w: Workspace, type: string, payload: Record<string, unknown>) => execute(w, { type, payload, idempotencyKey: `fixes-e-${++n}` }, owner);
const purchase = (w: Workspace, kind: string, currency: string, fxRate: string, submit = true) => {
  const created = run(w, 'create_document', { kind, partyId: 's-1', warehouseId: 'khi-main', date: '2026-10-15', dueDate: '2026-11-14', currency, fxRate, lines: [{ itemId: 'i-1', quantity: '1500', price: '10', taxRate: '0' }] });
  const next = submit ? run(created.workspace, 'submit_document', { id: created.recordId }).workspace : created.workspace;
  return { w: next, id: created.recordId };
};

describe('D-16 the print template is isolated from the app table styles', () => {
  it('resets globals.css table, cell, paragraph and small rules inside .doc', () => {
    expect(printCss).toContain('.doc :where(table) { width: auto;');
    expect(printCss).toMatch(/\.doc :where\(th, td\) \{[^}]*padding: 0; border: 0; background: none;[^}]*white-space: normal;/);
    expect(printCss).toContain('.doc tr:hover { background: none; }');
    expect(printCss).toMatch(/\.doc :where\(h1, p\) \{[^}]*color: inherit;/);
    // Line cells outrank globals' `tbody tr:last-child td` (0,1,3) so the last line keeps its rule.
    expect(printCss).toContain('.doc .doc-lines td {');
    // The totals table sits in a lines cell and undoes the line-item header and cell styles.
    expect(printCss).toMatch(/\.doc-totals th \{[^}]*background: none;[^}]*text-transform: none;/);
    expect(printCss).toMatch(/\.doc \.doc-totals td \{[^}]*border: 0;/);
  });

  it('prints the last line, the totals and the footer as one unbreakable group', () => {
    const html = render(sampleInvoiceView());
    expect(html).toMatch(/<tbody><tr><td><strong>LED Panel Light · 24W<\/strong>/);
    const tail = html.slice(html.indexOf('<tbody class="doc-tail">'));
    expect(tail).toMatch(/^<tbody class="doc-tail"><tr><td><strong>Smart Extension Board<\/strong>/);
    expect(tail).toContain('<td class="doc-tail-cell" colSpan="6"><section class="doc-bottom">');
    expect(tail).toContain('class="doc-totals"');
    expect(tail).toContain('<footer class="doc-footer">');
    expect(printCss).toMatch(/@media print \{[\s\S]*\.doc-lines tr, \.doc-tail \{ break-inside: avoid; \}/);
  });

  it('a one-line document has no empty body group, and a receipt-style view spans two columns', () => {
    const one = render({ ...sampleInvoiceView(), lines: sampleInvoiceView().lines.slice(0, 1) });
    expect(one).toContain('</tr></thead><tbody class="doc-tail">');
    const receipt = render({ ...sampleInvoiceView(), lines: [{ description: 'Sales invoice INV-1', detail: '', quantity: '', unit: '', rate: '', discount: '', taxRate: '', amount: '10.0000' }] });
    expect(receipt).toContain('colSpan="2"');
  });
});

describe('D-24 drafts and cancelled documents are marked', () => {
  it('prints a banner and a watermark for draft and cancelled documents only', () => {
    const draft = render({ ...sampleInvoiceView(), status: 'draft' });
    expect(draft).toMatch(/^<article class="doc "[^>]*><p class="doc-status-banner doc-status-draft">Draft — not final until it is submitted<\/p><header/);
    expect(draft).toContain('<div class="doc-watermark doc-status-draft" data-mark="Draft" aria-hidden="true"></div></article>');
    const cancelled = render({ ...sampleInvoiceView(), status: 'cancelled' });
    expect(cancelled).toContain('<p class="doc-status-banner doc-status-cancelled">Cancelled — this document is void</p>');
    expect(cancelled).toContain('data-mark="Cancelled"');
    for (const status of ['submitted', 'cleared', 'bounced']) expect(render({ ...sampleInvoiceView(), status })).not.toMatch(/doc-status|doc-watermark/);
  });

  it('the watermark repeats on every printed page and never blocks the page', () => {
    expect(printCss).toMatch(/\.doc-watermark::after \{ content: attr\(data-mark\);/);
    expect(printCss).toMatch(/\.doc-watermark \{[^}]*pointer-events: none;/);
    expect(printCss).toMatch(/@media print \{[\s\S]*\.doc-watermark \{ position: fixed; \}/);
  });
});

describe('D-47 printed labels meet 4.5:1 on the white sheet', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(s => s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrastOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);
  it.each(['.doc-title-meta th', '.doc-meta dt', '.doc-label', '.doc-lines td small', '.doc-footer small'])('%s', selector => {
    const rule = printCss.split('\n').find(line => line.startsWith(`${selector} {`))!;
    const colour = /[{;] color: (#[0-9a-f]{6});/.exec(rule)![1];
    expect(contrastOnWhite(colour)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('D-15 reprints use the invoice-time tax snapshot', () => {
  const sell = (w: Workspace, partyId: string) => {
    const created = run(w, 'create_document', { kind: 'sales_invoice', partyId, warehouseId: 'khi-main', date: '2026-10-15', dueDate: '2026-11-14', lines: [{ itemId: 'i-1', quantity: '1', price: '2400', taxRate: '18' }] });
    return { w: run(created.workspace, 'submit_document', { id: created.recordId }).workspace, id: created.recordId };
  };
  const withParty = (w: Workspace, partyId: string, changes: Record<string, unknown>) => run(w, 'save_party', { ...w.parties.find(p => p.id === partyId)!, ...changes }).workspace;

  it('an invoice to a registered buyer keeps its tax id after the buyer changes it or de-registers', () => {
    const start = withParty(buildDemoWorkspace(), 'c-1', { registered: true, taxId: '1111111-1' });
    const { w, id } = sell(start, 'c-1');
    const later = withParty(w, 'c-1', { registered: false, taxId: '2222222-2' });
    const party = documentView(later, later.documents.find(d => d.id === id)!).party;
    expect(party).toMatchObject({ taxId: '1111111-1' });
    expect(party.taxStatus).toBeUndefined();
    const html = render(documentView(later, later.documents.find(d => d.id === id)!));
    expect(html).toContain('<span>NTN / STRN: 1111111-1</span>');
    expect(html).not.toContain('2222222-2');
  });

  it('an invoice to an unregistered buyer says so, even after the buyer registers', () => {
    const start = withParty(buildDemoWorkspace(), 'c-1', { registered: false, taxId: '' });
    const { w, id } = sell(start, 'c-1');
    const later = withParty(w, 'c-1', { registered: true, taxId: '3333333-3' });
    const view = documentView(later, later.documents.find(d => d.id === id)!);
    expect(view.party).toMatchObject({ taxId: '', taxStatus: 'Unregistered for sales tax' });
    expect(render(view)).toContain('<span>Unregistered for sales tax</span>');
  });

  it('documents without a snapshot (drafts, purchases) show the party as it is now', () => {
    const w = withParty(buildDemoWorkspace(), 's-1', { taxId: '4444444-4' });
    const { w: next, id } = purchase(w, 'purchase_order', 'PKR', '1');
    expect(documentView(next, next.documents.find(d => d.id === id)!).party).toMatchObject({ taxId: '4444444-4' });
  });
});

describe('D-14 foreign-currency documents print their own currency', () => {
  it('formatMoney keeps the PKR output and prints $ / ¥ for USD / CNY', () => {
    for (const v of ['1234.5', '-50', '0', '2400.0000']) expect(formatMoney(v, 'PKR')).toBe(formatMoney(v));
    expect(formatMoney('1234.5')).toBe('Rs 1,234.5');
    expect(formatMoney('2500000', true)).toBe('Rs 2.50m');
    expect(formatMoney('10', 'USD')).toBe('$10.00');
    expect(formatMoney('1234567.125', 'CNY')).toBe('¥1,234,567.13');
    expect(formatMoney('-1234.5', 'USD')).toBe('-$1,234.50');
  });

  it('a CNY purchase order prints yuan amounts plus a PKR total at the document rate', () => {
    const { w, id } = purchase(buildDemoWorkspace(), 'purchase_order', 'CNY', '39.5');
    const view = documentView(w, w.documents.find(d => d.id === id)!);
    expect(view.totals).toEqual([{ label: 'Subtotal', value: '15000.0000' }, { label: 'Total', value: '15000.0000', emphasis: true }, { label: 'Total in PKR', value: '592500.0000', currency: 'PKR' }]);
    const html = render(view);
    expect(html).toContain('<td class="num">¥10.00</td>');
    expect(html).toContain('<th>Total</th><td>¥15,000.00</td>');
    expect(html).toContain('<th>Total in PKR</th><td>Rs 592,500</td>');
    expect(html).not.toMatch(/<td class="num">Rs /);
  });

  it('PKR documents are unchanged: no PKR-equivalent line', () => {
    const { w, id } = purchase(buildDemoWorkspace(), 'purchase_order', 'PKR', '1');
    expect(documentView(w, w.documents.find(d => d.id === id)!).totals.map(t => t.label)).toEqual(['Subtotal', 'Total']);
  });

  it('a supplier payment against a USD bill prints the allocation in USD and the PKR amount paid', () => {
    const bill = purchase(buildDemoWorkspace(), 'supplier_invoice', 'USD', '280');
    const paid = run(bill.w, 'create_receipt', { partyId: 's-1', date: '2026-10-16', amount: '840000', method: 'bank', dueDate: '2026-10-16', allocations: [{ invoiceId: bill.id, amount: '3000' }] });
    const view = receiptView(paid.workspace, paid.workspace.receipts.find(r => r.id === paid.recordId)!);
    expect(view.lines[0]).toMatchObject({ amount: '3000.0000', currency: 'USD' });
    expect(view.totals).toEqual([{ label: 'Amount', value: '840000.0000', emphasis: true }]);
    const html = render(view);
    expect(html).toContain('<td class="num">$3,000.00</td>');
    expect(html).toContain('<th>Amount</th><td>Rs 840,000</td>');
  });
});
