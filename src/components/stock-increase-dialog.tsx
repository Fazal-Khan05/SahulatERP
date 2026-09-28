'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { stock } from '@/modules/erp/engine';
import { D, formatMoney, sum } from '@/modules/erp/money';
import type { Actor, Workspace } from '@/modules/erp/types';

export function StockIncreaseDialog({ open, onClose, workspace, actor, busy, notice, command }: {
  open: boolean;
  onClose: () => void;
  workspace: Workspace;
  actor: Actor;
  busy: string;
  notice: string;
  command: (type: string, payload: Record<string, unknown>) => Promise<void>;
}) {
  const warehouses = workspace.warehouses.filter(warehouse => !actor.branchIds.length || actor.branchIds.includes(warehouse.branchId));
  const [warehouseId, setWarehouseId] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [sameQuantity, setSameQuantity] = useState('');
  const [purpose, setPurpose] = useState<'opening_stock' | 'count_correction'>('count_correction');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) {
      setQuantities({});
      setCosts({});
      setSameQuantity('');
      setPurpose('count_correction');
      setReason('');
      setError('');
    }
  }, [open]);
  const selectedWarehouse = warehouses.find(warehouse => warehouse.id === warehouseId) || warehouses[0];
  const defaultCost = (itemId: string) => {
    if (!selectedWarehouse) return '0';
    const level = stock(workspace, itemId, selectedWarehouse.id);
    return D(level.quantity).gt(0) && D(level.average).gt(0) ? D(level.average).toString() : workspace.items.find(item => item.id === itemId)?.cost || '0';
  };
  const selectedItems = workspace.items.filter(item => {
    try { return D(quantities[item.id] || '0').gt(0); } catch { return false; }
  });
  const totalValue = sum(selectedItems.map(item => {
    try { return D(quantities[item.id]).mul(costs[item.id] ?? defaultCost(item.id)); } catch { return D(0); }
  }));

  function close() {
    setError('');
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!selectedWarehouse) return setError('Choose a warehouse.');
    if (!selectedItems.length) return setError('Enter a quantity for at least one product.');
    const lines = selectedItems.map(item => ({ itemId: item.id, quantity: quantities[item.id], cost: costs[item.id] ?? defaultCost(item.id) }));
    if (lines.some(line => { try { return !D(line.cost).isFinite() || D(line.cost).lte(0); } catch { return true; } })) return setError('Enter a unit cost above zero for every selected product.');
    await command('bulk_stock_increase', { warehouseId: selectedWarehouse.id, date, purpose, reason, lines });
  }

  return <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
    <DialogContent className="stock-increase-dialog">
      <DialogTitle>Increase inventory</DialogTitle>
      <DialogDescription>Add quantities for one or many products in a warehouse. The saved increase updates stock value and the accounting ledger.</DialogDescription>
      <form onSubmit={submit}>
        <div className="stock-increase-controls">
          <label>Warehouse
            <select value={selectedWarehouse?.id || ''} onChange={event => { setWarehouseId(event.target.value); setQuantities({}); setCosts({}); }} required>
              {warehouses.map(warehouse => <option value={warehouse.id} key={warehouse.id}>{warehouse.name}</option>)}
            </select>
          </label>
          <label>Date<input type="date" value={date} onChange={event => setDate(event.target.value)} required/></label>
          <label>Same quantity for all
            <span className="stock-fill-all"><input type="number" min="0.0001" step="0.0001" value={sameQuantity} onChange={event => setSameQuantity(event.target.value)} placeholder="e.g. 10"/><Button type="button" variant="outline" onClick={() => {
              try { if (D(sameQuantity || 0).gt(0)) setQuantities(Object.fromEntries(workspace.items.map(item => [item.id, sameQuantity]))); } catch { setError('Enter a valid quantity above zero.'); }
            }}>Fill all</Button></span>
          </label>
        </div>
        <div className="stock-increase-table table-scroll">
          <table>
            <thead><tr><th>Product</th><th>Current quantity</th><th>Add quantity</th><th>Unit cost</th></tr></thead>
            <tbody>{workspace.items.map(item => {
              const level = selectedWarehouse ? stock(workspace, item.id, selectedWarehouse.id) : null;
              return <tr key={item.id}>
                <td><strong>{item.name}</strong><small>{item.sku} · {item.unit}</small></td>
                <td>{level ? D(level.quantity).toString() : '—'} {item.unit}</td>
                <td><input aria-label={`Increase ${item.name}`} type="number" min="0" step="0.0001" placeholder="0" value={quantities[item.id] || ''} onChange={event => setQuantities(current => ({ ...current, [item.id]: event.target.value }))}/></td>
                <td><input aria-label={`Unit cost for ${item.name}`} type="number" min="0.0001" step="0.0001" value={costs[item.id] ?? defaultCost(item.id)} onChange={event => setCosts(current => ({ ...current, [item.id]: event.target.value }))}/></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <div className="stock-increase-summary"><span>{selectedItems.length} {selectedItems.length === 1 ? 'product' : 'products'} selected</span><strong>Added value: {formatMoney(totalValue.toString())}</strong></div>
        <div className="stock-increase-reason-grid">
          <label>Type of increase<select value={purpose} onChange={event => setPurpose(event.target.value as 'opening_stock' | 'count_correction')}><option value="count_correction">Stock count correction</option><option value="opening_stock">Opening stock</option></select></label>
          <label>Reason for increase<input value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain why stock is being added" required maxLength={2000}/></label>
        </div>
        <p className="stock-increase-help">Opening stock is offset against owner’s capital. Count corrections offset operating expense. Record supplier purchases in Purchasing.</p>
        {(error || notice) && <div className="error-note" role="alert">{error || notice}</div>}
        <div className="form-actions"><Button type="button" variant="outline" onClick={close}>Cancel</Button><Button type="submit" disabled={!!busy || !selectedWarehouse || selectedItems.length === 0}><Plus size={16}/>Save increase</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
