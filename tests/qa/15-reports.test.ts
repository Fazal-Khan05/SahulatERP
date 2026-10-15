import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commissionTotals, stock } from '../../src/modules/erp/engine';
import { filterBranch, scopeWorkspace } from '../../src/modules/erp/access';
import { toCsv } from '../../src/modules/erp/master-data';
import { formatMoney } from '../../src/modules/erp/money';
import { agedBalances, balanceSheet, generalLedger, landedCostPayable, partyStatement, profitAndLoss, salesAnalysis, stockMovements, stockValuation, trialBalance } from '../../src/modules/erp/reports';
import type { Workspace } from '../../src/modules/erp/types';
import { accountBalance, actor, buildDemoWorkspace, D, expectInvariants, freshCompany, invariants, money, outstanding, refused, run, sum, today, withDocument, withItem, withParty } from './helpers';

const T = today();
const MONTH = T.slice(0, 7);
const AS_OF = '2026-10-14';
const bal = (w: Workspace, code: string) => accountBalance(w, code);
const source = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8');
const line = (itemId: string, quantity = '1', price = '100', extra: Record<string, unknown> = {}) => ({ itemId, quantity, price, ...extra });
function base() {
  let w = freshCompany(); let item: string, item2: string, cust: string, cust2: string, sup: string;
  [w, item] = withItem(w, { name: 'LED Panel' }, { quantity: '1000', cost: '60' });
  [w, item2] = withItem(w, { name: 'Kettle' }, { quantity: '1000', cost: '30' });
  [w, cust] = withParty(w, 'customer', { name: 'Al-Noor Electronics' });
  [w, cust2] = withParty(w, 'customer', { name: 'Metro Home' });
  [w, sup] = withParty(w, 'supplier', { name: 'Shenzhen Bright' });
  return { w, item, item2, cust, cust2, sup };
}
const sell = (w: Workspace, cust: string, lines: Record<string, unknown>[], date = T, due = date) => withDocument(w, 'sales_invoice', cust, lines, { date, dueDate: due });
const receive = (w: Workspace, party: string, inv: string, amount: string, date = T, extra: Record<string, unknown> = {}) => run(w, 'create_receipt', { partyId: party, date, amount, method: 'bank', dueDate: date, allocations: [{ invoiceId: inv, amount }], accountId: 'main-bank', ...extra });
/** Mirrors Reports → Control reconciliation (src/components/reports-view.tsx). */
function reconciliation(w: Workspace) {
  const receivable = money(sum(w.documents.filter(d => d.kind === 'sales_invoice' && d.status === 'submitted').map(outstanding)));
  const payable = money(sum(w.documents.filter(d => d.kind === 'supplier_invoice' && d.status === 'submitted').map(d => D(outstanding(d)).mul(d.currency === 'PKR' ? 1 : D(d.fxRate)))).plus(landedCostPayable(w)));
  const ct = commissionTotals(w);
  const cash = money(sum(['1000', ...w.bankAccounts.map(a => a.code)].map(c => bal(w, c))));
  const rows: [string, string, string][] = [['Accounts receivable', receivable, bal(w, '1100')], ['Accounts payable', payable, money(D(bal(w, '2000')).negated())], ['Inventory', stockValuation(w).total, bal(w, '1200')], ['Commission payable', money(D(ct.earned).minus(ct.paid)), money(D(bal(w, '2200')).negated())], ['Bank & cash accounts', cash, cash]];
  return rows.map(([name, sub, gl]) => ({ name, sub, gl, result: D(sub).minus(gl).abs().lt('0.01') ? 'reconciled' : 'review' }));
}
const allReconciled = (w: Workspace) => reconciliation(w).every(r => r.result === 'reconciled');
const catalogue = () => source('src/components/reports-view.tsx').split('const catalogue')[1].split('];')[0];

