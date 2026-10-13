'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { Download, Printer } from 'lucide-react';
import { Button } from './ui/button';
import { businessToday } from '@/modules/erp/dates';
import { accountBalance, commissionTotals, outstanding } from '@/modules/erp/engine';
import { toCsv } from '@/modules/erp/master-data';
import { D, formatMoney, money, sum } from '@/modules/erp/money';
import { agedBalances, balanceSheet, chartOf, generalLedger, landedCostPayable, partyStatement, profitAndLoss, salesAnalysis, stockMovements, stockValuation, trialBalance } from '@/modules/erp/reports';
import type { Workspace } from '@/modules/erp/types';

type ReportKey = 'aged_receivables' | 'aged_payables' | 'statement' | 'stock_valuation' | 'stock_movements' | 'sales_analysis' | 'profit_loss' | 'balance_sheet' | 'trial_balance' | 'general_ledger' | 'reconciliation';
type Table = { heads: string[]; rows: (string | number)[][]; footer?: (string | number)[]; moneyColumns: number[] };

const catalogue: { key: ReportKey; label: string; group: string; ledger: boolean; params: ('asOf' | 'range' | 'party' | 'item' | 'account' | 'groupBy' | 'warehouse')[] }[] = [
  { key: 'aged_receivables', label: 'Aged receivables', group: 'Customers', ledger: false, params: ['asOf'] },
  { key: 'statement', label: 'Customer / supplier statement', group: 'Customers', ledger: false, params: ['party', 'range'] },
  { key: 'sales_analysis', label: 'Sales analysis', group: 'Customers', ledger: false, params: ['range', 'groupBy'] },
  { key: 'aged_payables', label: 'Aged payables', group: 'Suppliers', ledger: true, params: ['asOf'] },
  { key: 'stock_valuation', label: 'Stock valuation', group: 'Stock', ledger: false, params: ['warehouse'] },
  { key: 'stock_movements', label: 'Stock movements', group: 'Stock', ledger: false, params: ['range', 'item'] },
  { key: 'profit_loss', label: 'Profit & loss', group: 'Accounts', ledger: true, params: ['range'] },
  { key: 'balance_sheet', label: 'Balance sheet', group: 'Accounts', ledger: true, params: ['asOf'] },
  { key: 'trial_balance', label: 'Trial balance', group: 'Accounts', ledger: true, params: ['asOf'] },
  { key: 'general_ledger', label: 'General ledger', group: 'Accounts', ledger: true, params: ['account', 'range'] },
  { key: 'reconciliation', label: 'Control reconciliation', group: 'Accounts', ledger: true, params: [] },
];

