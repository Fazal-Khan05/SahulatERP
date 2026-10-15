'use client';
import { useState } from 'react';
import { Plus, Printer } from 'lucide-react';
import { Button } from './ui/button';
import { Status, TableCard } from './table-card';
import { ShowMore, inventoryPageSize } from './inventory-view';
import { formatMoney } from '@/modules/erp/money';
import type { Receipt, Workspace } from '@/modules/erp/types';

const methods: [Receipt['method'], string][] = [['bank', 'Bank transfer'], ['cash', 'Cash'], ['cheque', 'Cheque / PDC']];
const statuses: Receipt['status'][] = ['received', 'deposited', 'cleared', 'bounced'];

/** Collections → Customer receipts, newest first, filtered by method and status; draws 100 rows at a time so thousands of receipts stay quick. */
export function CustomerReceipts({ workspace, editable, onRecord }: { workspace: Workspace; editable: boolean; onRecord: () => void }) {
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(inventoryPageSize);
  const customer = new Map(workspace.parties.map(p => [p.id, p]));
  const all = workspace.receipts.filter(r => customer.get(r.partyId)?.type !== 'supplier');
  const visible = all.filter(r => (!method || r.method === method) && (!status || r.status === status)).reverse();
  const filtered = !!(method || status);
  const clear = () => { setMethod(''); setStatus(''); setLimit(inventoryPageSize); };
  const refilter = (set: (value: string) => void) => (value: string) => { set(value); setLimit(inventoryPageSize); };
  const account = (r: Receipt) => workspace.bankAccounts.find(a => a.id === r.accountId)?.name ?? (r.accountId ? '—' : 'Legacy');
  const rows = visible.slice(0, limit).map(r => [r.number, customer.get(r.partyId)?.name || '—', r.date, r.method === 'cheque' ? r.chequeNo : r.method, account(r), <Status key="s" value={r.status}/>, formatMoney(r.amount),
    <a key="p" className="button button-outline button-sm" href={`/print/receipt/${r.id}?tenant=${workspace.tenantId}`} target="_blank" rel="noopener" aria-label={`Print ${r.number}`}><Printer size={14}/>Print</a>]);
  const toolbar = <div className="list-filters" role="group" aria-label="Customer receipt filters">
    <label>Method<select aria-label="Receipt method" value={method} onChange={e => refilter(setMethod)(e.target.value)}><option value="">All methods</option>{methods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Status<select aria-label="Receipt status" value={status} onChange={e => refilter(setStatus)(e.target.value)}><option value="">All statuses</option>{statuses.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
    {filtered && <button className="list-filter-clear" type="button" onClick={clear}>Clear filters</button>}
  </div>;
  const empty = all.length ? <>No receipts match these filters. <button className="text-button" type="button" onClick={clear}>Reset filters</button></> : editable ? 'No receipts yet. Record one with Record receipt above.' : 'No receipts yet.';
  return <TableCard title="Customer receipts" action={editable ? <Button onClick={onRecord}><Plus size={16}/>Record receipt</Button> : undefined} toolbar={toolbar}
    subtitle={filtered ? `${visible.length} of ${all.length} receipts` : `${all.length} records`} empty={empty}
    heads={['Receipt', 'Customer', 'Date', 'Method / cheque', 'Account', 'Status', 'Amount', 'Action']} numeric={[6]} rows={rows}>
    <ShowMore shown={rows.length} total={visible.length} noun="receipts" onMore={() => setLimit(n => n + inventoryPageSize)}/>
  </TableCard>;
}
