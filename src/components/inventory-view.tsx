'use client';

import { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Button } from './ui/button';
import { ItemDetails } from './item-details';
import { stock } from '@/modules/erp/engine';
import { D, formatMoney } from '@/modules/erp/money';
import type { Actor, Workspace } from '@/modules/erp/types';

export function InventoryView({ workspace, actor, busy, notice, command, openStockTransfer }: {
  workspace: Workspace;
  actor: Actor;
  busy: string;
  notice: string;
  command: (type: string, payload: Record<string, unknown>) => Promise<void>;
  openStockTransfer: () => void;
}) {
  const [selected, setSelected] = useState<{ itemId: string; mode: 'view' | 'edit' } | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [availability, setAvailability] = useState('');
  const editable = ['Owner', 'Accountant', 'Warehouse Manager'].includes(actor.role);
  const warehouse = workspace.warehouses.find(location => location.id === warehouseId);
  const categories = [...new Set(workspace.items.map(item => item.category))].sort();
  const needle = query.trim().toLocaleLowerCase();
  const filteredItems = workspace.items.filter(item => {
    const level = stock(workspace, item.id, warehouseId || undefined);
    const quantity = D(level.quantity);
    return (!needle || `${item.sku} ${item.name}`.toLocaleLowerCase().includes(needle))
      && (!category || item.category === category)
      && (!availability || (availability === 'out' ? quantity.isZero() : availability === 'low' ? quantity.gt(0) && quantity.lte(item.reorderLevel) : quantity.gt(0)));
  });
  const filtered = !!(query || category || warehouseId || availability);
  const rows = filteredItems.map(item => {
    const level = stock(workspace, item.id, warehouseId || undefined);
    return <tr key={item.id}>
      <td>{item.sku}</td><td><strong>{item.name}</strong></td><td>{item.category}</td>
      <td>{D(level.quantity).toString()} {item.unit}</td><td>{formatMoney(level.average)}</td><td>{formatMoney(level.value)}</td>
      <td><span className={`badge ${D(level.quantity).isZero() ? 'danger' : D(level.quantity).lte(item.reorderLevel) ? 'warning' : 'success'}`}>{D(level.quantity).isZero() ? 'out of stock' : D(level.quantity).lte(item.reorderLevel) ? 'low stock' : 'available'}</span></td>
      <td><div className="inventory-row-actions"><Button size="sm" variant="outline" aria-label={`View ${item.name}`} onClick={() => setSelected({ itemId: item.id, mode: 'view' })}>View</Button>{editable && <Button size="sm" aria-label={`Edit ${item.name}`} onClick={() => setSelected({ itemId: item.id, mode: 'edit' })}>Edit</Button>}</div></td>
    </tr>;
  });
  const breakdownRows = filteredItems.flatMap(item => workspace.warehouses.filter(location => !warehouseId || location.id === warehouseId).map(location => {
    const level = stock(workspace, item.id, location.id);
    return <tr key={`${item.id}:${location.id}`}><td>{item.sku}</td><td>{item.name}</td><td>{location.name}</td><td>{D(level.quantity).toString()} {item.unit}</td><td>{formatMoney(level.average)}</td><td>{formatMoney(level.value)}</td></tr>;
  }));
  function clear() { setQuery(''); setCategory(''); setWarehouseId(''); setAvailability(''); }
  return <div className="stack">
    <section className="card"><div className="card-heading"><div><h2>{warehouse ? `Stock in ${warehouse.name}` : 'Stock across all warehouses'}</h2><p>{filteredItems.length} of {workspace.items.length} products · Select View for warehouse detail</p></div>{editable && <Button variant="outline" onClick={openStockTransfer}><ArrowRightLeft size={16}/>Transfer stock</Button>}</div>
      <div className="list-filters" aria-label="Inventory filters">
        <label className="list-filter-search">Search<input aria-label="Search inventory" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="SKU or product name"/></label>
        <label>Category<select aria-label="Category" value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Warehouse<select aria-label="Warehouse filter" value={warehouseId} onChange={event => setWarehouseId(event.target.value)}><option value="">All warehouses</option>{workspace.warehouses.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
        <label>Stock level<select aria-label="Stock level" value={availability} onChange={event => setAvailability(event.target.value)}><option value="">All levels</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select></label>
        {filtered && <button className="list-filter-clear" type="button" onClick={clear}>Clear filters</button>}
      </div>
      <div className="table-scroll"><table><thead><tr>{['SKU','Product','Category',warehouse ? 'Warehouse quantity' : 'Total quantity','Average cost','Value','Reorder','Actions'].map(head => <th key={head}>{head}</th>)}</tr></thead><tbody>{rows.length ? rows : <tr><td colSpan={8}><div className="empty-state">No products match these filters.</div></td></tr>}</tbody></table></div>
    </section>
    <section className="card"><div className="card-heading"><div><h2>Stock by warehouse</h2><p>Invoices draw stock from their selected warehouse.</p></div></div>
      <div className="table-scroll"><table><thead><tr>{['SKU','Product','Warehouse','Quantity','Average cost','Value'].map(head => <th key={head}>{head}</th>)}</tr></thead><tbody>{breakdownRows.length ? breakdownRows : <tr><td colSpan={6}><div className="empty-state">No warehouse stock matches these filters.</div></td></tr>}</tbody></table></div>
    </section>
    {selected && <ItemDetails key={`${selected.itemId}:${selected.mode}`} workspace={workspace} actor={actor} itemId={selected.itemId} initialMode={selected.mode} onClose={() => setSelected(null)} command={command} busy={busy} notice={notice}/>}
  </div>;
}
