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
  const editable = ['Owner', 'Accountant', 'Warehouse Manager'].includes(actor.role);
  const rows = workspace.items.map(item => {
    const level = stock(workspace, item.id);
    return <tr key={item.id}>
      <td>{item.sku}</td><td><strong>{item.name}</strong></td><td>{item.category}</td>
      <td>{D(level.quantity).toString()} {item.unit}</td><td>{formatMoney(level.average)}</td><td>{formatMoney(level.value)}</td>
      <td><span className={`badge ${D(level.quantity).lte(item.reorderLevel) ? 'warning' : 'success'}`}>{D(level.quantity).lte(item.reorderLevel) ? 'low stock' : 'available'}</span></td>
      <td><div className="inventory-row-actions"><Button size="sm" variant="outline" aria-label={`View ${item.name}`} onClick={() => setSelected({ itemId: item.id, mode: 'view' })}>View</Button>{editable && <Button size="sm" aria-label={`Edit ${item.name}`} onClick={() => setSelected({ itemId: item.id, mode: 'edit' })}>Edit</Button>}</div></td>
    </tr>;
  });
  return <div className="stack">
    <section className="card"><div className="card-heading"><div><h2>Stock across all warehouses</h2><p>{workspace.items.length} products · Select View for warehouse detail</p></div>{editable && <Button variant="outline" onClick={openStockTransfer}><ArrowRightLeft size={16}/>Transfer stock</Button>}</div>
      <div className="table-scroll"><table><thead><tr>{['SKU','Product','Category','Total quantity','Average cost','Value','Reorder','Actions'].map(head => <th key={head}>{head}</th>)}</tr></thead><tbody>{rows.length ? rows : <tr><td colSpan={8}><div className="empty-state">No products yet.</div></td></tr>}</tbody></table></div>
    </section>
    <section className="card"><div className="card-heading"><div><h2>Stock by warehouse</h2><p>Invoices draw stock from their selected warehouse.</p></div></div>
      <div className="table-scroll"><table><thead><tr>{['SKU','Product','Warehouse','Quantity','Average cost','Value'].map(head => <th key={head}>{head}</th>)}</tr></thead><tbody>{workspace.items.flatMap(item => workspace.warehouses.map(warehouse => {
        const level = stock(workspace, item.id, warehouse.id);
        return <tr key={`${item.id}:${warehouse.id}`}><td>{item.sku}</td><td>{item.name}</td><td>{warehouse.name}</td><td>{D(level.quantity).toString()} {item.unit}</td><td>{formatMoney(level.average)}</td><td>{formatMoney(level.value)}</td></tr>;
      }))}</tbody></table></div>
    </section>
    {selected && <ItemDetails key={`${selected.itemId}:${selected.mode}`} workspace={workspace} actor={actor} itemId={selected.itemId} initialMode={selected.mode} onClose={() => setSelected(null)} command={command} busy={busy} notice={notice}/>}
  </div>;
}
