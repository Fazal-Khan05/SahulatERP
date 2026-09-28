'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { stock } from '@/modules/erp/engine';
import { D } from '@/modules/erp/money';
import type { Actor, Workspace } from '@/modules/erp/types';

export function StockTransferDialog({ open, onClose, workspace, actor, busy, notice, command }: {
  open: boolean;
  onClose: () => void;
  workspace: Workspace;
  actor: Actor;
  busy: string;
  notice: string;
  command: (type: string, payload: Record<string, unknown>) => Promise<void>;
}) {
  const warehouses = workspace.warehouses.filter(warehouse => !actor.branchIds.length || actor.branchIds.includes(warehouse.branchId));
  const [itemId, setItemId] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState('');
  useEffect(() => { if (!open) { setQuantity(''); setError(''); } }, [open]);
  const item = workspace.items.find(product => product.id === itemId) || workspace.items[0];
  const from = warehouses.find(warehouse => warehouse.id === fromId) || warehouses[0];
  const to = warehouses.find(warehouse => warehouse.id === toId) || warehouses.find(warehouse => warehouse.id !== from?.id);
  const available = item && from ? stock(workspace, item.id, from.id).quantity : '0';
  const destination = item && to ? stock(workspace, item.id, to.id).quantity : '0';

  function close() {
    setError('');
    setQuantity('');
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!item || !from || !to) return setError('Choose a product and two warehouses.');
    if (from.id === to.id) return setError('Choose a different destination warehouse.');
    try {
      if (!D(quantity).isFinite() || D(quantity).lte(0)) return setError('Enter a quantity above zero.');
      if (D(quantity).gt(available)) return setError(`Only ${D(available).toString()} ${item.unit} are available in ${from.name}.`);
    } catch { return setError('Enter a valid quantity.'); }
    await command('stock_transfer', { itemId: item.id, from: from.id, to: to.id, quantity, date });
  }

  return <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
    <DialogContent className="stock-transfer-dialog">
      <DialogTitle>Transfer stock</DialogTitle>
      <DialogDescription>Move existing quantity between warehouses. The company-wide total stays the same.</DialogDescription>
      <form onSubmit={submit}>
        <div className="stock-transfer-fields">
          <label className="full-width">Product<select value={item?.id || ''} onChange={event => { setItemId(event.target.value); setQuantity(''); }} required>
            {workspace.items.map(product => <option value={product.id} key={product.id}>{product.sku} · {product.name}</option>)}
          </select></label>
          <label>From warehouse<select value={from?.id || ''} onChange={event => { setFromId(event.target.value); setToId(''); setQuantity(''); }} required>
            {warehouses.map(warehouse => <option value={warehouse.id} key={warehouse.id}>{warehouse.name}</option>)}
          </select></label>
          <label>To warehouse<select value={to?.id || ''} onChange={event => setToId(event.target.value)} required>
            {warehouses.filter(warehouse => warehouse.id !== from?.id).map(warehouse => <option value={warehouse.id} key={warehouse.id}>{warehouse.name}</option>)}
          </select></label>
          <label>Quantity to move<input type="number" min="0.0001" step="0.0001" max={available} value={quantity} onChange={event => setQuantity(event.target.value)} required/></label>
          <label>Date<input type="date" value={date} onChange={event => setDate(event.target.value)} required/></label>
        </div>
        <div className="stock-transfer-preview">
          <span><strong>{from?.name || 'Source'}</strong><small>Available: {D(available).toString()} {item?.unit || ''}</small></span>
          <ArrowRightLeft size={20}/>
          <span><strong>{to?.name || 'Destination'}</strong><small>Currently: {D(destination).toString()} {item?.unit || ''}</small></span>
        </div>
        {(error || notice) && <div className="error-note" role="alert">{error || notice}</div>}
        <div className="form-actions"><Button type="button" variant="outline" onClick={close}>Cancel</Button><Button type="submit" disabled={!!busy || !item || !from || !to || D(available).lte(0)}><ArrowRightLeft size={16}/>Transfer stock</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