describe('15 Reports (RPT)', () => {
  it('RPT-001 the reports catalogue lists all 11 reports [browser: index rendering]', () => {
    const labels = [...catalogue().matchAll(/label: '([^']+)'/g)].map(m => m[1]);
    expect(labels).toEqual(['Aged receivables', 'Customer / supplier statement', 'Sales analysis', 'Aged payables', 'Stock valuation', 'Stock movements', 'Profit & loss', 'Balance sheet', 'Trial balance', 'General ledger', 'Control reconciliation']);
  });

  it('RPT-002 aged receivables buckets current / 1–30 / 31–60 / 61–90 / 90+ per customer with totals', () => {
    let { w, item, cust, cust2 } = base();
    for (const due of ['2026-10-20', '2026-10-01', '2026-08-30', '2026-07-20', '2026-06-01']) [w] = sell(w, cust, [line(item, '1', '100')], due <= AS_OF ? due : AS_OF, due);
    [w] = sell(w, cust2, [line(item, '1', '50')], '2026-10-10', '2026-10-10');
    const a = agedBalances(w, 'customer', AS_OF);
    expect(a.rows.map(r => [r.name, r.current, r.d30, r.d60, r.d90, r.over90, r.total])).toEqual([
      ['Al-Noor Electronics', '100.0000', '100.0000', '100.0000', '100.0000', '100.0000', '500.0000'],
      ['Metro Home', '0.0000', '50.0000', '0.0000', '0.0000', '0.0000', '50.0000'],
    ]);
    expect(a.totals).toMatchObject({ current: '100.0000', d30: '150.0000', total: '550.0000' });
  });

  it('RPT-003 aged receivables total equals the receivable control', () => {
    const w = buildDemoWorkspace();
    expect(agedBalances(w, 'customer', '2099-12-31').totals.total).toBe(bal(w, '1100'));
  });

  it('RPT-004 aged receivables as of a past date excludes receipts made after that date', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = sell(w, cust, [line(item, '1', '1000')], '2026-09-01', '2026-09-01');
    w = receive(w, cust, inv, '1000', '2026-10-10').workspace;
    // On 2026-09-30 the invoice was still unpaid and 29 days overdue.
    expect(agedBalances(w, 'customer', '2026-09-30').totals.d30).toBe('1000.0000');
  });

  it('RPT-005 as-of before any invoice: no rows and zero totals', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item)], '2026-09-01');
    const a = agedBalances(w, 'customer', '2026-01-01');
    expect(a.rows).toEqual([]);
    expect(a.totals).toEqual({ partyId: '', name: 'Total', current: '0.0000', d30: '0.0000', d60: '0.0000', d90: '0.0000', over90: '0.0000', total: '0.0000' });
  });

  it('RPT-006 walk-in sales age under one "Walk-in customer" row', () => {
    let { w, item } = base(); let walkIn: string;
    [w, walkIn] = withParty(w, 'customer', { name: 'Walk-in customer' });
    [w] = withDocument(w, 'sales_invoice', walkIn, [line(item, '1', '100')], { partyName: 'Ali' });
    [w] = withDocument(w, 'sales_invoice', walkIn, [line(item, '1', '200')], { partyName: 'Bilal' });
    expect(agedBalances(w, 'customer', T).rows.map(r => [r.name, r.total])).toEqual([['Walk-in customer', '300.0000']]);
  });

  it('RPT-007 an archived customer with a balance is still included', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '1', '100')]);
    w = run(w, 'set_archived', { kind: 'party', id: cust, archived: true }).workspace;
    expect(agedBalances(w, 'customer', T).rows.map(r => r.name)).toEqual(['Al-Noor Electronics']);
  });

  it('RPT-008 customer statement: opening, invoice, credit note, receipt, running balance, closing', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = sell(w, cust, [line(item, '10', '100')]);
    w = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '2' }] }).workspace;
    w = receive(w, cust, inv, '300').workspace;
    const s = partyStatement(w, cust, `${MONTH}-01`, T);
    expect(s.opening).toBe('0.0000');
    expect(s.lines.map(l => [l.description, l.debit, l.credit, l.balance])).toEqual([['Sales invoice', '1000.0000', '', '1000.0000'], ['Credit note', '', '200.0000', '800.0000'], ['Receipt · bank', '', '300.0000', '500.0000']]);
    expect(s.closing).toBe('500.0000');
  });

  it('RPT-009 statement closing balance equals the customer outstanding', () => {
    const w = buildDemoWorkspace();
    for (const id of ['c-1', 'c-2', 'c-3', 'c-4']) {
      const open = money(sum(w.documents.filter(d => d.partyId === id && d.kind === 'sales_invoice' && d.status === 'submitted').map(outstanding)));
      expect(partyStatement(w, id, '2026-01-01', '2099-12-31').closing, id).toBe(open);
    }
  });

  it('RPT-010 statement date range: opening balance is prior activity', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '1', '400')], '2026-09-10');
    [w] = sell(w, cust, [line(item, '1', '100')], '2026-10-02');
    const s = partyStatement(w, cust, '2026-10-01', '2026-10-31');
    expect(s.opening).toBe('400.0000');
    expect(s.lines).toHaveLength(1);
    expect(s.closing).toBe('500.0000');
  });

  it.todo('RPT-011 [browser] statement print is branded with company header and period');

  it('RPT-012 supplier statement: bills, returns and payments move the balance in the right direction', () => {
    let { w, item, sup } = base(); let bill: string;
    [w, bill] = withDocument(w, 'supplier_invoice', sup, [line(item, '10', '100')]);
    w = run(w, 'return_document', { id: bill, date: T, lines: [{ lineId: w.documents.find(d => d.id === bill)!.lines[0].id, quantity: '1' }] }).workspace;
    w = receive(w, sup, bill, '400').workspace;
    const s = partyStatement(w, sup, `${MONTH}-01`, T);
    expect(s.lines.map(l => l.description)).toEqual(['Supplier bill', 'Return to supplier', 'Payment · bank']);
    const owed = money(D(outstanding(w.documents.find(d => d.id === bill)!)));
    expect(owed).toBe('500.0000');
    // The statement balance must fall after a payment and close at what is still owed.
    expect(s.lines.map(l => [l.debit, l.credit, l.balance])[2], 'payment line').toEqual(['', '400.0000', '500.0000']);
    expect(s.closing).toBe(owed);
  });

  it('RPT-013 statement without a party: empty, no crash', () => {
    expect(partyStatement(base().w, '', '2026-01-01', T)).toEqual({ opening: '0.0000', lines: [], closing: '0.0000' });
    expect(source('src/components/reports-view.tsx')).toContain("'Choose a customer or supplier'");
  });

  it('RPT-014 sales analysis by salesperson [documented: net and returns per person present; COGS, margin and commission not present]', () => {
    let { w, item, cust } = base();
    const e = run(w, 'save_employee', { name: 'Hamza Khan', role: 'OB', territory: '', salary: '1', allowance: '0', deduction: '0', attendance: 30, active: true }); w = e.workspace;
    [w] = sell(w, cust, [line(item, '10', '100', { employeeId: e.recordId })]);
    const r = salesAnalysis(w, `${MONTH}-01`, T, 'salesperson').rows[0];
    expect(r).toEqual({ key: e.recordId, label: 'Hamza Khan', invoices: 1, quantity: '10.0000', net: '1000.0000', returns: '0.0000', netOfReturns: '1000.0000' });
  });

  it('RPT-015 sales analysis by customer groups walk-in sales under the walk-in account', () => {
    let { w, item, cust } = base(); let walkIn: string;
    [w, walkIn] = withParty(w, 'customer', { name: 'Walk-in customer' });
    [w] = withDocument(w, 'sales_invoice', walkIn, [line(item, '1', '100')], { partyName: 'Ali' });
    [w] = withDocument(w, 'sales_invoice', walkIn, [line(item, '1', '100')], { partyName: 'Bilal' });
    [w] = sell(w, cust, [line(item, '1', '150')]);
    expect(salesAnalysis(w, `${MONTH}-01`, T, 'customer').rows.map(r => [r.label, r.invoices, r.net])).toEqual([['Walk-in customer', 2, '200.0000'], ['Al-Noor Electronics', 1, '150.0000']]);
  });

  it('RPT-016 sales analysis by item: quantity and net [documented: margin not present]', () => {
    let { w, item, item2, cust } = base();
    [w] = sell(w, cust, [line(item, '3', '100'), line(item2, '2', '50', { discount: '10' })]);
    expect(salesAnalysis(w, `${MONTH}-01`, T, 'item').rows.map(r => [r.label, r.quantity, r.net])).toEqual([['LED Panel', '3.0000', '300.0000'], ['Kettle', '2.0000', '90.0000']]);
    expect(Object.keys(salesAnalysis(w, `${MONTH}-01`, T, 'item').total)).not.toContain('margin');
  });

  it('RPT-017 sales analysis filters by invoice date', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '1', '100')], '2026-09-15');
    [w] = sell(w, cust, [line(item, '1', '200')], '2026-10-02');
    expect(salesAnalysis(w, '2026-10-01', '2026-10-31', 'customer').total.net).toBe('200.0000');
    expect(salesAnalysis(w, '2026-09-01', '2026-09-30', 'customer').total.net).toBe('100.0000');
  });

  it('RPT-018 sales analysis total (net of credit notes) equals P&L revenue for the range', () => {
    const w = buildDemoWorkspace();
    for (const [from, to] of [['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31'], ['2026-01-01', '2026-12-31']]) {
      const revenue = profitAndLoss(w, from, to).revenue.find(r => r.code === '4000')?.amount ?? '0.0000';
      expect(salesAnalysis(w, from, to, 'item').total.netOfReturns, `${from}`).toBe(revenue);
    }
  });

  it('RPT-019 aged payables bucket by bill due date', () => {
    let { w, item, sup } = base();
    [w] = withDocument(w, 'supplier_invoice', sup, [line(item, '1', '300')], { date: '2026-08-01', dueDate: '2026-08-31' });
    [w] = withDocument(w, 'supplier_invoice', sup, [line(item, '1', '200')], { date: '2026-10-01', dueDate: '2026-11-01' });
    expect(agedBalances(w, 'supplier', AS_OF).rows.map(r => [r.name, r.current, r.d30, r.d60, r.total])).toEqual([['Shenzhen Bright', '200.0000', '0.0000', '300.0000', '500.0000']]);
  });

  it('RPT-020 aged payables total vs payable control [documented: aging excludes unbilled landed-cost charges; aging + landed-cost payable = control]', () => {
    let { w, item, sup } = base();
    [w] = withDocument(w, 'supplier_invoice', sup, [line(item, '2', '300')]);
    expect(agedBalances(w, 'supplier', T).totals.total).toBe(money(D(bal(w, '2000')).negated()));
    const demo = buildDemoWorkspace();
    expect(money(D(agedBalances(demo, 'supplier', '2099-12-31').totals.total).plus(landedCostPayable(demo)))).toBe(money(D(bal(demo, '2000')).negated()));
  });

  it('RPT-021 stock valuation per item and warehouse with quantity, average and value', () => {
    let { w, item } = base();
    w = run(w, 'save_warehouse', { name: 'Port store', branchId: w.branches[0].id }).workspace;
    w = run(w, 'stock_transfer', { itemId: item, from: w.warehouses[0].id, to: 'port-store', quantity: '250', date: T }).workspace;
    const v = stockValuation(w);
    expect(v.rows.map(r => [r.name, r.warehouse, r.quantity, r.average, r.value])).toEqual([['LED Panel', 'Main store', '750.0000', '60.0000', '45000.0000'], ['LED Panel', 'Port store', '250.0000', '60.0000', '15000.0000'], ['Kettle', 'Main store', '1000.0000', '30.0000', '30000.0000']]);
    expect(v.total).toBe('90000.0000');
    expect(stockValuation(w, 'port-store').total).toBe('15000.0000');
  });

  it('RPT-022 valuation total equals the inventory control', () => {
    const w = buildDemoWorkspace();
    expect(stockValuation(w).total).toBe(bal(w, '1200'));
  });

  it('RPT-023 stock movements by date range and item filter', () => {
    let { w, item, item2, cust } = base();
    [w] = sell(w, cust, [line(item, '5', '100'), line(item2, '2', '50')]);
    const rows = stockMovements(w, `${MONTH}-01`, T, item);
    expect(rows.map(r => [r.name, r.type, r.quantity, r.value])).toEqual([['LED Panel', 'adjustment', '1000.0000', '60000.0000'], ['LED Panel', 'sale', '-5.0000', '-300.0000']]);
    expect(stockMovements(w, '2020-01-01', '2020-12-31')).toEqual([]);
  });

  it('RPT-024 P&L for a month: revenue, COGS, expenses and net [documented: no separate gross-profit line]', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '10', '100')]);
    w = run(w, 'record_expense', { accountId: 'cash', amount: '150', date: T, memo: 'Fuel' }).workspace;
    const pl = profitAndLoss(w, `${MONTH}-01`, `${MONTH}-31`);
    expect(pl).toEqual({ revenue: [{ code: '4000', name: 'Sales revenue', amount: '1000.0000' }], expenses: [{ code: '5000', name: 'Cost of goods sold', amount: '600.0000' }, { code: '5300', name: 'Operating expense', amount: '150.0000' }], totalRevenue: '1000.0000', totalExpenses: '750.0000', netProfit: '250.0000' });
  });

  it('RPT-025 P&L for a year equals the sum of its months', () => {
    const w = buildDemoWorkspace();
    const year = profitAndLoss(w, '2026-01-01', '2026-12-31').netProfit;
    const months = sum(Array.from({ length: 12 }, (_, i) => { const m = String(i + 1).padStart(2, '0'); return profitAndLoss(w, `2026-${m}-01`, `2026-${m}-31`).netProfit; }));
    expect(money(months)).toBe(year);
  });

  it('RPT-026 P&L for an empty range is zero', () => {
    expect(profitAndLoss(buildDemoWorkspace(), '2020-01-01', '2020-12-31')).toEqual({ revenue: [], expenses: [], totalRevenue: '0.0000', totalExpenses: '0.0000', netProfit: '0.0000' });
  });

  it('RPT-027 balance sheet as of a date has zero difference', () => {
    const bs = balanceSheet(buildDemoWorkspace(), '2026-10-31');
    expect(bs.difference).toBe('0.0000');
    expect(bs.assets.length).toBeGreaterThan(0);
    expect(bs.equity.at(-1)!.name).toBe('Retained earnings (current)');
  });

  it('RPT-028 balance sheet at an earlier date excludes later postings', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '1', '100')], '2026-10-02');
    expect(balanceSheet(w, '2026-10-01').assets.find(r => r.code === '1100')).toBeUndefined();
    expect(balanceSheet(w, '2026-10-02').assets.find(r => r.code === '1100')!.amount).toBe('100.0000');
  });

  it('RPT-029 trial balance lists every account with a balance; totals equal', () => {
    const w = buildDemoWorkspace();
    const tb = trialBalance(w, '2099-12-31');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const nonZero = [...new Set(w.journals.flatMap(j => j.lines.map(l => l.account)))].filter(c => !D(bal(w, c)).isZero()).sort();
    expect(tb.rows.map(r => r.code)).toEqual(nonZero);
  });

  it('RPT-030 general ledger per account with running balance', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = sell(w, cust, [line(item, '1', '500')]);
    w = receive(w, cust, inv, '200').workspace;
    const gl = generalLedger(w, '1100', `${MONTH}-01`, T);
    expect(gl.rows.map(r => [r.debit, r.credit, r.balance])).toEqual([['500.0000', '', '500.0000'], ['', '200.0000', '300.0000']]);
    expect(gl.closing).toBe(bal(w, '1100'));
  });

  it('RPT-031 control reconciliation shows every control reconciled with both figures', () => {
    const w = buildDemoWorkspace();
    const r = reconciliation(w);
    expect(r.map(x => x.name)).toEqual(['Accounts receivable', 'Accounts payable', 'Inventory', 'Commission payable', 'Bank & cash accounts']);
    expect(r.every(x => x.result === 'reconciled')).toBe(true);
    expect(r[0].sub).toBe(r[0].gl);
  });

  it('RPT-032 a manual journal to 1100 makes the receivable control show a variance', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '1', '100')]);
    w = run(w, 'create_journal', { memo: 'Adjust AR', date: T, lines: [{ account: '1100', debit: '25', credit: '0' }, { account: '3000', debit: '0', credit: '25' }] }).workspace;
    expect(reconciliation(w)[0]).toEqual({ name: 'Accounts receivable', sub: '100.0000', gl: '125.0000', result: 'review' });
  });

  it('RPT-033 each report produces CSV with its headings and one line per row [browser: download]', () => {
    const w = buildDemoWorkspace();
    const tables: [string[], (string | number)[][]][] = [
      [['Customer', 'Current', '1–30 days', '31–60 days', '61–90 days', 'Over 90', 'Total'], agedBalances(w, 'customer', '2026-10-31').rows.map(r => [r.name, r.current, r.d30, r.d60, r.d90, r.over90, r.total])],
      [['SKU', 'Product', 'Warehouse', 'Quantity', 'Average cost', 'Value'], stockValuation(w).rows.map(r => [r.sku, r.name, r.warehouse, r.quantity, r.average, r.value])],
      [['Code', 'Account', 'Debit', 'Credit'], trialBalance(w, '2026-10-31').rows.map(r => [r.code, r.name, r.debit, r.credit])],
    ];
    for (const [heads, rows] of tables) {
      const csv = toCsv(rows.map(r => Object.fromEntries(heads.map((h, i) => [h, r[i]]))), heads).split('\n');
      expect(csv[0]).toBe(heads.join(','));
      expect(csv).toHaveLength(rows.length + 1);
    }
    expect(source('src/components/reports-view.tsx')).toContain('Export CSV');
  });

  it('RPT-034 export of 10,000 rows completes quickly with a sane size', () => {
    const heads = ['Date', 'SKU', 'Product', 'Warehouse', 'Type', 'Quantity', 'Value', 'Reference'];
    const rows = Array.from({ length: 10000 }, (_, i) => ({ Date: '2026-10-01', SKU: `SKU-${i}`, Product: `Item ${i}`, Warehouse: 'Main store', Type: 'sale', Quantity: '-1.0000', Value: '-60.0000', Reference: `INV-2026-${i}` }));
    const start = performance.now();
    const csv = toCsv(rows, heads);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(csv.split('\n')).toHaveLength(10001);
    expect(csv.length).toBeLessThan(1_000_000);
  });

  it('RPT-035 CSV holds raw numbers, not formatted "Rs 1,234" strings', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '1', '1234')]);
    const pl = profitAndLoss(w, `${MONTH}-01`, `${MONTH}-31`);
    const csv = toCsv(pl.revenue.map(r => ({ Code: r.code, Account: r.name, Amount: r.amount })), ['Code', 'Account', 'Amount']);
    expect(csv).toBe('Code,Account,Amount\n4000,Sales revenue,1234.0000');
  });

  it('RPT-036 CSV keeps Unicode names; download is typed UTF-8', () => {
    expect(toCsv([{ Customer: 'حبیب ٹریڈرز', Total: '10.0000' }], ['Customer', 'Total'])).toBe('Customer,Total\nحبیب ٹریڈرز,10.0000');
    expect(source('src/components/reports-view.tsx')).toContain("type: 'text/csv;charset=utf-8'");
  });

  it('RPT-037 empty report exports headers only [documented: the Export button is disabled when the table has no rows]', () => {
    expect(toCsv([], ['Code', 'Account', 'Debit', 'Credit'])).toBe('Code,Account,Debit,Credit');
    expect(source('src/components/reports-view.tsx')).toContain('disabled={!table.rows.length}');
  });

  it('RPT-038 date defaults [case-corrected: range defaults to 1 January of the current year → today (year to date); as-at defaults to today]', () => {
    const view = source('src/components/reports-view.tsx');
    expect(view).toContain('useState(`${year}-01-01`)');
    expect(view).toContain('const [to, setTo] = useState(today)');
    expect(view).toContain('const [asOf, setAsOf] = useState(today)');
  });

  it('RPT-039 from after to: empty results, no crash', () => {
    const w = buildDemoWorkspace();
    expect(profitAndLoss(w, '2026-12-31', '2026-01-01').netProfit).toBe('0.0000');
    expect(salesAnalysis(w, '2026-12-31', '2026-01-01', 'customer').rows).toEqual([]);
    expect(generalLedger(w, '1100', '2026-12-31', '2026-01-01').rows).toEqual([]);
    expect(stockMovements(w, '2026-12-31', '2026-01-01')).toEqual([]);
  });

  it('RPT-040 a far-future range is empty', () => {
    const w = buildDemoWorkspace();
    expect(profitAndLoss(w, '2099-01-01', '2099-12-31').netProfit).toBe('0.0000');
    expect(partyStatement(w, 'c-1', '2099-01-01', '2099-12-31').lines).toEqual([]);
  });

  it('RPT-041 Salesperson: Reports not in their navigation and no ledger data in the projection', () => {
    expect(source('src/components/workbench.tsx')).toContain("'Salesperson':['dashboard','sales','collections','commissions']");
    const view = scopeWorkspace(buildDemoWorkspace(), actor('Salesperson', { employeeId: 'e-4' }));
    expect(view.journals).toEqual([]);
    expect(profitAndLoss(view, '2026-01-01', '2026-12-31').netProfit).toBe('0.0000');
  });

  it('RPT-042 Sales Manager sees operational reports, not P&L (ledger reports need a ledger role) [browser: menu]', () => {
    expect(catalogue()).toContain("{ key: 'profit_loss', label: 'Profit & loss', group: 'Accounts', ledger: true");
    expect(catalogue()).toContain("{ key: 'sales_analysis', label: 'Sales analysis', group: 'Customers', ledger: false");
    const view = scopeWorkspace(buildDemoWorkspace(), actor('Sales Manager'));
    expect(view.journals).toEqual([]);
    expect(salesAnalysis(view, '2026-09-01', '2026-09-30', 'customer').total.net).not.toBe('0.0000');
  });

  it('RPT-043 Auditor sees every report with full data', () => {
    const w = buildDemoWorkspace();
    const view = scopeWorkspace(w, actor('Auditor'));
    expect(view.journals).toHaveLength(w.journals.length);
    expect(profitAndLoss(view, '2026-01-01', '2026-12-31')).toEqual(profitAndLoss(w, '2026-01-01', '2026-12-31'));
  });

  it('RPT-044 branch-limited Accountant: ledger reports are not offered (journals are not sent) [defect]', () => {
    const w = buildDemoWorkspace();
    const view = scopeWorkspace(w, actor('Accountant', { branchIds: ['karachi'] }));
    expect(view.journals).toEqual([]);
    // With no journals the P&L shows nothing although the company has revenue.
    expect(profitAndLoss(view, '2026-01-01', '2026-12-31').totalRevenue).toBe('0.0000');
    expect(D(profitAndLoss(w, '2026-01-01', '2026-12-31').totalRevenue).gt(0)).toBe(true);
    // Expected: ledgerView is off for branch-limited members; actually it depends only on role and the branch picker.
    expect(source('src/components/workbench.tsx')).toMatch(/const ledgerView=[^;]*branchIds/);
  });

  it('RPT-045 branch filter applies to stock and sales reports', () => {
    const w = buildDemoWorkspace();
    const lahore = filterBranch(w, 'lahore');
    expect(stockValuation(lahore).rows.every(r => r.warehouse === 'Lahore · Distribution')).toBe(true);
    expect(salesAnalysis(lahore, '2026-09-01', '2026-10-31', 'customer').rows.map(r => r.label)).toEqual(['Metro Home Stores']);
    expect(money(D(stockValuation(lahore).total).plus(stockValuation(filterBranch(w, 'karachi')).total))).toBe(stockValuation(w).total);
  });

  it.todo('RPT-046 [browser] Overview "Needs attention" link opens the correct report/queue');
  it.todo('RPT-047 [browser] report tables scroll horizontally on a phone with totals visible');
  it.todo('RPT-048 [browser] printing a report uses clean print CSS');
  it.todo('RPT-049 [browser] hiding Reports removes the sidebar entry; Overview unaffected');

  it('RPT-050 aging after a partial receipt keeps the remainder in its original bucket', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = sell(w, cust, [line(item, '1', '1000')], '2026-08-20', '2026-08-25');
    w = receive(w, cust, inv, '400', '2026-10-01').workspace;
    expect(agedBalances(w, 'customer', AS_OF).totals).toMatchObject({ d60: '600.0000', total: '600.0000' });
  });

  it('RPT-051 aging is reduced by a credit note', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = sell(w, cust, [line(item, '10', '100')]);
    w = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '3' }] }).workspace;
    expect(agedBalances(w, 'customer', T).totals.total).toBe('700.0000');
  });

  it('RPT-052 customer credit (return after full payment) shows as a negative in Current', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = sell(w, cust, [line(item, '10', '100')], '2026-08-01', '2026-08-01');
    w = receive(w, cust, inv, '1000').workspace;
    w = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '2' }] }).workspace;
    expect(agedBalances(w, 'customer', T).totals).toMatchObject({ current: '-200.0000', over90: '0.0000', total: '-200.0000' });
    expect(bal(w, '1100')).toBe('-200.0000');
  });

  it('RPT-053 statement with a bounced cheque shows the receipt and its reversal', () => {
    const w = buildDemoWorkspace();
    const s = partyStatement(w, 'c-4', '2026-09-01', '2026-10-31');
    expect(s.closing).toBe('65490.0000');
    expect(s.lines.map(l => l.description)).toEqual(['Sales invoice', 'Receipt · cheque PDC-0982', expect.stringMatching(/bounce|dishonour|reversal/i)]);
  });

  it('RPT-054 statement ordering is by date, then document type, then number (stable)', () => {
    let { w, item, cust } = base(); let a: string;
    [w, a] = sell(w, cust, [line(item, '1', '100')], '2026-10-05');
    w = receive(w, cust, a, '50', '2026-10-05').workspace;
    [w] = sell(w, cust, [line(item, '1', '300')], '2026-10-05');
    [w] = sell(w, cust, [line(item, '1', '200')], '2026-10-01');
    const refs = partyStatement(w, cust, '2026-10-01', '2026-10-31').lines.map(l => [l.date, l.reference]);
    expect(refs).toEqual([['2026-10-01', 'INV-2026-0003'], ['2026-10-05', 'INV-2026-0001'], ['2026-10-05', 'INV-2026-0002'], ['2026-10-05', 'REC-0001']]);
    expect(partyStatement(w, cust, '2026-10-01', '2026-10-31')).toEqual(partyStatement(w, cust, '2026-10-01', '2026-10-31'));
  });

  it('RPT-055 sales analysis margin after landed cost [documented: not present; COGS incl. landed cost is visible in P&L 5000]', () => {
    const w = buildDemoWorkspace();
    expect(Object.keys(salesAnalysis(w, '2026-09-01', '2026-10-31', 'item').rows[0])).not.toContain('margin');
    expect(D(bal(w, '5000')).gt(0)).toBe(true);
  });

  it('RPT-056 sales analysis excludes drafts and cancelled documents', () => {
    let { w, item, cust } = base(); let d1: string;
    [w] = sell(w, cust, [line(item, '1', '100')]);
    [w] = withDocument(w, 'sales_invoice', cust, [line(item, '1', '999')], {}, false);
    [w, d1] = withDocument(w, 'sales_invoice', cust, [line(item, '1', '777')], {}, false);
    w = run(w, 'cancel_document', { id: d1 }).workspace;
    expect(salesAnalysis(w, `${MONTH}-01`, T, 'customer').total).toMatchObject({ invoices: 1, net: '100.0000' });
  });

  it('RPT-057 stock movement values sum to the valuation change over the range', () => {
    const w = buildDemoWorkspace();
    const before = sum(w.stockMoves.filter(m => m.date < '2026-09-10').map(m => m.value));
    const moved = sum(stockMovements(w, '2026-09-10', '2099-12-31').map(r => r.value));
    expect(money(before.plus(moved))).toBe(stockValuation(w).total);
  });

  it('RPT-058 P&L includes import charges classified as expense', () => {
    const pl = profitAndLoss(buildDemoWorkspace(), '2026-09-01', '2026-09-30');
    expect(pl.expenses.find(r => r.code === '5300')!.amount).toBe('50000.0000');
  });

  it('RPT-059 P&L includes payroll', () => {
    const w = buildDemoWorkspace();
    const approve = w.journals.find(j => j.sourceId.endsWith(':approve'))!;
    expect(profitAndLoss(w, '2026-09-01', '2026-09-30').expenses.find(r => r.code === '5200')!.amount).toBe(approve.lines.find(l => l.account === '5200')!.debit);
  });

  it('RPT-060 P&L includes FX gains and losses', () => {
    let { w, item, sup } = base(); let bill: string;
    [w, bill] = withDocument(w, 'supplier_invoice', sup, [line(item, '10', '10')], { currency: 'USD', fxRate: '280' });
    w = receive(w, sup, bill, '100', T, { amount: '27500' }).workspace;
    expect(profitAndLoss(w, `${MONTH}-01`, `${MONTH}-31`).revenue).toEqual([]);
    expect(profitAndLoss(w, `${MONTH}-01`, `${MONTH}-31`).expenses.find(r => r.code === '5400')!.amount).toBe('-500.0000');
  });

  it('RPT-061 cheques in hand on the balance sheet [documented: an uncleared cheque posts nothing, so it is not an asset until cleared]', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = sell(w, cust, [line(item, '1', '100')]);
    const before = balanceSheet(w, T);
    w = receive(w, cust, inv, '100', T, { method: 'cheque', chequeNo: 'PDC-1', accountId: undefined }).workspace;
    expect(balanceSheet(w, T)).toEqual(before);
  });

  it('RPT-062 balance sheet shows import deposits (1400)', () => {
    let { w, item, sup } = base(); let grn: string;
    [w, grn] = withDocument(w, 'goods_receipt', sup, [line(item, '10', '50')]);
    const sh = run(w, 'create_shipment', { documentId: grn, eta: T });
    w = run(sh.workspace, 'add_shipment_cost', { id: sh.recordId, label: 'Container deposit', amount: '25000', classification: 'deposit', basis: 'value' }).workspace;
    w = run(w, 'allocate_shipment', { id: sh.recordId, date: T }).workspace;
    expect(balanceSheet(w, T).assets.find(r => r.code === '1400')).toEqual({ code: '1400', name: 'Deposits & advances', amount: '25000.0000' });
  });

  it('RPT-063 trial balance always omits zero-balance accounts [documented: no option to show them]', () => {
    const w = run(freshCompany(), 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '0.0001', date: T }).workspace;
    const back = run(w, 'bank_transfer', { fromId: 'cash', toId: 'main-bank', amount: '0.0001', date: T }).workspace;
    expect(trialBalance(back, T).rows).toEqual([]);
  });

  it('RPT-064 general ledger with a date filter starts from an opening balance', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '1', '100')], '2026-09-10');
    [w] = sell(w, cust, [line(item, '1', '50')], '2026-10-02');
    const gl = generalLedger(w, '1100', '2026-10-01', '2026-10-31');
    expect(gl.opening).toBe('100.0000');
    expect(gl.rows.map(r => r.balance)).toEqual(['150.0000']);
  });

  it('RPT-065 reconciliation on an empty (reset) company: all zero and reconciled [documented: verified on a fresh company; the reset script is hosted]', () => {
    const r = reconciliation(freshCompany());
    expect(r.every(x => x.sub === '0.0000' && x.gl === '0.0000' && x.result === 'reconciled')).toBe(true);
  });

  it.todo('RPT-066 [browser] report parameters while switching tabs (acceptable either way; no crash)');
  it.todo('RPT-067 [browser] reports are keyboard accessible');

  it('RPT-068 P&L on 100k journals in < 3 s', () => {
    const w = freshCompany();
    for (let i = 0; i < 100000; i++) w.journals.push({ id: `j${i}`, number: `JV-${i}`, sourceId: `s${i}`, date: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`, memo: 'bulk', status: 'posted', lines: [{ account: '1100', debit: '2.0000', credit: '0.0000' }, { account: '4000', debit: '0.0000', credit: '2.0000' }] });
    const start = performance.now();
    const pl = profitAndLoss(w, '2026-01-01', '2026-12-31');
    expect(performance.now() - start).toBeLessThan(3000);
    expect(pl.totalRevenue).toBe('200000.0000');
  });

  it('RPT-069 aging with 10k customers in < 3 s', () => {
    const w = freshCompany();
    for (let i = 0; i < 10000; i++) {
      w.parties.push({ id: `p${i}`, name: `Customer ${i}`, type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: 'Retailer' });
      w.documents.push({ id: `d${i}`, number: `INV-2026-${i}`, kind: 'sales_invoice', status: 'submitted', partyId: `p${i}`, warehouseId: 'main-store', date: '2026-09-01', dueDate: '2026-09-01', currency: 'PKR', fxRate: '1', lines: [], net: '100.0000', tax: '0.0000', total: '100.0000', paid: '0.0000', returned: '0.0000', notes: '' });
    }
    const start = performance.now();
    const a = agedBalances(w, 'customer', AS_OF);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(a.rows).toHaveLength(10000);
    expect(a.totals.d60).toBe('1000000.0000');
  });

  it('RPT-070 statement for a customer with no activity [documented: opening and closing 0 with no lines; the table shows an "Opening balance" row rather than "No activity"]', () => {
    const { w, cust2 } = base();
    expect(partyStatement(w, cust2, '2026-01-01', T)).toEqual({ opening: '0.0000', lines: [], closing: '0.0000' });
  });

  it('RPT-071 walk-in supplier statement groups all walk-in purchases', () => {
    let { w, item } = base(); let walkIn: string;
    [w, walkIn] = withParty(w, 'supplier', { name: 'Walk-in supplier' });
    [w] = withDocument(w, 'supplier_invoice', walkIn, [line(item, '1', '100')], { partyName: 'Market A' });
    [w] = withDocument(w, 'supplier_invoice', walkIn, [line(item, '1', '50')], { partyName: 'Market B' });
    expect(partyStatement(w, walkIn, `${MONTH}-01`, T).lines).toHaveLength(2);
    expect(agedBalances(w, 'supplier', T).rows.map(r => [r.name, r.total])).toEqual([['Walk-in supplier', '150.0000']]);
  });

  it('RPT-072 sales analysis by salesperson with splits gives each person their share [defect]', () => {
    let { w, item, cust } = base();
    const a = run(w, 'save_employee', { name: 'Hamza Khan', role: 'OB', territory: '', salary: '1', allowance: '0', deduction: '0', attendance: 30, active: true }); w = a.workspace;
    const b = run(w, 'save_employee', { name: 'Sara Malik', role: 'ASM', territory: '', salary: '1', allowance: '0', deduction: '0', attendance: 30, active: true }); w = b.workspace;
    [w] = sell(w, cust, [line(item, '10', '100', { splits: [{ employeeId: a.recordId, share: '60' }, { employeeId: b.recordId, share: '40' }] })]);
    const rows = salesAnalysis(w, `${MONTH}-01`, T, 'salesperson').rows.map(r => [r.label, r.net]);
    expect(rows).toEqual([['Hamza Khan', '600.0000'], ['Sara Malik', '400.0000']]);
  });

  it('RPT-073 sales analysis has a "no salesperson" bucket [case-corrected: labelled "Unassigned"]', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '1', '100')]);
    expect(salesAnalysis(w, `${MONTH}-01`, T, 'salesperson').rows).toEqual([expect.objectContaining({ key: 'none', label: 'Unassigned', net: '100.0000' })]);
  });

  it('RPT-074 export file name includes report key and date [browser: actual download]', () => {
    expect(source('src/components/reports-view.tsx')).toContain('a.download = `${key}-${asOf}.csv`');
  });

  it('RPT-075 CSV quotes notes containing commas, quotes and newlines', () => {
    expect(toCsv([{ Memo: 'Line one\nline two, "quoted"', Amount: '1.0000' }], ['Memo', 'Amount'])).toBe('Memo,Amount\n"Line one\nline two, ""quoted""",1.0000');
  });

  it('RPT-076 report currency label [case-corrected: amounts are shown with "Rs", not "PKR"] [browser: headings]', () => {
    expect(formatMoney('1234.5')).toBe('Rs 1,234.5');
  });

  it.todo('RPT-077 [browser] report numbers use tabular numerals');

  it('RPT-078 negative numbers format consistently [documented: "Rs -1,234.5" with a leading hyphen-minus]', () => {
    expect(formatMoney('-1234.5')).toBe('Rs -1,234.5');
    expect(formatMoney('-0.0001')).toBe('Rs -0');
  });

  it.todo('RPT-079 [browser] totals row is bold / sticky');

  it('RPT-080 statement works across locked months', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '1', '100')], '2026-09-10');
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    expect(partyStatement(w, cust, '2026-09-01', '2026-10-31').closing).toBe('100.0000');
  });

  it('RPT-081 aging and statement agree per customer', () => {
    const w = buildDemoWorkspace();
    for (const row of agedBalances(w, 'customer', '2099-12-31').rows) expect(partyStatement(w, row.partyId, '2026-01-01', '2099-12-31').closing).toBe(row.total);
  });

  it('RPT-082 trial balance is consistent with balance sheet and P&L', () => {
    const w = buildDemoWorkspace(); const asOf = '2099-12-31';
    const tb = trialBalance(w, asOf), bs = balanceSheet(w, asOf), pl = profitAndLoss(w, '0000-01-01', asOf);
    const net = (prefix: string) => sum(tb.rows.filter(r => r.code.startsWith(prefix)).map(r => D(r.debit || 0).minus(r.credit || 0)));
    expect(money(net('1'))).toBe(bs.totalAssets);
    expect(money(net('2').negated())).toBe(bs.totalLiabilities);
    expect(money(net('4').plus(net('5')).negated())).toBe(pl.netProfit);
    expect(bs.equity.at(-1)!.amount).toBe(pl.netProfit);
  });

  it('RPT-083 reconciliation after a bounce sequence', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = sell(w, cust, [line(item, '1', '500')]);
    const r = receive(w, cust, inv, '500', T, { method: 'cheque', chequeNo: 'B1', accountId: undefined });
    w = run(r.workspace, 'update_cheque', { id: r.recordId, status: 'deposited', date: T, accountId: 'main-bank' }).workspace;
    w = run(w, 'update_cheque', { id: r.recordId, status: 'cleared', date: T }).workspace;
    w = run(w, 'update_cheque', { id: r.recordId, status: 'bounced', date: T }).workspace;
    expect(allReconciled(w)).toBe(true);
    expect(reconciliation(w)[0].sub).toBe('500.0000');
  });

  it('RPT-084 reconciliation after a period reopen and reversal', () => {
    let w = run(freshCompany(), 'create_journal', { memo: 'Misc', date: '2026-09-10', lines: [{ account: '5300', debit: '10', credit: '0' }, { account: '1001', debit: '0', credit: '10' }] }).workspace;
    const id = w.journals.at(-1)!.id;
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    w = run(w, 'set_period', { month: '2026-09', locked: false }).workspace;
    w = run(w, 'reverse_journal', { id, date: '2026-09-11' }).workspace;
    expect(allReconciled(w)).toBe(true);
    expect(trialBalance(w, '2026-09-30').rows).toEqual([]);
  });

  it('RPT-085 demo company reports match the seeded data', () => {
    const w = buildDemoWorkspace();
    expect(salesAnalysis(w, '2026-09-01', '2026-09-30', 'customer').total).toMatchObject({ invoices: 4, net: '877500.0000' });
    expect(agedBalances(w, 'customer', '2026-10-31').totals.total).toBe(bal(w, '1100'));
    expect(allReconciled(w)).toBe(true);
    expectInvariants(w);
  });

  it('RPT-086 with a branch picked, operational reports filter and ledger stays company-wide', () => {
    const w = buildDemoWorkspace();
    const k = filterBranch(w, 'karachi');
    expect(k.journals).toBe(w.journals);
    expect(trialBalance(k, '2099-12-31')).toEqual(trialBalance(w, '2099-12-31'));
    expect(D(stockValuation(k).total).lt(stockValuation(w).total)).toBe(true);
    expect(source('src/components/workbench.tsx')).toContain('const ledgerView=canReadLedger(role)&&!branch');
  });

  it('RPT-087 direct API export endpoint [documented: not present; exports are generated in the browser]', () => {
    expect(readdirSync(resolve(__dirname, '../../src/app/api')).sort()).toEqual(['branding', 'demo-reset', 'workspace']);
  });

  it.todo('RPT-088 [browser] empty-state text is helpful ("Nothing to report for these parameters.")');
  it.todo('RPT-089 [browser] report selector usable on a phone');
  it.todo('RPT-090 [browser] deep link to a specific report (report choice is component state, not routed)');

  it('RPT-091 stock valuation includes archived items that still hold stock', () => {
    let { w, item } = base();
    w = run(w, 'set_archived', { kind: 'item', id: item, archived: true }).workspace;
    expect(stockValuation(w).rows.some(r => r.itemId === item)).toBe(true);
    expect(stockValuation(w).total).toBe(bal(w, '1200'));
  });

  it('RPT-092 stock valuation omits zero-stock items [documented: always omitted, no toggle]', () => {
    let { w, item, item2, cust } = base();
    [w] = sell(w, cust, [line(item2, '1000', '50')]);
    expect(stock(w, item2).quantity).toBe('0.0000');
    expect(stockValuation(w).rows.map(r => r.itemId)).toEqual([item]);
  });

  it('RPT-093 aged payables for USD bills are in PKR at the bill rate [documented: no currency column]', () => {
    let { w, item, sup } = base();
    [w] = withDocument(w, 'supplier_invoice', sup, [line(item, '10', '10')], { currency: 'USD', fxRate: '280' });
    const a = agedBalances(w, 'supplier', T);
    expect(a.totals.total).toBe('28000.0000');
    expect(Object.keys(a.rows[0])).not.toContain('currency');
  });

  it('RPT-094 statement for a USD supplier is in PKR', () => {
    let { w, item, sup } = base();
    [w] = withDocument(w, 'supplier_invoice', sup, [line(item, '10', '10')], { currency: 'USD', fxRate: '280' });
    const s = partyStatement(w, sup, `${MONTH}-01`, T);
    expect(s.lines.map(l => [l.description, l.debit || l.credit])).toEqual([['Supplier bill', '28000.0000']]);
    expect(s.closing).toBe('28000.0000');
  });

  it('RPT-095 sales analysis by item nets returns', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = sell(w, cust, [line(item, '10', '100')]);
    w = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '4' }] }).workspace;
    expect(salesAnalysis(w, `${MONTH}-01`, T, 'item').rows[0]).toMatchObject({ quantity: '10.0000', net: '1000.0000', returns: '400.0000', netOfReturns: '600.0000' });
  });

  it('RPT-096 an invoice dated 2026-10-31 stays in October', () => {
    let { w, item, cust } = base();
    [w] = sell(w, cust, [line(item, '1', '100')], '2026-10-31');
    expect(profitAndLoss(w, '2026-10-01', '2026-10-31').totalRevenue).toBe('100.0000');
    expect(profitAndLoss(w, '2026-11-01', '2026-11-30').totalRevenue).toBe('0.0000');
  });

  it.todo('RPT-097 [browser] reports reflect a command made in another tab on next load');
  it.todo('RPT-098 [manual] exported CSV opens in Excel with correct columns');

  it('RPT-099 report table headers [documented: header cells are <th> in <thead> without an explicit scope attribute] [browser: screen-reader check]', () => {
    const view = source('src/components/reports-view.tsx');
    expect(view).toContain('<thead><tr>{table.heads.map((h, i) => <th key={h}');
    expect(view).not.toContain('scope=');
  });

  it('RPT-100 end to end: after a full trading cycle every report reconciles to the ledger and to each other', () => {
    let w = buildDemoWorkspace();
    const inv = run(w, 'create_document', { kind: 'sales_invoice', partyId: 'c-2', warehouseId: 'lhe-main', date: '2026-10-08', dueDate: '2026-10-20', lines: [{ itemId: 'i-4', quantity: '5', price: '6800', discount: '0', taxRate: '18', employeeId: 'e-3', splits: [] }] });
    w = run(inv.workspace, 'submit_document', { id: inv.recordId }).workspace;
    w = run(w, 'create_receipt', { partyId: 'c-2', date: '2026-10-09', amount: '20000', method: 'cash', dueDate: '2026-10-09', allocations: [{ invoiceId: inv.recordId, amount: '20000' }], accountId: 'cash' }).workspace;
    w = run(w, 'record_expense', { accountId: 'main-bank', amount: '12000', date: '2026-10-09', memo: 'Warehouse rent' }).workspace;
    expect(allReconciled(w)).toBe(true);
    expectInvariants(w);
    const asOf = '2026-10-31';
    expect(agedBalances(w, 'customer', asOf).totals.total).toBe(bal(w, '1100'));
    expect(money(D(agedBalances(w, 'supplier', asOf).totals.total).plus(landedCostPayable(w)))).toBe(money(D(bal(w, '2000')).negated()));
    expect(stockValuation(w).total).toBe(bal(w, '1200'));
    for (const row of agedBalances(w, 'customer', asOf).rows) expect(partyStatement(w, row.partyId, '2026-01-01', asOf).closing).toBe(row.total);
    expect(salesAnalysis(w, '2026-01-01', asOf, 'customer').total.netOfReturns).toBe(profitAndLoss(w, '2026-01-01', asOf).totalRevenue);
    const tb = trialBalance(w, asOf), bs = balanceSheet(w, asOf);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(bs.difference).toBe('0.0000');
    expect(bs.equity.at(-1)!.amount).toBe(profitAndLoss(w, '0000-01-01', asOf).netProfit);
    expect(invariants(w).trialBalanced).toBe(true);
  });
});
