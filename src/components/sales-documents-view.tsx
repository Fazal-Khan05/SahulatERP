'use client';

import { useState } from 'react';
import { Button } from './ui/button';
import { InvoiceDetails } from './invoice-details';
import { formatMoney } from '@/modules/erp/money';
import type { Document, Workspace } from '@/modules/erp/types';

const salesKinds: Document['kind'][] = ['quotation', 'sales_order', 'delivery', 'sales_invoice', 'credit_note'];
const typeLabel: Record<string, string> = {
  quotation: 'Quotation', sales_order: 'Sales order', delivery: 'Delivery note',
  sales_invoice: 'Sales invoice', credit_note: 'Credit note',
};

export function SalesDocumentsView({ workspace, editable, busy, command, openNew }: {
  workspace: Workspace;
  editable: boolean;
  busy: string;
  command: (type: string, payload: Record<string, unknown>) => Promise<void>;
  openNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const all = workspace.documents.filter(document => salesKinds.includes(document.kind));
  const needle = query.trim().toLocaleLowerCase();
  const visible = all.filter(document => {
    const customer = workspace.parties.find(party => party.id === document.partyId);
    return (!needle || `${document.number} ${customer?.name || ''}`.toLocaleLowerCase().includes(needle))
      && (!kind || document.kind === kind)
      && (!status || document.status === status)
      && (!customerId || document.partyId === customerId)
      && (!fromDate || document.date >= fromDate)
      && (!toDate || document.date <= toDate);
  });
  const filtered = !!(query || kind || status || customerId || fromDate || toDate);

  function clear() { setQuery(''); setKind(''); setStatus(''); setCustomerId(''); setFromDate(''); setToDate(''); }

  return <section className="card">
    <div className="card-heading"><div><h2>Sales documents</h2><p>{visible.length} of {all.length} documents</p></div>{editable && <Button onClick={openNew}>New invoice</Button>}</div>
    <div className="list-filters" aria-label="Sales document filters">
      <label className="list-filter-search">Search<input aria-label="Search invoices" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Invoice number or customer"/></label>
      <label>Document type<select aria-label="Document type" value={kind} onChange={event => setKind(event.target.value)}><option value="">All types</option>{salesKinds.map(value => <option key={value} value={value}>{typeLabel[value]}</option>)}</select></label>
      <label>Status<select aria-label="Document status" value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option><option value="draft">Draft</option><option value="submitted">Submitted</option><option value="cancelled">Cancelled</option></select></label>
      <label>Customer<select aria-label="Customer" value={customerId} onChange={event => setCustomerId(event.target.value)}><option value="">All customers</option>{workspace.parties.filter(party => party.type === 'customer').map(party => <option key={party.id} value={party.id}>{party.name}</option>)}</select></label>
      <label>From date<input aria-label="From date" type="date" value={fromDate} max={toDate || undefined} onChange={event => setFromDate(event.target.value)}/></label>
      <label>To date<input aria-label="To date" type="date" value={toDate} min={fromDate || undefined} onChange={event => setToDate(event.target.value)}/></label>
      {filtered && <button className="list-filter-clear" type="button" onClick={clear}>Clear filters</button>}
    </div>
    <div className="table-scroll"><table><thead><tr>{['Document','Customer','Date','Type','Status','Total','Action'].map(head => <th key={head}>{head}</th>)}</tr></thead><tbody>{visible.length ? visible.map(document => <tr key={document.id}>
      <td>{document.number}</td><td>{workspace.parties.find(party => party.id === document.partyId)?.name || '—'}</td><td>{document.date}</td><td>{typeLabel[document.kind]}</td><td><span className={`badge ${document.status === 'submitted' ? 'success' : document.status === 'draft' ? 'warning' : 'info'}`}>{document.status}</span></td><td>{formatMoney(document.total)}</td>
      <td><div className="inventory-row-actions">{document.kind === 'sales_invoice' && <Button key="view" size="sm" variant="outline" aria-label={`View invoice ${document.number}`} onClick={() => setSelectedInvoiceId(document.id)}>View</Button>}{editable && document.status === 'draft' && <Button key="submit" size="sm" disabled={!!busy} onClick={() => command('submit_document', { id: document.id })}>Submit</Button>}{document.kind !== 'sales_invoice' && (!editable || document.status !== 'draft') && <span>{document.status === 'draft' ? 'Read only' : document.status === 'cancelled' ? 'Cancelled' : 'Posted'}</span>}</div></td>
    </tr>) : <tr><td colSpan={7}><div className="empty-state">No sales documents match these filters.</div></td></tr>}</tbody></table></div>
    <InvoiceDetails workspace={workspace} invoiceId={selectedInvoiceId} onClose={() => setSelectedInvoiceId(null)}/>
  </section>;
}
