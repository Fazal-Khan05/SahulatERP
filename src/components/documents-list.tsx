'use client';
import { useState } from 'react';
import { ArrowRight, Plus, Printer } from 'lucide-react';
import { Button } from './ui/button';
import { DocumentDetails } from './document-details';
import { DocumentEditor } from './document-editor';
import { ConvertDialog, nextKind, remainingLines } from './document-dialogs';
import { documentTitle, documentPartyName } from '@/modules/erp/documents';
import { formatMoney } from '@/modules/erp/money';
import type { Actor, Document, Workspace } from '@/modules/erp/types';

type CommandResult = { ok: boolean; message: string; recordId?: string };
type CommandFn = (type: string, payload: Record<string, unknown>) => Promise<CommandResult>;
type Kind = Document['kind'];
const salesKinds: Kind[] = ['quotation', 'sales_order', 'delivery', 'sales_invoice', 'credit_note'];
const purchaseKinds: Kind[] = ['purchase_order', 'goods_receipt', 'supplier_invoice', 'supplier_return'];

/** Filtered document list for Sales or Purchasing with View / Convert / Submit / Print and a "New" menu per kind. */
export function DocumentsList({ side, workspace, actor, editable, busy, command }: { side: 'sales' | 'purchasing'; workspace: Workspace; actor: Actor; editable: boolean; busy: string; command: CommandFn }) {
  const kinds = side === 'sales' ? salesKinds : purchaseKinds;
  const creatable = (side === 'sales' ? ['sales_invoice', 'quotation', 'sales_order', 'delivery'] : ['purchase_order', 'goods_receipt', 'supplier_invoice']) as Exclude<Kind, 'credit_note' | 'supplier_return'>[];
  const partyType = side === 'sales' ? 'customer' : 'supplier';
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [partyId, setPartyId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<typeof creatable[number] | null>(null);
  const [converting, setConverting] = useState<Document | null>(null);
  const all = workspace.documents.filter(d => kinds.includes(d.kind));
  const needle = query.trim().toLocaleLowerCase();
  const visible = all.filter(d => {
    return (!needle || `${d.number} ${documentPartyName(workspace, d)}`.toLocaleLowerCase().includes(needle)) && (!kind || d.kind === kind) && (!status || d.status === status) && (!partyId || d.partyId === partyId) && (!fromDate || d.date >= fromDate) && (!toDate || d.date <= toDate);
  }).slice().reverse();
  const filtered = !!(query || kind || status || partyId || fromDate || toDate);
  const clear = () => { setQuery(''); setKind(''); setStatus(''); setPartyId(''); setFromDate(''); setToDate(''); };
  const convertible = (d: Document) => editable && d.status === 'submitted' && !!nextKind[d.kind] && remainingLines(workspace, d).some(r => r.remaining.gt(0));

  return <section className="card">
    <div className="card-heading"><div><h2>{side === 'sales' ? 'Sales documents' : 'Purchase documents'}</h2><p>{visible.length} of {all.length} documents</p></div>
      {editable && <div className="inventory-actions">{creatable.map(k => <Button key={k} variant={k === creatable[0] ? 'default' : 'outline'} onClick={() => setCreating(k)}><Plus size={16}/>{k === 'sales_invoice' ? 'New invoice' : `New ${documentTitle(k).toLowerCase()}`}</Button>)}</div>}
    </div>
    <div className="list-filters" aria-label={`${side === 'sales' ? 'Sales' : 'Purchase'} document filters`}>
      <label className="list-filter-search">Search<input aria-label={side === 'sales' ? 'Search invoices' : 'Search purchase documents'} type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={`Document number or ${partyType}`}/></label>
      <label>Document type<select aria-label="Document type" value={kind} onChange={e => setKind(e.target.value)}><option value="">All types</option>{kinds.map(k => <option key={k} value={k}>{documentTitle(k)}</option>)}</select></label>
      <label>Status<select aria-label="Document status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option><option value="draft">Draft</option><option value="submitted">Submitted</option><option value="cancelled">Cancelled</option></select></label>
      <label>{partyType === 'customer' ? 'Customer' : 'Supplier'}<select aria-label={partyType === 'customer' ? 'Customer' : 'Supplier'} value={partyId} onChange={e => setPartyId(e.target.value)}><option value="">All {partyType}s</option>{workspace.parties.filter(p => p.type === partyType && !p.archived).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>From date<input aria-label="From date" type="date" value={fromDate} max={toDate || undefined} onChange={e => setFromDate(e.target.value)}/></label>
      <label>To date<input aria-label="To date" type="date" value={toDate} min={fromDate || undefined} onChange={e => setToDate(e.target.value)}/></label>
      {filtered && <button className="list-filter-clear" type="button" onClick={clear}>Clear filters</button>}
    </div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label={`${side === 'sales' ? 'Sales' : 'Purchase'} documents table`}><table><thead><tr>{['Document', partyType === 'customer' ? 'Customer' : 'Supplier', 'Date', 'Type', 'Status', 'Total', 'Action'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{visible.length ? visible.map(d => <tr key={d.id}>
      <td>{d.number}</td><td>{documentPartyName(workspace, d)}</td><td>{d.date}</td><td>{documentTitle(d.kind)}</td><td><span className={`badge ${d.status === 'submitted' ? 'success' : d.status === 'draft' ? 'warning' : 'info'}`}>{d.status}</span></td><td>{formatMoney(d.total)}{d.currency !== 'PKR' ? ` ${d.currency}` : ''}</td>
      <td><div className="inventory-row-actions">
        <Button size="sm" variant="outline" aria-label={`View ${d.kind === 'sales_invoice' ? 'invoice' : documentTitle(d.kind).toLowerCase()} ${d.number}`} onClick={() => setSelectedId(d.id)}>View</Button>
        {editable && d.status === 'draft' && <Button size="sm" disabled={!!busy} onClick={() => command('submit_document', { id: d.id })}>Submit</Button>}
        {convertible(d) && <Button size="sm" variant="outline" aria-label={`Convert ${d.number}`} onClick={() => setConverting(d)}><ArrowRight size={14}/>{nextKind[d.kind] === 'delivery' ? 'Deliver' : nextKind[d.kind] === 'goods_receipt' ? 'Receive' : nextKind[d.kind] === 'sales_invoice' || nextKind[d.kind] === 'supplier_invoice' ? 'Invoice' : 'Convert'}</Button>}
        <a className="button button-outline button-sm" href={`/print/${d.kind}/${d.id}?tenant=${workspace.tenantId}`} target="_blank" rel="noopener" aria-label={`Print ${d.number}`}><Printer size={14}/>Print</a>
      </div></td>
    </tr>) : <tr><td colSpan={7}><div className="empty-state">{all.length ? <>No {side === 'sales' ? 'sales' : 'purchase'} documents match these filters. <button className="text-button" type="button" onClick={clear}>Reset filters</button></> : `No ${side === 'sales' ? 'sales' : 'purchase'} documents yet.${editable ? ` Create one with ${side === 'sales' ? 'New invoice' : 'New purchase order'} above.` : ''}`}</div></td></tr>}</tbody></table></div>
    <p className="table-scroll-hint">Swipe sideways to see every column.</p>
    <DocumentDetails workspace={workspace} actor={actor} documentId={selectedId} editable={editable} busy={busy} command={command} onClose={() => setSelectedId(null)}/>
    {creating && <DocumentEditor open kind={creating} workspace={workspace} actor={actor} busy={busy} onClose={() => setCreating(null)} command={command}/>}
    {converting && <ConvertDialog source={converting} workspace={workspace} busy={busy} onClose={() => setConverting(null)} command={command}/>}
  </section>;
}
