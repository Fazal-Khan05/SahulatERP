'use client';
import { useState } from 'react';
import { ArrowRight, Pencil, Printer, Send, Undo2, XCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { DocumentEditor } from './document-editor';
import { ConvertDialog, ReturnDialog, nextKind, remainingLines } from './document-dialogs';
import { documentTitle, documentView } from '@/modules/erp/documents';
import { canRun } from '@/modules/erp/engine';
import { D, formatMoney } from '@/modules/erp/money';
import type { Actor, Document, Workspace } from '@/modules/erp/types';

type CommandResult = { ok: boolean; message: string; recordId?: string };
type CommandFn = (type: string, payload: Record<string, unknown>) => Promise<CommandResult>;
const label = (value: string) => value.replaceAll('_', ' ');

/** Full view of any document with its chain and the actions that apply to it. Dialog name stays "Invoice INV-…" for sales invoices. */
export function DocumentDetails({ workspace, actor, documentId, editable, busy, command, onClose }: {
  workspace: Workspace;
  actor: Actor;
  documentId: string | null;
  editable: boolean;
  busy: string;
  command: CommandFn;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [converting, setConverting] = useState(false);
  const [returning, setReturning] = useState(false);
  const doc = workspace.documents.find(d => d.id === documentId);
  if (!doc) return null;
  const view = documentView(workspace, doc);
  const source = workspace.documents.find(d => d.id === doc.parentId);
  const children = workspace.documents.filter(d => d.parentId === doc.id);
  const receipts = workspace.receipts.filter(r => r.allocations.some(a => a.invoiceId === doc.id));
  const remaining = nextKind[doc.kind] ? remainingLines(workspace, doc).some(r => r.remaining.gt(0)) : false;
  const canConvert = editable && doc.status === 'submitted' && !!nextKind[doc.kind] && remaining && canRun(actor.role, 'convert_document');
  const canReturn = editable && doc.status === 'submitted' && ['sales_invoice', 'supplier_invoice'].includes(doc.kind) && doc.lines.some(l => D(l.quantity).gt(l.returned)) && canRun(actor.role, 'return_document');
  const canSubmit = editable && doc.status === 'draft' && canRun(actor.role, 'submit_document');
  const canEdit = editable && doc.status === 'draft' && canRun(actor.role, 'update_document');
  const canCancel = editable && doc.status === 'draft' && canRun(actor.role, 'cancel_document');
  const balance = D(doc.total).minus(doc.paid).minus(doc.returned);
  const title = doc.kind === 'sales_invoice' ? `Invoice ${doc.number}` : `${documentTitle(doc.kind)} ${doc.number}`;
  const printable = ['credit_note', 'supplier_return'].includes(doc.kind) ? doc.kind : doc.kind;

  return <>
    <Dialog open={!editing} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="invoice-dialog">
        <div className="invoice-heading">
          <div><span className="invoice-eyebrow">{documentTitle(doc.kind).toUpperCase()}</span><DialogTitle>{title}</DialogTitle><DialogDescription>Issued {doc.date}{doc.dueDate ? ` · Due ${doc.dueDate}` : ''}</DialogDescription></div>
          <div className="invoice-heading-actions"><a className="button button-outline button-sm" href={`/print/${printable}/${doc.id}?tenant=${workspace.tenantId}`} target="_blank" rel="noopener" aria-label={`Print ${doc.number}`}><Printer size={14}/>Print / PDF</a><span className={`badge ${doc.status === 'submitted' ? 'success' : doc.status === 'cancelled' ? 'danger' : 'warning'}`}>{label(doc.status)}</span></div>
        </div>
        {(canSubmit || canEdit || canCancel || canConvert || canReturn) && <div className="doc-actions">
          {canEdit && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil size={14}/>Edit draft</Button>}
          {canSubmit && <Button size="sm" disabled={!!busy} onClick={() => command('submit_document', { id: doc.id })}><Send size={14}/>Submit</Button>}
          {canConvert && <Button size="sm" onClick={() => setConverting(true)}><ArrowRight size={14}/>{nextKind[doc.kind] === 'delivery' ? 'Deliver' : nextKind[doc.kind] === 'goods_receipt' ? 'Receive goods' : nextKind[doc.kind] === 'sales_invoice' || nextKind[doc.kind] === 'supplier_invoice' ? 'Invoice' : `Create ${documentTitle(nextKind[doc.kind]).toLowerCase()}`}</Button>}
          {canReturn && <Button size="sm" variant="outline" onClick={() => setReturning(true)}><Undo2 size={14}/>Return</Button>}
          {canCancel && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { if (window.confirm(`Cancel draft ${doc.number}? It stays in the list as cancelled.`)) command('cancel_document', { id: doc.id, reason: '' }); }}><XCircle size={14}/>Cancel draft</Button>}
        </div>}
        <div className="invoice-parties">
          <section><span className="invoice-section-label">FROM</span><strong>{workspace.company.name}</strong><span>{workspace.company.address}</span>{workspace.company.taxId && <span>Tax ID: {workspace.company.taxId}</span>}</section>
          <section><span className="invoice-section-label">{view.partyLabel.toUpperCase()}</span><strong>{view.party.name}</strong>{view.party.address && <span>{view.party.address}</span>}{view.party.email && <span>{view.party.email}</span>}{view.party.taxId && <span>Tax ID: {view.party.taxId}</span>}</section>
        </div>
        <div className="invoice-meta">{view.meta.map(m => <span key={m.label}><strong>{m.label}</strong>{m.value}</span>)}{source && <span><strong>Source</strong>{source.number}</span>}</div>
        <section className="invoice-section"><h3>Items</h3><div className="table-scroll"><table className="invoice-lines">
          <thead><tr><th>Product</th><th>Quantity</th><th>Unit price</th><th>Discount</th><th>Tax</th><th className="align-right">Line total</th></tr></thead>
          <tbody>{doc.lines.map(l => { const item = workspace.items.find(i => i.id === l.itemId); const net = D(l.quantity).mul(l.price).mul(D(100).minus(l.discount)).div(100); const tax = net.mul(l.taxRate).div(100); const sp = workspace.employees.find(e => e.id === l.employeeId)?.name; return <tr key={l.id}>
            <td><strong>{item?.name ?? 'Unknown product'}</strong><small>{item?.sku ?? l.itemId}{sp ? ` · ${sp}` : ''}{D(l.returned).gt(0) ? ` · ${D(l.returned).toString()} returned` : ''}</small></td>
            <td>{D(l.quantity).toString()} {item?.unit ?? ''}</td><td>{formatMoney(l.price)}</td><td>{D(l.discount).toString()}%</td><td>{D(l.taxRate).toString()}% · {formatMoney(tax.toString())}</td><td className="align-right amount">{formatMoney(net.plus(tax).toString())}</td>
          </tr>; })}</tbody>
        </table></div></section>
        <div className="invoice-bottom">
          <div className="invoice-related">
            {doc.notes && <section><h3>Notes</h3><p style={{ whiteSpace: 'pre-wrap' }}>{doc.notes}</p></section>}
            {(source || children.length > 0) && <section><h3>Document chain</h3>
              {source && <div className="invoice-related-row"><span><strong>{source.number}</strong><small>{documentTitle(source.kind)} · {source.date} · {label(source.status)}</small></span><strong>{formatMoney(source.total)}</strong></div>}
              {children.map(c => <div className="invoice-related-row" key={c.id}><span><strong>{c.number}</strong><small>{documentTitle(c.kind)} · {c.date} · {label(c.status)}</small></span><strong>{formatMoney(c.total)}</strong></div>)}
              {nextKind[doc.kind] && doc.status === 'submitted' && <p>{remaining ? 'Not yet fully converted.' : 'Fully converted.'}</p>}
            </section>}
            {['sales_invoice', 'supplier_invoice'].includes(doc.kind) && <section><h3>{doc.kind === 'sales_invoice' ? 'Receipts' : 'Payments'}</h3>
              {receipts.length ? receipts.map(r => <div className="invoice-related-row" key={r.id}><span><strong>{r.number}</strong><small>{r.date} · {label(r.method)}{r.chequeNo ? ` · ${r.chequeNo}` : ''} · {label(r.status)}</small></span><strong>{formatMoney(r.allocations.find(a => a.invoiceId === doc.id)?.amount || '0')}</strong></div>) : <p>None recorded.</p>}
            </section>}
          </div>
          <div className="invoice-totals">
            <div><span>Subtotal</span><strong>{formatMoney(doc.net)}</strong></div>
            <div><span>Tax</span><strong>{formatMoney(doc.tax)}</strong></div>
            <div className="invoice-total"><span>Total{doc.currency !== 'PKR' ? ` (${doc.currency})` : ''}</span><strong>{formatMoney(doc.total)}</strong></div>
            {['sales_invoice', 'supplier_invoice'].includes(doc.kind) && <>
              <div><span>Paid</span><strong>− {formatMoney(doc.paid)}</strong></div>
              <div><span>Returns / credits</span><strong>− {formatMoney(doc.returned)}</strong></div>
              {balance.lt(0) ? <div className="invoice-balance credit"><span>{doc.kind === 'sales_invoice' ? 'Customer credit' : 'Credit with supplier'}</span><strong>{formatMoney(balance.negated().toString())}</strong></div> : <div className="invoice-balance"><span>Balance due</span><strong>{formatMoney(balance.toString())}</strong></div>}
            </>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
    {editing && <DocumentEditor open kind={doc.kind as never} existing={doc} workspace={workspace} actor={actor} busy={busy} onClose={() => setEditing(false)} command={command}/>}
    {converting && <ConvertDialog source={doc} workspace={workspace} busy={busy} onClose={() => setConverting(false)} command={command}/>}
    {returning && <ReturnDialog source={doc} workspace={workspace} busy={busy} onClose={() => setReturning(false)} command={command}/>}
  </>;
}
