'use client';
import { useMemo, useState } from 'react';
import { Loader2, Plus, Save, Send, Trash2, UserPlus } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { businessToday } from '@/modules/erp/dates';
import { documentTitle } from '@/modules/erp/documents';
import { D, formatMoney, money } from '@/modules/erp/money';
import type { Actor, Document, Workspace } from '@/modules/erp/types';

type Kind = 'quotation' | 'sales_order' | 'delivery' | 'sales_invoice' | 'purchase_order' | 'goods_receipt' | 'supplier_invoice';
type LineDraft = { key: number; itemId: string; quantity: string; price: string; discount: string; taxRate: string; employeeId: string };
type CommandResult = { ok: boolean; message: string; recordId?: string };
export const salesKinds: Kind[] = ['quotation', 'sales_order', 'delivery', 'sales_invoice'];

const addDays = (date: string, days: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
let keySeed = 1;
const newLine = (seed: Partial<LineDraft> = {}): LineDraft => ({ key: keySeed++, itemId: '', quantity: '', price: '', discount: '', taxRate: '', employeeId: '', ...seed });
/** Stored decimals ('2400.0000') shown as typed values ('2400'); zero shows as an empty field with its placeholder. */
const plain = (value: string) => { const d = D(value || '0'); return d.isZero() ? '' : d.toString(); };

/**
 * Create or edit any document kind with a multi-line table. The customer/supplier is typed by
 * name: an existing name is matched, a new name is created on the spot. Prices prefill from the
 * product (selling price for sales, standard cost for purchases); tax prefills from settings.
 */
export function DocumentEditor({ open, kind, existing, workspace, actor, busy, onClose, command }: {
  open: boolean;
  kind: Kind;
  existing?: Document | null;
  workspace: Workspace;
  actor: Actor;
  busy: string;
  onClose: () => void;
  command: (type: string, payload: Record<string, unknown>) => Promise<CommandResult>;
}) {
  const sales = salesKinds.includes(kind);
  const today = businessToday();
  const partyType = sales ? 'customer' : 'supplier';
  const parties = workspace.parties.filter(p => !p.archived && p.type === partyType);
  const products = workspace.items.filter(i => !i.archived);
  const warehouses = workspace.warehouses.filter(x => !actor.branchIds.length || actor.branchIds.includes(x.branchId));
  const singleLocation = workspace.warehouses.length <= 1;
  const people = workspace.employees.filter(e => e.active);
  const defaultTax = workspace.settings.taxRate || '0';

  const [partyName, setPartyName] = useState(existing ? (workspace.parties.find(p => p.id === existing.partyId)?.name ?? '') : '');
  const [newCity, setNewCity] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [warehouseId, setWarehouseId] = useState(existing?.warehouseId ?? warehouses[0]?.id ?? '');
  const [date, setDate] = useState(existing?.date ?? today);
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? addDays(today, 30));
  const [dueTouched, setDueTouched] = useState(!!existing);
  const [currency, setCurrency] = useState(existing?.currency ?? (sales ? 'PKR' : 'USD'));
  const [fxRate, setFxRate] = useState(existing?.fxRate ?? (sales ? '1' : ''));
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [creditOverride, setCreditOverride] = useState(existing?.creditOverride ?? '');
  const [lines, setLines] = useState<LineDraft[]>(existing ? existing.lines.map(l => newLine({ itemId: l.itemId, quantity: plain(l.quantity), price: plain(l.price), discount: plain(l.discount), taxRate: plain(l.taxRate), employeeId: l.employeeId })) : [newLine({ taxRate: sales ? plain(defaultTax) : '', employeeId: sales ? (actor.employeeId ?? '') : '' })]);
  const [error, setError] = useState('');
  // Once a draft exists (opened for editing, or created by a failed submit) later saves update it instead of creating another.
  const [draftId, setDraftId] = useState<string | null>(existing?.id ?? null);
  const [mode, setMode] = useState<'draft' | 'submit'>('submit');
  const [confirmingParty, setConfirmingParty] = useState(false);

  const matchedParty = useMemo(() => { const needle = partyName.trim().toLowerCase(); return needle ? parties.find(p => p.name.trim().toLowerCase() === needle) : undefined; }, [partyName, parties]);
  const isNewParty = partyName.trim().length >= 2 && !matchedParty;

  const totals = useMemo(() => {
    let net = D(0), tax = D(0);
    for (const l of lines) {
      if (!l.itemId || !l.quantity || l.price === '') continue;
      try { const lineNet = D(l.quantity).mul(l.price).mul(D(100).minus(l.discount || 0)).div(100); net = net.plus(lineNet); tax = tax.plus(lineNet.mul(l.taxRate || 0).div(100)); } catch { /* partial input */ }
    }
    return { net, tax, total: net.plus(tax) };
  }, [lines]);

  function changePartyName(value: string) {
    setPartyName(value);
    const party = parties.find(p => p.name.trim().toLowerCase() === value.trim().toLowerCase());
    if (party && !dueTouched) setDueDate(addDays(date, party.terms));
  }
  function update(key: number, patch: Partial<LineDraft>) {
    setLines(current => current.map(l => {
      if (l.key !== key) return l;
      const next = { ...l, ...patch };
      if (patch.itemId !== undefined && patch.itemId !== l.itemId) {
        const item = products.find(i => i.id === patch.itemId);
        if (item && (l.price === '' || l.itemId === '')) next.price = plain(sales ? item.price : item.cost);
      }
      return next;
    }));
  }
  // A new name is confirmed with the user before a customer/supplier record is created alongside the document.
  function requestSave(next: 'draft' | 'submit') {
    setError(''); setMode(next);
    if (partyName.trim().length < 2) return setError(`Enter the ${partyType}'s name.`);
    if (!lines.some(l => l.itemId)) return setError('Add at least one product line.');
    if (isNewParty) setConfirmingParty(true); else void save(next);
  }
  async function save(next: 'draft' | 'submit' = mode) {
    setConfirmingParty(false);
    setError('');
    const name = partyName.trim();
    if (name.length < 2) return setError(`Enter the ${partyType}'s name.`);
    const missing = lines.findIndex(l => l.itemId && !(Number(l.quantity) > 0));
    if (missing >= 0) return setError(`Enter a quantity on line ${missing + 1}.`);
    const payloadLines = lines.filter(l => l.itemId).map(l => ({ itemId: l.itemId, quantity: l.quantity, price: l.price || '0', discount: l.discount || '0', taxRate: l.taxRate || '0', employeeId: sales ? l.employeeId : '', splits: [] }));
    if (!payloadLines.length) return setError('Add at least one product line.');
    let partyId = matchedParty?.id;
    if (!partyId) {
      // New name: create the party with plain defaults (no credit limit, 30-day terms); details can be completed later.
      const created = await command('save_party', { name, type: partyType, city: newCity.trim(), phone: newPhone.trim(), email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: sales ? 'Retailer' : 'Importer' });
      if (!created.ok || !created.recordId) return setError(created.message);
      partyId = created.recordId;
    }
    const payload = { kind, partyId, warehouseId, date, dueDate, currency: sales ? 'PKR' : currency, fxRate: sales ? '1' : fxRate, notes, ...(creditOverride.trim() ? { creditOverride: creditOverride.trim() } : {}), lines: payloadLines };
    const result = draftId ? await command('update_document', { id: draftId, ...payload }) : await command('create_document', payload);
    if (!result.ok) return setError(result.message);
    const id = draftId ?? result.recordId ?? null;
    if (next === 'draft' || !id) return onClose();
    // One step for the merchant: the draft is posted straight away. If posting fails the draft is kept and the reason shown here.
    setDraftId(id);
    const posted = await command('submit_document', { id });
    if (posted.ok) onClose(); else setError(`Saved as a draft but not submitted. ${posted.message}`);
  }
  const title = existing ? `Edit ${documentTitle(kind).toLowerCase()} ${existing.number}` : `New ${documentTitle(kind).toLowerCase()}`;
  const partyLabel = sales ? 'Customer' : 'Supplier';
  const listId = `party-options-${kind}`;

  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <DialogContent className="editor-dialog">
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{existing ? 'Drafts can be edited until they are submitted.' : `Submit posts it straight away${sales ? ' and moves the stock' : ''}. Save draft to finish later.`}</DialogDescription>
      <div className="editor-head field-grid">
        <label className={singleLocation ? 'full-width' : undefined}>{partyLabel}
          <input aria-label={partyLabel} list={listId} value={partyName} onChange={e => changePartyName(e.target.value)} placeholder={`Type a name — existing ${partyType}s are suggested`} autoComplete="off" required/>
          <datalist id={listId}>{parties.map(p => <option key={p.id} value={p.name}>{[p.city, p.phone].filter(Boolean).join(' · ')}</option>)}</datalist>
          {isNewParty && <small className="field-hint party-new"><UserPlus size={13}/> New {partyType} — will be created when you save.</small>}
          {matchedParty && <small className="field-hint">{[matchedParty.city, matchedParty.phone, matchedParty.terms ? `${matchedParty.terms}-day terms` : ''].filter(Boolean).join(' · ') || 'Existing ' + partyType}</small>}
        </label>
        {!singleLocation && <label>Warehouse<select aria-label="Warehouse" value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>{warehouses.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
        {isNewParty && <><label>City <span className="field-optional">optional</span><input aria-label={`New ${partyType} city`} value={newCity} onChange={e => setNewCity(e.target.value)} maxLength={120}/></label><label>Phone <span className="field-optional">optional</span><input aria-label={`New ${partyType} phone`} value={newPhone} onChange={e => setNewPhone(e.target.value)} maxLength={40} placeholder="+92 …"/></label></>}
        <label>Date<input aria-label="Document date" type="date" value={date} onChange={e => setDate(e.target.value)} required/></label>
        <label>{kind === 'quotation' ? 'Valid until' : 'Due date'}<input aria-label="Due date" type="date" value={dueDate} onChange={e => { setDueDate(e.target.value); setDueTouched(true); }} required/></label>
        {!sales && <><label>Currency<select aria-label="Currency" value={currency} onChange={e => { setCurrency(e.target.value as typeof currency); if (e.target.value === 'PKR') setFxRate('1'); }}><option>USD</option><option>CNY</option><option>PKR</option></select></label>
          <label>PKR per {currency}<input aria-label="Exchange rate" type="number" step="0.0001" min="0.0001" placeholder="e.g. 280" value={fxRate} onChange={e => setFxRate(e.target.value)} disabled={currency === 'PKR'} required/></label></>}
      </div>
      <div className="table-scroll editor-lines"><table>
        <thead><tr><th>Product</th><th className="num">Qty</th><th className="num">{sales ? 'Price' : 'Unit cost'}{!sales && currency !== 'PKR' ? ` (${currency})` : ''}</th><th className="num">Disc %</th><th className="num">Tax %</th>{sales && <th>Salesperson</th>}<th className="num">Line total</th><th/></tr></thead>
        <tbody>{lines.map((l, index) => {
          const item = products.find(i => i.id === l.itemId);
          let lineTotal = '';
          try { if (l.itemId && l.quantity && l.price !== '') lineTotal = money(D(l.quantity).mul(l.price).mul(D(100).minus(l.discount || 0)).div(100)); } catch { lineTotal = ''; }
          return <tr key={l.key}>
            <td><select aria-label={`Line ${index + 1} product`} value={l.itemId} onChange={e => update(l.key, { itemId: e.target.value })}><option value="">Select product…</option>{products.map(i => <option key={i.id} value={i.id}>{i.sku} · {i.name}</option>)}</select></td>
            <td><input aria-label={`Line ${index + 1} quantity`} className="num" type="number" min="0.0001" step="0.0001" placeholder="Qty" value={l.quantity} onChange={e => update(l.key, { quantity: e.target.value })}/>{item && <small className="field-hint">{item.unit}</small>}</td>
            <td><input aria-label={`Line ${index + 1} price`} className="num" type="number" min="0" step="0.0001" placeholder="0.00" value={l.price} onChange={e => update(l.key, { price: e.target.value })}/></td>
            <td><input aria-label={`Line ${index + 1} discount`} className="num" type="number" min="0" max="100" step="0.01" placeholder="0" value={l.discount} onChange={e => update(l.key, { discount: e.target.value })}/></td>
            <td><input aria-label={`Line ${index + 1} tax`} className="num" type="number" min="0" max="100" step="0.01" placeholder="0" value={l.taxRate} onChange={e => update(l.key, { taxRate: e.target.value })}/></td>
            {sales && <td><select aria-label={`Line ${index + 1} salesperson`} value={l.employeeId} onChange={e => update(l.key, { employeeId: e.target.value })}><option value="">—</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>}
            <td className="num amount">{lineTotal ? formatMoney(lineTotal) : '—'}</td>
            <td><button type="button" className="icon-button" aria-label={`Remove line ${index + 1}`} disabled={lines.length === 1} onClick={() => setLines(c => c.filter(x => x.key !== l.key))}><Trash2 size={15}/></button></td>
          </tr>;
        })}</tbody>
      </table></div>
      <div className="editor-foot">
        <div className="editor-foot-left">
          <Button type="button" variant="outline" onClick={() => setLines(c => [...c, newLine({ taxRate: sales ? defaultTax : '0', employeeId: sales ? (c.at(-1)?.employeeId ?? '') : '' })])}><Plus size={16}/>Add line</Button>
          <label className="editor-notes">Notes<textarea rows={2} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)}/></label>
          {kind === 'sales_invoice' && actor.role === 'Owner' && matchedParty && D(matchedParty.creditLimit).gt(0) && <label className="editor-notes">Credit-limit override reason <span className="field-optional">owner only, if the limit is exceeded</span><input value={creditOverride} onChange={e => setCreditOverride(e.target.value)} maxLength={500}/></label>}
        </div>
        <table className="doc-totals editor-totals"><tbody>
          <tr><th>Net</th><td>{formatMoney(money(totals.net))}</td></tr>
          <tr><th>Tax</th><td>{formatMoney(money(totals.tax))}</td></tr>
          <tr className="emphasis"><th>Total{!sales && currency !== 'PKR' ? ` (${currency})` : ''}</th><td>{formatMoney(money(totals.total))}</td></tr>
          {!sales && currency !== 'PKR' && fxRate && <tr><th>≈ PKR</th><td>{formatMoney(money(totals.total.mul(fxRate || 0)))}</td></tr>}
        </tbody></table>
      </div>
      {error && <p className="error-note" role="alert">{error}</p>}
      <div className="form-actions"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="button" variant="outline" disabled={!!busy || partyName.trim().length < 2} onClick={() => requestSave('draft')}>{busy && mode === 'draft' ? <Loader2 className="spin" size={16}/> : <Save size={16}/>}{existing ? 'Save changes' : 'Save draft'}</Button><Button type="button" disabled={!!busy || partyName.trim().length < 2} onClick={() => requestSave('submit')}>{busy && mode === 'submit' ? <Loader2 className="spin" size={16}/> : <Send size={16}/>}{existing ? 'Save and submit' : `Submit ${documentTitle(kind).toLowerCase()}`}</Button></div>
    </DialogContent>
    <Dialog open={confirmingParty} onOpenChange={v => { if (!v) setConfirmingParty(false); }}>
      <DialogContent className="confirm-dialog">
        <DialogTitle>Save {partyType}?</DialogTitle>
        <DialogDescription>“{partyName.trim()}” is not in your {partyType} list yet. Saving this {documentTitle(kind).toLowerCase()} will also add them as a {partyType}{newCity.trim() || newPhone.trim() ? ` (${[newCity.trim(), newPhone.trim()].filter(Boolean).join(' · ')})` : ''}, so you can reuse them next time.</DialogDescription>
        <div className="form-actions"><Button type="button" variant="outline" onClick={() => setConfirmingParty(false)}>Cancel</Button><Button type="button" disabled={!!busy} onClick={() => save()}>{busy ? <Loader2 className="spin" size={16}/> : <UserPlus size={16}/>}Save {partyType}</Button></div>
      </DialogContent>
    </Dialog>
  </Dialog>;
}
