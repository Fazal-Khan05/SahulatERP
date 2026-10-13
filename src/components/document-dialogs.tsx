'use client';
import { useMemo, useState } from 'react';
import { ArrowRight, Loader2, Undo2 } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { businessToday } from '@/modules/erp/dates';
import { documentTitle } from '@/modules/erp/documents';
import { D, money, sum } from '@/modules/erp/money';
import type { Document, Workspace } from '@/modules/erp/types';

type CommandResult = { ok: boolean; message: string; recordId?: string };
type CommandFn = (type: string, payload: Record<string, unknown>) => Promise<CommandResult>;

export const nextKind: Record<string, Document['kind']> = { quotation: 'sales_order', sales_order: 'delivery', delivery: 'sales_invoice', purchase_order: 'goods_receipt', goods_receipt: 'supplier_invoice' };

/** Quantity of each source line not yet used by non-cancelled follow-on documents. */
export function remainingLines(w: Workspace, source: Document) {
  const children = w.documents.filter(d => d.parentId === source.id && d.status !== 'cancelled');
  return source.lines.map(l => {
    const used = sum(children.flatMap(c => c.lines.filter(x => x.itemId === l.itemId).map(x => x.quantity)));
    return { line: l, used, remaining: D(l.quantity).minus(used) };
  });
}

/** Convert a submitted document into the next step, delivering or invoicing part of it if needed. */
export function ConvertDialog({ source, workspace, busy, onClose, command }: { source: Document | null; workspace: Workspace; busy: string; onClose: () => void; command: CommandFn }) {
  const rows = useMemo(() => source ? remainingLines(workspace, source).filter(r => r.remaining.gt(0)) : [], [source, workspace]);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [date, setDate] = useState(businessToday());
  const [error, setError] = useState('');
  if (!source) return null;
  const target = nextKind[source.kind];
  const qty = (lineId: string, fallback: string) => quantities[lineId] ?? fallback;
  async function convert() {
    setError('');
    const lines = rows.map(r => ({ itemId: r.line.itemId, quantity: qty(r.line.id, r.remaining.toString()), price: r.line.price, discount: r.line.discount, taxRate: r.line.taxRate, employeeId: r.line.employeeId, splits: r.line.splits })).filter(l => D(l.quantity || 0).gt(0));
    if (!lines.length) return setError('Enter a quantity for at least one line.');
    for (const r of rows) if (D(qty(r.line.id, r.remaining.toString()) || 0).gt(r.remaining)) return setError(`${workspace.items.find(i => i.id === r.line.itemId)?.name ?? 'Line'}: only ${r.remaining.toString()} remaining.`);
    const result = await command('convert_document', { id: source!.id, date, lines });
    if (result.ok) onClose(); else setError(result.message);
  }
  return <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
    <DialogContent className="record-dialog">
      <DialogTitle>{documentTitle(target)} from {source.number}</DialogTitle>
      <DialogDescription>Choose how much to {target === 'delivery' ? 'deliver' : target === 'goods_receipt' ? 'receive' : target === 'sales_invoice' || target === 'supplier_invoice' ? 'invoice' : 'carry forward'} now. The rest stays open on {source.number}.</DialogDescription>
      <div className="table-scroll editor-lines"><table>
        <thead><tr><th>Product</th><th className="num">Ordered</th><th className="num">Done</th><th className="num">Remaining</th><th className="num">This time</th></tr></thead>
        <tbody>{rows.map(r => { const item = workspace.items.find(i => i.id === r.line.itemId); return <tr key={r.line.id}>
          <td><strong>{item?.name ?? r.line.itemId}</strong><small>{item?.sku}</small></td>
          <td className="num">{D(r.line.quantity).toString()}</td><td className="num">{r.used.toString()}</td><td className="num">{r.remaining.toString()}</td>
          <td><input aria-label={`${item?.name ?? 'Line'} quantity this time`} className="num" type="number" min="0" max={r.remaining.toString()} step="0.0001" value={qty(r.line.id, r.remaining.toString())} onChange={e => setQuantities(q => ({ ...q, [r.line.id]: e.target.value }))}/></td>
        </tr>; })}</tbody>
      </table></div>
      <div className="field-grid" style={{ marginTop: 16 }}><label>Date<input type="date" aria-label="Conversion date" value={date} onChange={e => setDate(e.target.value)}/></label></div>
      {error && <p className="error-note" role="alert">{error}</p>}
      <div className="form-actions"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="button" disabled={!!busy || !rows.length} onClick={convert}>{busy ? <Loader2 className="spin" size={16}/> : <ArrowRight size={16}/>}Create {documentTitle(target).toLowerCase()}</Button></div>
    </DialogContent>
  </Dialog>;
}

