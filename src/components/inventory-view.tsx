'use client';

import { useMemo, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import type Decimal from 'decimal.js';
import { Button } from './ui/button';
import { ItemDetails } from './item-details';
import { D, formatMoney, money } from '@/modules/erp/money';
import type { Actor, Workspace } from '@/modules/erp/types';

/**
 * Stock per item and per item and warehouse from one pass over the movements, with the same sums and rounding as
 * the engine's stock(), which scans every movement on each call (too slow for thousands of items × warehouses).
 */
export function stockLevels(moves: Workspace['stockMoves']) {
  const totals = new Map<string, { quantity: Decimal; value: Decimal }>();
  const add = (key: string, quantity: string, value: string) => { const total = totals.get(key) ?? { quantity: D(0), value: D(0) }; total.quantity = total.quantity.plus(quantity); total.value = total.value.plus(value); totals.set(key, total); };
  for (const move of moves) { add(move.itemId, move.quantity, move.value); add(`${move.itemId}\u0000${move.warehouseId}`, move.quantity, move.value); }
  return (itemId: string, warehouseId?: string) => {
    const total = totals.get(warehouseId ? `${itemId}\u0000${warehouseId}` : itemId);
    const quantity = total?.quantity ?? D(0);
    const value = total?.value ?? D(0);
    return { quantity: money(quantity), value: money(value), average: money(quantity.gt(0) ? value.div(quantity) : 0) };
  };
}

/** Rows rendered per table before "Show more": large catalogues stay quick to draw; search and filters reach the rest. */
export const inventoryPageSize = 100;

function ShowMore({ shown, total, noun, onMore }: { shown: number; total: number; noun: string; onMore: () => void }) {
  if (shown >= total) return null;
  return <div className="card-body inventory-row-actions"><Button size="sm" variant="outline" onClick={onMore}>Show {Math.min(inventoryPageSize, total - shown)} more</Button><small className="muted">Showing {shown.toLocaleString('en-PK')} of {total.toLocaleString('en-PK')} {noun}</small></div>;
}

export function InventoryView({ workspace, actor, busy, notice, command, openStockTransfer }: {
  workspace: Workspace;
  actor: Actor;
  busy: string;
  notice: string;
  command: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  openStockTransfer: () => void;
}) {
  const [selected, setSelected] = useState<{ itemId: string; mode: 'view' | 'edit' } | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [availability, setAvailability] = useState('');
  const [itemLimit, setItemLimit] = useState(inventoryPageSize);
  const [breakdownLimit, setBreakdownLimit] = useState(inventoryPageSize);
  // A new filter starts both tables from the top again.
  const refilter = <T,>(set: (value: T) => void) => (value: T) => { set(value); setItemLimit(inventoryPageSize); setBreakdownLimit(inventoryPageSize); };
  const editable = ['Owner', 'Accountant', 'Warehouse Manager'].includes(actor.role);
  const stock = useMemo(() => stockLevels(workspace.stockMoves), [workspace.stockMoves]);
  const warehouse = workspace.warehouses.find(location => location.id === warehouseId);
  // With one warehouse there is nothing to choose between: show plain stock, no warehouse pickers or breakdowns.
  const singleLocation = workspace.warehouses.length <= 1;
  const categories = [...new Set(workspace.items.map(item => item.category))].sort();
  const needle = query.trim().toLocaleLowerCase();
  const filteredItems = workspace.items.filter(item => {
    const level = stock(item.id, warehouseId || undefined);
    const quantity = D(level.quantity);
    return (!needle || `${item.sku} ${item.name}`.toLocaleLowerCase().includes(needle))
      && (!category || item.category === category)
      && (!availability || (availability === 'out' ? quantity.isZero() : availability === 'low' ? quantity.gt(0) && quantity.lte(item.reorderLevel) : quantity.gt(0)));
  });
  const filtered = !!(query || category || warehouseId || availability);
  const rows = filteredItems.slice(0, itemLimit).map(item => {
    const level = stock(item.id, warehouseId || undefined);
    return <tr key={item.id}>
      <td>{item.sku}</td><td><strong>{item.name}</strong></td><td>{item.category}</td>
      <td>{D(level.quantity).toString()} {item.unit}</td><td>{formatMoney(level.average)}</td><td>{formatMoney(level.value)}</td>
      <td><span className={`badge ${D(level.quantity).isZero() ? 'danger' : D(level.quantity).lte(item.reorderLevel) ? 'warning' : 'success'}`}>{D(level.quantity).isZero() ? 'out of stock' : D(level.quantity).lte(item.reorderLevel) ? 'low stock' : 'available'}</span></td>
      <td><div className="inventory-row-actions"><Button size="sm" variant="outline" aria-label={`View ${item.name}`} onClick={() => setSelected({ itemId: item.id, mode: 'view' })}>View</Button>{editable && <Button size="sm" aria-label={`Edit ${item.name}`} onClick={() => setSelected({ itemId: item.id, mode: 'edit' })}>Edit</Button>}</div></td>
    </tr>;
  });
  const locations = workspace.warehouses.filter(location => !warehouseId || location.id === warehouseId);
  const breakdownTotal = singleLocation ? 0 : filteredItems.length * locations.length;
  const breakdownRows = singleLocation ? [] : filteredItems.slice(0, Math.ceil(breakdownLimit / Math.max(1, locations.length))).flatMap(item => locations.map(location => ({ item, location }))).slice(0, breakdownLimit).map(({ item, location }) => {
    const level = stock(item.id, location.id);
    return <tr key={`${item.id}:${location.id}`}><td>{item.sku}</td><td>{item.name}</td><td>{location.name}</td><td>{D(level.quantity).toString()} {item.unit}</td><td>{formatMoney(level.average)}</td><td>{formatMoney(level.value)}</td></tr>;
  });
  function clear() { setQuery(''); setCategory(''); setWarehouseId(''); setAvailability(''); setItemLimit(inventoryPageSize); setBreakdownLimit(inventoryPageSize); }
  return <div className="stack">
    <section className="card"><div className="card-heading"><div><h2>{warehouse ? `Stock in ${warehouse.name}` : singleLocation ? 'Stock' : 'Stock across all warehouses'}</h2><p>{filteredItems.length} of {workspace.items.length} products{singleLocation ? '' : ' · Select View for warehouse detail'}</p></div>{editable && !singleLocation && <Button variant="outline" onClick={openStockTransfer}><ArrowRightLeft size={16}/>Transfer stock</Button>}</div>
      <div className="list-filters" aria-label="Inventory filters">
        <label className="list-filter-search">Search<input aria-label="Search inventory" type="search" value={query} onChange={event => refilter(setQuery)(event.target.value)} placeholder="SKU or product name"/></label>
        <label>Category<select aria-label="Category" value={category} onChange={event => refilter(setCategory)(event.target.value)}><option value="">All categories</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        {!singleLocation && <label>Warehouse<select aria-label="Warehouse filter" value={warehouseId} onChange={event => refilter(setWarehouseId)(event.target.value)}><option value="">All warehouses</option>{workspace.warehouses.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>}
        <label>Stock level<select aria-label="Stock level" value={availability} onChange={event => refilter(setAvailability)(event.target.value)}><option value="">All levels</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select></label>
        {filtered && <button className="list-filter-clear" type="button" onClick={clear}>Clear filters</button>}
      </div>
      <div className="table-scroll"><table><thead><tr>{['SKU','Product','Category',warehouse ? 'Warehouse quantity' : singleLocation ? 'Quantity' : 'Total quantity','Average cost','Value','Reorder','Actions'].map(head => <th key={head}>{head}</th>)}</tr></thead><tbody>{rows.length ? rows : <tr><td colSpan={8}><div className="empty-state">No products match these filters.</div></td></tr>}</tbody></table></div><p className="table-scroll-hint">Swipe sideways to see every column.</p>
      <ShowMore shown={rows.length} total={filteredItems.length} noun="products" onMore={() => setItemLimit(limit => limit + inventoryPageSize)}/>
    </section>
    {!singleLocation && <section className="card"><div className="card-heading"><div><h2>Stock by warehouse</h2><p>Invoices draw stock from their selected warehouse.</p></div></div>
      <div className="table-scroll"><table><thead><tr>{['SKU','Product','Warehouse','Quantity','Average cost','Value'].map(head => <th key={head}>{head}</th>)}</tr></thead><tbody>{breakdownRows.length ? breakdownRows : <tr><td colSpan={6}><div className="empty-state">No warehouse stock matches these filters.</div></td></tr>}</tbody></table></div><p className="table-scroll-hint">Swipe sideways to see every column.</p>
      <ShowMore shown={breakdownRows.length} total={breakdownTotal} noun="rows" onMore={() => setBreakdownLimit(limit => limit + inventoryPageSize)}/>
    </section>}
    {selected && <ItemDetails key={`${selected.itemId}:${selected.mode}`} workspace={workspace} actor={actor} itemId={selected.itemId} initialMode={selected.mode} onClose={() => setSelected(null)} command={command} busy={busy} notice={notice}/>}
  </div>;
}
