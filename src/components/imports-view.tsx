'use client';
import { useState, type FormEvent } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Status, TableCard, type CommandFn } from './table-card';
import { canRun } from '@/modules/erp/engine';
import { businessToday } from '@/modules/erp/dates';
import { documentPartyName, documentTitle } from '@/modules/erp/documents';
import { formatMoney, money, sum } from '@/modules/erp/money';
import type { Actor, Shipment, ShipmentCost, Workspace } from '@/modules/erp/types';

type Classification = ShipmentCost['classification'];
type Basis = ShipmentCost['basis'];
const shipmentStatuses: [Shipment['status'], string][] = [['in_transit', 'In transit'], ['customs', 'Customs'], ['received', 'Received'], ['costed', 'Costed']];

/** The four cost classes and what allocating each one does to the books. */
export const costClasses: { value: Classification; label: string; help: string }[] = [
  { value: 'inventory', label: 'Inventory', help: 'Freight, duty and other landed costs. Added to the stock value of the received goods; units already sold take their share as cost of goods sold.' },
  { value: 'recoverable_tax', label: 'Recoverable tax', help: 'Tax paid at import that you claim back, such as sales tax. Held as recoverable tax, not added to stock.' },
  { value: 'deposit', label: 'Deposit', help: 'Money you get back later, such as a container deposit. Held under deposits & advances until it is refunded.' },
  { value: 'expense', label: 'Expense', help: 'Costs that do not belong in stock, such as bank charges. Charged to operating expense in profit and loss.' },
];
/** How an inventory cost is shared across the source document's lines. */
export const costBases: { value: Basis; label: string; help: string }[] = [
  { value: 'value', label: 'By value', help: 'Shared by each line’s purchase value.' },
  { value: 'quantity', label: 'By quantity', help: 'Shared by units received.' },
  { value: 'weight', label: 'By weight', help: 'Shared by units × each product’s weight.' },
  { value: 'volume', label: 'By volume', help: 'Shared by units × each product’s volume.' },
];

export function CostClassGuide() {
  return <div className="card-body cost-classes"><h3>How costs are classified</h3><dl>{costClasses.map(c => <div key={c.value}><dt>{c.label}</dt><dd>{c.help}</dd></div>)}</dl></div>;
}

/** Imports & costing: shipments from submitted receipts or bills, their landed costs, and allocation. */
export function ImportsView({ workspace, actor, editable, busy, command }: { workspace: Workspace; actor: Actor; editable: boolean; busy: string; command: CommandFn }) {
  const [dialog, setDialog] = useState<'shipment' | 'cost' | null>(null);
  const [status, setStatus] = useState('');
  const can = (action: string) => editable && canRun(actor.role, action);
  const shipments = workspace.shipments;
  // Newest first, optionally one status.
  const visible = shipments.filter(sh => !status || sh.status === status).reverse();
  const party = (id: string) => workspace.parties.find(p => p.id === id)?.name || '—';
  const actions = <div className="inventory-actions">
    {can('add_shipment_cost') && shipments.length > 0 && <Button variant="outline" onClick={() => setDialog('cost')}><Plus size={16}/>Add cost</Button>}
    {can('create_shipment') && <Button onClick={() => setDialog('shipment')}><Plus size={16}/>New shipment</Button>}
  </div>;
  const toolbar = <div className="list-filters" role="group" aria-label="Shipment filters">
    <label>Status<select aria-label="Shipment status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{shipmentStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {status && <button className="list-filter-clear" type="button" onClick={() => setStatus('')}>Clear filters</button>}
  </div>;
  const empty = shipments.length ? <>No shipments match this status. <button className="text-button" type="button" onClick={() => setStatus('')}>Reset filters</button></> : 'No records yet.';
  const rows = visible.map(sh => {
    const pending = sh.costs.filter(cost => !cost.allocated);
    return [sh.number, party(sh.supplierId), `${sh.container} · ${sh.gdNumber}`, sh.eta, <Status key="s" value={sh.status}/>, formatMoney(money(sum(pending.map(c => c.amount)))),
      can('allocate_shipment') && pending.length ? <Button key="a" size="sm" disabled={!!busy} onClick={() => command('allocate_shipment', { id: sh.id, date: businessToday() })}>Allocate</Button> : <span key="a">{pending.length ? 'Read only' : 'Complete'}</span>];
  });
  return <section className="stack">
    <TableCard title="Import shipments" action={actions} toolbar={toolbar} empty={empty} subtitle={status ? `${visible.length} of ${shipments.length} shipments` : undefined}
      heads={['Shipment', 'Supplier', 'Container / GD', 'ETA', 'Status', 'Unallocated', 'Action']} numeric={[5]} rows={rows}><CostClassGuide/></TableCard>
    {dialog === 'shipment' && <NewShipmentDialog workspace={workspace} busy={busy} command={command} onClose={() => setDialog(null)}/>}
    {dialog === 'cost' && <AddCostDialog workspace={workspace} busy={busy} command={command} onClose={() => setDialog(null)}/>}
  </section>;
}