/** Partial or full return against a submitted sales invoice or supplier bill. */
export function ReturnDialog({ source, workspace, busy, onClose, command }: { source: Document | null; workspace: Workspace; busy: string; onClose: () => void; command: CommandFn }) {
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(businessToday());
  const [error, setError] = useState('');
  if (!source) return null;
  const rows = source.lines.map(l => ({ line: l, open: D(l.quantity).minus(l.returned) })).filter(r => r.open.gt(0));
  async function submit() {
    setError('');
    const lines = rows.map(r => ({ lineId: r.line.id, quantity: quantities[r.line.id] ?? '' })).filter(l => l.quantity && D(l.quantity).gt(0));
    if (!lines.length) return setError('Enter the quantity being returned on at least one line.');
    const result = await command('return_document', { id: source!.id, date, reason, lines });
    if (result.ok) onClose(); else setError(result.message);
  }
  const isSale = source.kind === 'sales_invoice';
  return <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
    <DialogContent className="record-dialog">
      <DialogTitle>{isSale ? 'Customer return' : 'Return to supplier'} · {source.number}</DialogTitle>
      <DialogDescription>{isSale ? 'Posts a credit note, puts stock back and adjusts commission.' : 'Posts a supplier return and removes the stock.'}</DialogDescription>
      <div className="table-scroll editor-lines"><table>
        <thead><tr><th>Product</th><th className="num">Invoiced</th><th className="num">Already returned</th><th className="num">Return now</th></tr></thead>
        <tbody>{rows.map(r => { const item = workspace.items.find(i => i.id === r.line.itemId); return <tr key={r.line.id}>
          <td><strong>{item?.name ?? r.line.itemId}</strong><small>{item?.sku}</small></td>
          <td className="num">{D(r.line.quantity).toString()}</td><td className="num">{D(r.line.returned).toString()}</td>
          <td><input aria-label={`${item?.name ?? 'Line'} return quantity`} className="num" type="number" min="0" max={r.open.toString()} step="0.0001" value={quantities[r.line.id] ?? ''} placeholder="0" onChange={e => setQuantities(q => ({ ...q, [r.line.id]: e.target.value }))}/></td>
        </tr>; })}</tbody>
      </table></div>
      <div className="field-grid" style={{ marginTop: 16 }}><label>Date<input type="date" aria-label="Return date" value={date} onChange={e => setDate(e.target.value)}/></label><label>Reason<input aria-label="Return reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} placeholder="Damaged, wrong item…"/></label></div>
      {error && <p className="error-note" role="alert">{error}</p>}
      <div className="form-actions"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="button" variant="destructive" disabled={!!busy || !rows.length} onClick={submit}>{busy ? <Loader2 className="spin" size={16}/> : <Undo2 size={16}/>}Post return</Button></div>
    </DialogContent>
  </Dialog>;
}

