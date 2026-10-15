/** Regression tests for the printing fixes (agent E): the document template, money formatting and document views. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { sampleInvoiceView, type DocumentView } from '../../src/modules/erp/documents';

vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/modules/erp/documents', () => import('../../src/modules/erp/documents'));
import { DocumentPreview } from '../../src/components/document-preview';

const printCss = readFileSync(resolve(__dirname, '../../src/app/print/print.css'), 'utf8');
const company = { ...blankWorkspace(false).company, name: 'Fix Traders', address: '12 Jodia Bazar, Karachi', logo: 'F' };
const render = (view: DocumentView) => renderToStaticMarkup(createElement(DocumentPreview, { view, company, branding: { template: 'standard', accent: '#087f69', footer: 'Bank: QA' }, assets: {} }));

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