function NewShipmentDialog({ workspace, busy, command, onClose }: { workspace: Workspace; busy: string; command: CommandFn; onClose: () => void }) {
  const sources = workspace.documents.filter(d => (d.kind === 'goods_receipt' || d.kind === 'supplier_invoice') && d.status === 'submitted').slice().reverse();
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    const v = (key: string) => String(form.get(key) ?? '').trim();
    // Blank origin and port take the engine defaults; a blank ETA means today.
    const payload: Record<string, unknown> = { documentId: v('documentId'), container: v('container'), gdNumber: v('gdNumber') };
    for (const key of ['origin', 'port', 'eta']) if (v(key)) payload[key] = v(key);
    const result = await command('create_shipment', payload);
    if (result.ok) onClose(); else setError(result.message);
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="record-dialog">
    <DialogTitle>New shipment</DialogTitle>
    <DialogDescription>Start from a submitted goods receipt or supplier bill. Its supplier and lines carry over; add landed costs once it is saved.</DialogDescription>
    <form className="field-grid" onSubmit={submit}>
      <label className="full-width">Goods receipt or bill<select name="documentId" required defaultValue=""><option value="" disabled>Select…</option>{sources.map(d => <option key={d.id} value={d.id}>{d.number} · {documentTitle(d.kind)} · {documentPartyName(workspace, d)} · {d.date}</option>)}</select>
        {!sources.length && <small className="field-hint">No submitted goods receipts or supplier bills yet. Receive the goods in Purchasing first.</small>}</label>
      <label>Origin<input name="origin" placeholder="Default: Shenzhen" maxLength={100}/></label>
      <label>Port<input name="port" placeholder="Default: Karachi" maxLength={100}/></label>
      <label>Container number<input name="container" placeholder="e.g. TGHU1234567" maxLength={100}/></label>
      <label>GD number<input name="gdNumber" placeholder="e.g. KPPI-HC-1234" maxLength={100}/></label>
      <label>ETA<input name="eta" type="date" defaultValue={businessToday()}/></label>
      {error && <p className="error-note full-width" role="alert">{error}</p>}
      <div className="form-actions full-width"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!!busy || !sources.length}>{busy ? <Loader2 className="spin" size={16}/> : <Plus size={16}/>}Create shipment</Button></div>
    </form>
  </DialogContent></Dialog>;
}

function AddCostDialog({ workspace, busy, command, onClose }: { workspace: Workspace; busy: string; command: CommandFn; onClose: () => void }) {
  const shipments = workspace.shipments.slice().reverse();
  const [classification, setClassification] = useState<Classification>('inventory');
  const [basis, setBasis] = useState<Basis>('value');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    const v = (key: string) => String(form.get(key) ?? '').trim();
    // The basis only shares an inventory cost across lines; other classes post whole, so any basis will do.
    const result = await command('add_shipment_cost', { id: v('shipmentId'), label: v('label'), amount: v('amount'), classification, basis: classification === 'inventory' ? basis : 'value' });
    if (result.ok) onClose(); else setError(result.message);
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="record-dialog">
    <DialogTitle>Add shipment cost</DialogTitle>
    <DialogDescription>Costs stay unallocated until you allocate the shipment. Amounts are in PKR.</DialogDescription>
    <form className="field-grid" onSubmit={submit}>
      <label className="full-width">Shipment<select name="shipmentId" required defaultValue={shipments.length === 1 ? shipments[0].id : ''}><option value="" disabled>Select…</option>{shipments.map(sh => <option key={sh.id} value={sh.id}>{sh.number} · {workspace.parties.find(p => p.id === sh.supplierId)?.name || '—'}{sh.container ? ` · ${sh.container}` : ''}</option>)}</select></label>
      <label>Cost<input name="label" required maxLength={100} placeholder="e.g. Freight, customs duty"/></label>
      <label>Amount (PKR)<input name="amount" type="number" inputMode="decimal" min="0.01" step="0.01" required placeholder="0.00"/></label>
      <fieldset className="choice-list full-width"><legend>Classification</legend>
        {costClasses.map(c => <label key={c.value} className="choice"><input type="radio" name="classification" value={c.value} checked={classification === c.value} onChange={() => setClassification(c.value)}/><span>{c.label}<small>{c.help}</small></span></label>)}
      </fieldset>
      {classification === 'inventory' && <label className="full-width">Share across lines<select name="basis" value={basis} onChange={e => setBasis(e.target.value as Basis)}>{costBases.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}</select><small className="field-hint">{costBases.find(b => b.value === basis)?.help}</small></label>}
      {error && <p className="error-note full-width" role="alert">{error}</p>}
      <div className="form-actions full-width"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!!busy}>{busy ? <Loader2 className="spin" size={16}/> : <Plus size={16}/>}Add cost</Button></div>
    </form>
  </DialogContent></Dialog>;
}
