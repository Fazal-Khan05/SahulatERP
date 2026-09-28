'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { stock } from '@/modules/erp/engine';
import { D, formatMoney } from '@/modules/erp/money';
import type { Actor, Workspace } from '@/modules/erp/types';

type Mode = 'view' | 'edit';

export function ItemDetails({ workspace, actor, itemId, initialMode, onClose, command, busy, notice }: {
  workspace: Workspace;
  actor: Actor;
  itemId: string | null;
  initialMode: Mode;
  onClose: () => void;
  command: (type: string, payload: Record<string, unknown>) => Promise<void>;
  busy: string;
  notice: string;
}) {
  const item = workspace.items.find(product => product.id === itemId);
  const canEdit = ['Owner', 'Accountant', 'Warehouse Manager'].includes(actor.role);
  const editableWarehouses = workspace.warehouses.filter(warehouse => !actor.branchIds.length || actor.branchIds.includes(warehouse.branchId));
  const [mode, setMode] = useState<Mode>(initialMode);
  const [warehouseId, setWarehouseId] = useState(editableWarehouses[0]?.id || '');
  const [targetQuantity, setTargetQuantity] = useState(() => initialMode === 'edit' && item && editableWarehouses[0] ? stock(workspace, item.id, editableWarehouses[0].id).quantity : '');
  const [cost, setCost] = useState(() => {
    if (initialMode !== 'edit' || !item || !editableWarehouses[0]) return '';
    const level = stock(workspace, item.id, editableWarehouses[0].id);
    return D(level.average).gt(0) ? level.average : item.cost;
  });
  const [purpose, setPurpose] = useState<'count_correction' | 'opening_stock'>('count_correction');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [submittedRevision, setSubmittedRevision] = useState<number | null>(null);
  useEffect(() => { if (submittedRevision !== null && workspace.revision !== submittedRevision) onClose(); }, [workspace.revision, submittedRevision, onClose]);

  if (!item) return null;
  const total = stock(workspace, item.id);
  const warehouse = editableWarehouses.find(location => location.id === warehouseId) || editableWarehouses[0];
  const current = warehouse ? stock(workspace, item.id, warehouse.id) : null;
  const proposed = targetQuantity === '' || !current ? D(current?.quantity || 0) : D(targetQuantity);
  const difference = proposed.minus(current?.quantity || 0);
  const defaultCost = D(current?.average || 0).gt(0) ? current!.average : item.cost;
  const movements = workspace.stockMoves.filter(move => move.itemId === item.id).slice().reverse().slice(0, 20);

  function switchToEdit() {
    if (!canEdit) return;
    setMode('edit');
    setTargetQuantity(current?.quantity || '0');
    setCost(defaultCost);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!item || !warehouse || !current || difference.isZero()) return;
    await command('set_stock_quantity', {
      itemId: item.id, warehouseId: warehouse.id, expectedQuantity: current.quantity,
      targetQuantity, cost: difference.gt(0) ? cost || defaultCost : undefined,
      date, reason, purpose,
    });
    setSubmittedRevision(workspace.revision);
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="item-details-dialog">
      <div className="item-details-heading">
        <div><span className="invoice-eyebrow">INVENTORY ITEM · {item.sku}</span><DialogTitle>{mode === 'edit' ? `Edit ${item.name}` : item.name}</DialogTitle><DialogDescription>{item.category} · {item.unit} · HS/PCT {item.hsCode || 'not set'}</DialogDescription></div>
        {mode === 'view' && canEdit && <Button variant="outline" onClick={switchToEdit}><Pencil size={15}/>Edit stock</Button>}
      </div>

      {mode === 'view' ? <>
        <div className="item-details-metrics">
          <div><span>Total quantity</span><strong>{D(total.quantity).toString()} {item.unit}</strong></div>
          <div><span>Stock value</span><strong>{formatMoney(total.value)}</strong></div>
          <div><span>Average cost</span><strong>{formatMoney(total.average)}</strong></div>
          <div><span>Selling price</span><strong>{formatMoney(item.price)}</strong></div>
        </div>
        <section className="item-details-section"><h3>Stock by warehouse</h3><p>Sales invoices use the quantity in their selected warehouse.</p>
          <div className="table-scroll"><table><thead><tr><th>Warehouse</th><th>Branch</th><th>Quantity</th><th>Average cost</th><th>Value</th></tr></thead><tbody>{workspace.warehouses.map(location => {
            const level = stock(workspace, item.id, location.id);
            return <tr key={location.id}><td><strong>{location.name}</strong></td><td>{workspace.branches.find(branch => branch.id === location.branchId)?.name || '—'}</td><td>{D(level.quantity).toString()} {item.unit}</td><td>{formatMoney(level.average)}</td><td>{formatMoney(level.value)}</td></tr>;
          })}</tbody></table></div>
        </section>
        <section className="item-details-section"><h3>Item information</h3><div className="item-details-facts"><div><span>SKU</span><strong>{item.sku}</strong></div><div><span>Category</span><strong>{item.category}</strong></div><div><span>Reorder level</span><strong>{item.reorderLevel} {item.unit}</strong></div><div><span>Default unit cost</span><strong>{formatMoney(item.cost)}</strong></div><div><span>Weight</span><strong>{item.weight}</strong></div><div><span>Volume</span><strong>{item.volume}</strong></div></div></section>
        <section className="item-details-section"><h3>Recent stock movements</h3><div className="table-scroll"><table><thead><tr><th>Date</th><th>Warehouse</th><th>Type</th><th>Quantity change</th><th>Value change</th></tr></thead><tbody>{movements.length ? movements.map(move => <tr key={move.id}><td>{move.date}</td><td>{workspace.warehouses.find(location => location.id === move.warehouseId)?.name || '—'}</td><td>{move.type.replaceAll('_', ' ')}</td><td>{D(move.quantity).gt(0) ? '+' : ''}{D(move.quantity).toString()} {item.unit}</td><td>{formatMoney(move.value)}</td></tr>) : <tr><td colSpan={5}>No stock movements yet.</td></tr>}</tbody></table></div></section>
      </> : <form onSubmit={save} className="item-details-edit">
        <p>Set the counted quantity for one warehouse. This posts the difference to stock and the accounting ledger; it does not move stock between warehouses.</p>
        <div className="field-grid">
          <label>Warehouse<select value={warehouse?.id || ''} onChange={event => { const next = workspace.warehouses.find(location => location.id === event.target.value); const level = next ? stock(workspace, item.id, next.id) : null; setWarehouseId(event.target.value); setTargetQuantity(level?.quantity || ''); setCost(level && D(level.average).gt(0) ? level.average : item.cost); }} required>{editableWarehouses.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
          <label>Count date<input type="date" value={date} onChange={event => setDate(event.target.value)} required/></label>
          <label>Current quantity<input value={current ? `${D(current.quantity).toString()} ${item.unit}` : '—'} readOnly/></label>
          <label>New quantity<input aria-label="New quantity" type="number" min="0" step="0.0001" value={targetQuantity} onChange={event => setTargetQuantity(event.target.value)} required/></label>
          {difference.gt(0) && <><label>Unit cost for added stock<input aria-label="Unit cost for added stock" type="number" min="0.0001" step="0.0001" value={cost} onChange={event => setCost(event.target.value)} required/></label><label>Reason type<select value={purpose} onChange={event => setPurpose(event.target.value as 'count_correction' | 'opening_stock')}><option value="count_correction">Count correction</option><option value="opening_stock">Opening stock</option></select></label></>}
          <label className="full-width">Reason for adjustment<input value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} placeholder="Explain the counted difference" required/></label>
        </div>
        <div className="item-details-change"><span>Quantity change</span><strong>{difference.gt(0) ? '+' : ''}{difference.toString()} {item.unit}</strong></div>
        <p className="item-details-hint">For stock already held in another warehouse, use Transfer stock instead. Purchases should be recorded in Purchasing.</p>
        {notice && <div className="error-note" role="alert">{notice}</div>}
        <div className="form-actions"><Button type="button" variant="outline" onClick={() => setMode('view')}>Cancel</Button><Button type="submit" disabled={!!busy || !warehouse || difference.isZero()}>{busy ? 'Saving…' : 'Save quantity'}</Button></div>
      </form>}
    </DialogContent>
  </Dialog>;
}