export function ReportsView({ workspace, ledgerView, stockVisible }: { workspace: Workspace; ledgerView: boolean; stockVisible: boolean }) {
  const today = businessToday();
  const year = today.slice(0, 4);
  const available = catalogue.filter(r => (ledgerView || !r.ledger) && (stockVisible || !r.key.startsWith('stock')) && (workspace.documents.length > 0 || r.group !== 'Customers' || r.key === 'aged_receivables'));
  const [key, setKey] = useState<ReportKey>(available[0]?.key ?? 'aged_receivables');
  const [asOf, setAsOf] = useState(today);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(today);
  const [partyId, setPartyId] = useState('');
  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [account, setAccount] = useState('1100');
  const [groupBy, setGroupBy] = useState<'customer' | 'item' | 'salesperson'>('customer');
  const report = catalogue.find(r => r.key === key)!;
  const chart = chartOf(workspace);

  const table = useMemo<Table>(() => {
    switch (key) {
      case 'aged_receivables': case 'aged_payables': { const a = agedBalances(workspace, key === 'aged_receivables' ? 'customer' : 'supplier', asOf); return { heads: [key === 'aged_receivables' ? 'Customer' : 'Supplier', 'Current', '1–30 days', '31–60 days', '61–90 days', 'Over 90', 'Total'], rows: a.rows.map(r => [r.name, r.current, r.d30, r.d60, r.d90, r.over90, r.total]), footer: ['Total', a.totals.current, a.totals.d30, a.totals.d60, a.totals.d90, a.totals.over90, a.totals.total], moneyColumns: [1, 2, 3, 4, 5, 6] }; }
      case 'statement': { if (!partyId) return { heads: ['Choose a customer or supplier'], rows: [], moneyColumns: [] }; const s = partyStatement(workspace, partyId, from, to); return { heads: ['Date', 'Reference', 'Description', 'Debit', 'Credit', 'Balance'], rows: [['', '', 'Opening balance', '', '', s.opening], ...s.lines.map(l => [l.date, l.reference, l.description, l.debit, l.credit, l.balance])], footer: ['', '', 'Closing balance', '', '', s.closing], moneyColumns: [3, 4, 5] }; }
      case 'sales_analysis': { const s = salesAnalysis(workspace, from, to, groupBy); return { heads: [groupBy === 'customer' ? 'Customer' : groupBy === 'item' ? 'Product' : 'Salesperson', 'Invoices', 'Quantity', 'Net sales', 'Returns', 'Net of returns'], rows: s.rows.map(r => [r.label, r.invoices, D(r.quantity).toString(), r.net, r.returns, r.netOfReturns]), footer: ['Total', s.total.invoices, D(s.total.quantity).toString(), s.total.net, s.total.returns, s.total.netOfReturns], moneyColumns: [3, 4, 5] }; }
      case 'stock_valuation': { const v = stockValuation(workspace, warehouseId || undefined); return { heads: ['SKU', 'Product', 'Warehouse', 'Quantity', 'Average cost', 'Value'], rows: v.rows.map(r => [r.sku, r.name, r.warehouse, D(r.quantity).toString(), r.average, r.value]), footer: ['', '', 'Total', '', '', v.total], moneyColumns: [4, 5] }; }
      case 'stock_movements': { const m = stockMovements(workspace, from, to, itemId || undefined); return { heads: ['Date', 'SKU', 'Product', 'Warehouse', 'Type', 'Quantity', 'Value', 'Reference'], rows: m.map(r => [r.date, r.sku, r.name, r.warehouse, r.type, D(r.quantity).toString(), r.value, r.reference]), moneyColumns: [6] }; }
      case 'profit_loss': { const p = profitAndLoss(workspace, from, to); return { heads: ['Code', 'Account', 'Amount'], rows: [['', 'REVENUE', ''], ...p.revenue.map(r => [r.code, r.name, r.amount]), ['', 'Total revenue', p.totalRevenue], ['', 'EXPENSES', ''], ...p.expenses.map(r => [r.code, r.name, r.amount]), ['', 'Total expenses', p.totalExpenses]], footer: ['', 'Net profit', p.netProfit], moneyColumns: [2] }; }
      case 'balance_sheet': { const b = balanceSheet(workspace, asOf); return { heads: ['Code', 'Account', 'Amount'], rows: [['', 'ASSETS', ''], ...b.assets.map(r => [r.code, r.name, r.amount]), ['', 'Total assets', b.totalAssets], ['', 'LIABILITIES', ''], ...b.liabilities.map(r => [r.code, r.name, r.amount]), ['', 'Total liabilities', b.totalLiabilities], ['', 'EQUITY', ''], ...b.equity.map(r => [r.code, r.name, r.amount]), ['', 'Total equity', b.totalEquity]], footer: ['', 'Assets − liabilities − equity', b.difference], moneyColumns: [2] }; }
      case 'trial_balance': { const t = trialBalance(workspace, asOf); return { heads: ['Code', 'Account', 'Debit', 'Credit'], rows: t.rows.map(r => [r.code, r.name, r.debit, r.credit]), footer: ['', 'Total', t.totalDebit, t.totalCredit], moneyColumns: [2, 3] }; }
      case 'general_ledger': { const g = generalLedger(workspace, account, from, to); return { heads: ['Date', 'Journal', 'Memo', 'Debit', 'Credit', 'Balance'], rows: [['', '', 'Opening balance', '', '', g.opening], ...g.rows.map(r => [r.date, r.journal, r.memo, r.debit, r.credit, r.balance])], footer: ['', '', 'Closing balance', '', '', g.closing], moneyColumns: [3, 4, 5] }; }
      case 'reconciliation': {
        const receivable = money(sum(workspace.documents.filter(d => d.kind === 'sales_invoice' && d.status === 'submitted').map(outstanding)));
        const payable = money(sum(workspace.documents.filter(d => d.kind === 'supplier_invoice' && d.status === 'submitted').map(d => D(outstanding(d)).mul(d.currency === 'PKR' ? 1 : D(d.fxRate)))).plus(landedCostPayable(workspace)));
        const inventory = stockValuation(workspace).total;
        const ct = commissionTotals(workspace);
        const cashSub = money(sum(['1000', ...workspace.bankAccounts.map(a => a.code)].map(c => accountBalance(workspace, c))));
        const rows: [string, string, string][] = [['Accounts receivable', receivable, accountBalance(workspace, '1100')], ['Accounts payable (bills + unbilled import charges)', payable, money(D(accountBalance(workspace, '2000')).negated())], ['Inventory', inventory, accountBalance(workspace, '1200')], ['Commission payable', money(D(ct.earned).minus(ct.paid)), money(D(accountBalance(workspace, '2200')).negated())], ['Bank & cash accounts', cashSub, cashSub]];
        return { heads: ['Control', 'Subledger', 'General ledger', 'Result'], rows: rows.map(([n, a, b]) => [n, a, b, D(a).minus(b).abs().lt('0.01') ? 'reconciled' : 'review']), moneyColumns: [1, 2] };
      }
    }
  }, [key, workspace, asOf, from, to, partyId, itemId, warehouseId, account, groupBy]);

  const subtitle = report.params.includes('range') ? `${from} to ${to}` : report.params.includes('asOf') ? `as at ${asOf}` : '';
  function exportCsv() {
    const rows = [...table.rows, ...(table.footer ? [table.footer] : [])].map(r => Object.fromEntries(table.heads.map((h, i) => [h, r[i] ?? ''])));
    const blob = new Blob([toCsv(rows, table.heads)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${key}-${asOf}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  const cell = (value: string | number, column: number): ReactNode => table.moneyColumns.includes(column) && value !== '' && typeof value === 'string' && /^-?\d/.test(value) ? formatMoney(value) : value === 'reconciled' || value === 'review' ? <span className={`badge ${value === 'reconciled' ? 'success' : 'warning'}`}>{value}</span> : value;
  const groups = [...new Set(available.map(r => r.group))];

  return <div className="reports-layout">
    <aside className="card reports-menu" aria-label="Reports">{groups.map(g => <div key={g}><div className="nav-label">{g.toUpperCase()}</div>{available.filter(r => r.group === g).map(r => <button key={r.key} className={`report-link ${key === r.key ? 'active' : ''}`} onClick={() => setKey(r.key)}>{r.label}</button>)}</div>)}</aside>
    <section className="card report-card">
      <div className="card-heading print-heading"><div><h2>{report.label}</h2><p>{workspace.company.name}{subtitle ? ` · ${subtitle}` : ''}</p></div><div className="inventory-actions no-print"><Button variant="outline" onClick={exportCsv} disabled={!table.rows.length}><Download size={16}/>Export CSV</Button><Button variant="outline" onClick={() => window.print()}><Printer size={16}/>Print</Button></div></div>
      <div className="list-filters no-print" aria-label="Report parameters">
        {report.params.includes('asOf') && <label>As at<input aria-label="As at date" type="date" value={asOf} onChange={e => setAsOf(e.target.value)}/></label>}
        {report.params.includes('range') && <><label>From<input aria-label="From date" type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>To<input aria-label="To date" type="date" value={to} onChange={e => setTo(e.target.value)}/></label></>}
        {report.params.includes('party') && <label className="list-filter-search">Customer / supplier<select aria-label="Statement party" value={partyId} onChange={e => setPartyId(e.target.value)}><option value="">Select…</option>{workspace.parties.filter(p => !p.archived).map(p => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}</select></label>}
        {report.params.includes('item') && <label>Product<select aria-label="Product filter" value={itemId} onChange={e => setItemId(e.target.value)}><option value="">All products</option>{workspace.items.map(i => <option key={i.id} value={i.id}>{i.sku} · {i.name}</option>)}</select></label>}
        {report.params.includes('warehouse') && <label>Warehouse<select aria-label="Warehouse filter" value={warehouseId} onChange={e => setWarehouseId(e.target.value)}><option value="">All warehouses</option>{workspace.warehouses.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
        {report.params.includes('account') && <label className="list-filter-search">Account<select aria-label="Ledger account" value={account} onChange={e => setAccount(e.target.value)}>{Object.entries(chart).map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}</select></label>}
        {report.params.includes('groupBy') && <label>Group by<select aria-label="Group by" value={groupBy} onChange={e => setGroupBy(e.target.value as typeof groupBy)}><option value="customer">Customer</option><option value="item">Product</option><option value="salesperson">Salesperson</option></select></label>}
      </div>
      <div className="table-scroll"><table className="report-table"><thead><tr>{table.heads.map((h, i) => <th key={h} className={table.moneyColumns.includes(i) ? 'num' : undefined}>{h}</th>)}</tr></thead><tbody>
        {table.rows.length ? table.rows.map((r, i) => <tr key={i} className={r[0] === '' && typeof r[1] === 'string' && r[1] === r[1].toUpperCase() && r[2] === '' ? 'report-section' : undefined}>{r.map((v, c) => <td key={c} className={table.moneyColumns.includes(c) ? 'num' : undefined}>{cell(v, c)}</td>)}</tr>) : <tr><td colSpan={table.heads.length}><div className="empty-state">Nothing to report for these parameters.</div></td></tr>}
      </tbody>{table.footer && <tfoot><tr>{table.footer.map((v, c) => <td key={c} className={table.moneyColumns.includes(c) ? 'num' : undefined}>{cell(v, c)}</td>)}</tr></tfoot>}</table></div>
    </section>
  </div>;
}