/** Customer receipt or supplier payment allocated across several open invoices. */
export function PaymentDialog({ open, partyType, presetPartyId, workspace, busy, onClose, command }: { open: boolean; partyType: 'customer' | 'supplier'; presetPartyId?: string; workspace: Workspace; busy: string; onClose: () => void; command: CommandFn }) {
  const today = businessToday();
  const [partyId, setPartyId] = useState(presetPartyId ?? '');
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<'bank' | 'cash' | 'cheque'>('bank');
  const accounts = workspace.bankAccounts.filter(a => !a.archived);
  const [accountId, setAccountId] = useState(accounts.find(a => a.type === 'bank')?.id ?? accounts[0]?.id ?? '');
  const [chequeNo, setChequeNo] = useState('');
  const [date, setDate] = useState(today);
  const [dueDate, setDueDate] = useState(today);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const parties = workspace.parties.filter(p => p.type === partyType && !p.archived);
  const invoiceKind = partyType === 'customer' ? 'sales_invoice' : 'supplier_invoice';
  const openInvoices = workspace.documents.filter(d => d.kind === invoiceKind && d.status === 'submitted' && d.partyId === partyId && D(d.total).minus(d.paid).minus(d.returned).gt(0)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const balance = (d: Document) => D(d.total).minus(d.paid).minus(d.returned);
  const allocated = sum(openInvoices.map(d => allocations[d.id] || 0));
  const fx = (d: Document) => d.currency === 'PKR' ? D(1) : D(d.fxRate);
  // Supplier bills can be in USD/CNY; the payment amount is PKR, allocations are in the bill's currency.
  const pkrAmount = sum(openInvoices.map(d => D(allocations[d.id] || 0).mul(fx(d))));
  const [paidPkr, setPaidPkr] = useState('');
  function oldestFirst(total: string) {
    let left = D(total || 0); const next: Record<string, string> = {};
    for (const d of openInvoices) { const take = D.min(left, balance(d)); if (take.lte(0)) break; next[d.id] = money(take); left = left.minus(take); }
    setAllocations(next);
  }
  async function submit() {
    setError('');
    const lines = openInvoices.map(d => ({ invoiceId: d.id, amount: allocations[d.id] || '0' })).filter(a => D(a.amount).gt(0));
    if (!lines.length) return setError('Allocate the payment to at least one invoice.');
    for (const a of lines) { const d = openInvoices.find(x => x.id === a.invoiceId)!; if (D(a.amount).gt(balance(d))) return setError(`${d.number}: allocation exceeds its balance of ${balance(d).toString()}.`); }
    const amount = partyType === 'customer' ? money(allocated) : money(paidPkr || pkrAmount);
    const result = await command('create_receipt', { partyId, date, amount, method, chequeNo, dueDate: method === 'cheque' ? dueDate : date, allocations: lines, employeeId: '', note: note || (partyType === 'customer' ? 'Customer collection' : 'Supplier payment'), ...(method !== 'cheque' && accountId ? { accountId } : {}) });
    if (result.ok) onClose(); else setError(result.message);
  }
  return <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
    <DialogContent className="record-dialog">
      <DialogTitle>{partyType === 'customer' ? 'Record customer receipt' : 'Record supplier payment'}</DialogTitle>
      <DialogDescription>Allocate across open {partyType === 'customer' ? 'invoices' : 'bills'}. Cheques post only when cleared.</DialogDescription>
      <div className="field-grid" style={{ marginTop: 14 }}>
        <label className="full-width">{partyType === 'customer' ? 'Customer' : 'Supplier'}<select aria-label={partyType === 'customer' ? 'Customer' : 'Supplier'} value={partyId} onChange={e => { setPartyId(e.target.value); setAllocations({}); }}><option value="">Select…</option>{parties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
      {partyId && <div className="table-scroll editor-lines"><table>
        <thead><tr><th>{partyType === 'customer' ? 'Invoice' : 'Bill'}</th><th>Due</th><th className="num">Balance</th><th className="num">Allocate</th></tr></thead>
        <tbody>{openInvoices.length ? openInvoices.map(d => <tr key={d.id}>
          <td><strong>{d.number}</strong><small>{d.date}{d.currency !== 'PKR' ? ` · ${d.currency} @ ${D(d.fxRate).toString()}` : ''}</small></td><td>{d.dueDate}</td>
          <td className="num">{balance(d).toFixed(2)}{d.currency !== 'PKR' ? ` ${d.currency}` : ''}</td>
          <td><input aria-label={`Allocate to ${d.number}`} className="num" type="number" min="0" max={balance(d).toString()} step="0.01" value={allocations[d.id] ?? ''} placeholder="0" onChange={e => setAllocations(a => ({ ...a, [d.id]: e.target.value }))}/></td>
        </tr>) : <tr><td colSpan={4}><div className="empty-state">No open {partyType === 'customer' ? 'invoices' : 'bills'} for this {partyType}.</div></td></tr>}</tbody>
      </table></div>}
      {partyId && openInvoices.length > 0 && <div className="payment-tools">
        <label>Amount received<input aria-label="Amount to allocate oldest first" type="number" min="0" step="0.01" placeholder={partyType === 'customer' ? 'Type the amount, then allocate' : 'Amount in bill currency'} onChange={e => oldestFirst(e.target.value)}/><small className="field-hint">Allocates to the oldest due {partyType === 'customer' ? 'invoices' : 'bills'} first; adjust lines as needed.</small></label>
        <div className="payment-summary"><span>Allocated</span><strong>{partyType === 'customer' ? formatPkr(allocated) : `${allocated.toFixed(2)} (≈ ${formatPkr(pkrAmount)})`}</strong></div>
      </div>}
      <div className="field-grid" style={{ marginTop: 14 }}>
        {partyType === 'supplier' && <label>PKR actually paid<input aria-label="PKR paid" type="number" min="0" step="0.01" value={paidPkr} placeholder={pkrAmount.toFixed(2)} onChange={e => setPaidPkr(e.target.value)}/><small className="field-hint">Difference from the booked rate posts as exchange gain or loss.</small></label>}
        <label>Method<select aria-label="Payment method" value={method} onChange={e => { const m = e.target.value as typeof method; setMethod(m); const preferred = accounts.find(a => a.type === (m === 'cash' ? 'cash' : 'bank')); if (preferred) setAccountId(preferred.id); }}><option value="bank">Bank transfer</option><option value="cash">Cash</option><option value="cheque">Cheque / PDC</option></select></label>
        {method !== 'cheque' && accounts.length > 0 && <label>{partyType === 'customer' ? 'Into account' : 'From account'}<select aria-label={partyType === 'customer' ? 'Into account' : 'From account'} value={accountId} onChange={e => setAccountId(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
        <label>Date<input aria-label="Payment date" type="date" value={date} onChange={e => setDate(e.target.value)}/></label>
        {method === 'cheque' && <><label>Cheque number<input aria-label="Cheque number" value={chequeNo} onChange={e => setChequeNo(e.target.value)} required/></label><label>Cheque date<input aria-label="Cheque date" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}/></label></>}
        <label className="full-width">Note<input aria-label="Payment note" value={note} onChange={e => setNote(e.target.value)} maxLength={1000}/></label>
      </div>
      {error && <p className="error-note" role="alert">{error}</p>}
      <div className="form-actions"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="button" disabled={!!busy || !partyId || allocated.lte(0)} onClick={submit}>{busy ? <Loader2 className="spin" size={16}/> : null}{partyType === 'customer' ? 'Save receipt' : 'Save payment'}</Button></div>
    </DialogContent>
  </Dialog>;
}

function formatPkr(value: ReturnType<typeof D>) { return `Rs ${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 }).format(value.toNumber())}`; }
