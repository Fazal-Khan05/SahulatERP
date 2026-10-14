'use client';
import { useState } from 'react';
import { Archive, ArchiveRestore, Download, Pencil, Plus, Upload } from 'lucide-react';
import { Button } from './ui/button';
import { RecordForm } from './record-form';
import { CsvImportDialog } from './csv-import-dialog';
import { csvFields, toCsv, type EntitySpec } from '@/modules/erp/master-data';
import { formatMoney } from '@/modules/erp/money';
import type { Workspace } from '@/modules/erp/types';

type CommandFn = (type: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; message: string; recordId?: string }>;
type AnyRecord = { id: string } & Record<string, unknown>;

/** List, search, create/edit, archive and CSV import/export for one master-data entity. */
export function MasterDataView({ spec, workspace, editable, busy, command }: {
  spec: EntitySpec<never>;
  workspace: Workspace;
  editable: boolean;
  busy: string;
  command: CommandFn;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'active' | 'archived' | 'all'>('active');
  const [editing, setEditing] = useState<Record<string, unknown> | null | 'new'>(null);
  const [importing, setImporting] = useState(false);
  const all = spec.records(workspace) as AnyRecord[];
  const isArchived = (r: AnyRecord) => spec.isArchived ? (spec.isArchived as (x: AnyRecord) => boolean)(r) : false;
  const needle = query.trim().toLocaleLowerCase();
  const visible = all.filter(r => (status === 'all' || (status === 'archived') === isArchived(r)) && (!needle || (spec.searchText as (x: AnyRecord, w: Workspace) => string)(r, workspace).toLocaleLowerCase().includes(needle)));
  const archivedCount = all.filter(isArchived).length;
  const moneyKeys = new Set(spec.fields.filter(f => f.type === 'money').map(f => f.key));

  function exportCsv() {
    const headers = csvFields(spec).map(f => f.key);
    const rows = visible.map(r => { const row: Record<string, unknown> = { ...r }; if (spec.key === 'employees') row.manager = workspace.employees.find(e => e.id === r.parentId)?.name ?? ''; return row; });
    const blob = new Blob([toCsv(rows, headers)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${spec.key}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  async function save(payload: Record<string, unknown>) {
    const { openingQuantity, openingCost, openingWarehouseId, ...record } = payload;
    const result = await command(spec.saveCommand, record);
    if (!result.ok) return result;
    // A new product can start with stock on hand; it is booked as opening stock at the cost given.
    const quantity = Number(openingQuantity ?? 0);
    if (spec.key === 'items' && !record.id && quantity > 0 && result.recordId) {
      const warehouseId = String(openingWarehouseId || workspace.warehouses[0]?.id || '');
      const stock = await command('bulk_stock_increase', { warehouseId, date: new Date().toISOString().slice(0, 10), purpose: 'opening_stock', reason: `Opening stock for ${String(record.sku ?? record.name)}`, lines: [{ itemId: result.recordId, quantity: String(quantity), cost: String(openingCost || '') }] });
      if (!stock.ok) return { ok: false, message: `Product saved, but the opening stock was not booked: ${stock.message} Open the product and set its quantity.` };
    }
    setEditing(null);
    return result;
  }
  async function archive(record: AnyRecord, archived: boolean) {
    if (spec.archiveKind) return command('set_archived', { kind: spec.archiveKind, id: record.id, archived });
    if (spec.key === 'employees') return command('save_employee', { ...(spec.toPayload as (r: AnyRecord) => Record<string, unknown>)(record), active: !archived });
  }
  const cell = (record: AnyRecord, column: { key: string; render?: (r: never, w: Workspace) => string }) => {
    if (column.render) return (column.render as (r: AnyRecord, w: Workspace) => string)(record, workspace);
    const value = record[column.key];
    return moneyKeys.has(column.key) ? formatMoney(String(value ?? 0)) : String(value ?? '');
  };
  const canArchive = !!spec.archiveKind || spec.key === 'employees';

  return <section className="card">
    <div className="card-heading">
      <div><h2>{spec.label}</h2><p>{visible.length} of {all.length}{archivedCount ? ` · ${archivedCount} ${spec.key === 'employees' ? 'inactive' : 'archived'}` : ''}</p></div>
      <div className="inventory-actions">
        <Button variant="outline" onClick={exportCsv} disabled={!visible.length}><Download size={16}/>Export CSV</Button>
        {editable && spec.importKind && <Button variant="outline" onClick={() => setImporting(true)}><Upload size={16}/>Import CSV</Button>}
        {editable && <Button onClick={() => setEditing('new')}><Plus size={16}/>New {spec.singular}</Button>}
      </div>
    </div>
    <div className="list-filters" aria-label={`${spec.label} filters`}>
      <label className="list-filter-search">Search<input aria-label={`Search ${spec.label.toLowerCase()}`} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={`Find a ${spec.singular}`}/></label>
      {canArchive && <label>Status<select aria-label="Record status" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="active">{spec.key === 'employees' ? 'Active' : 'Active'}</option><option value="archived">{spec.key === 'employees' ? 'Inactive' : 'Archived'}</option><option value="all">All</option></select></label>}
      {(query || status !== 'active') && <button className="list-filter-clear" type="button" onClick={() => { setQuery(''); setStatus('active'); }}>Clear filters</button>}
    </div>
    <div className="table-scroll"><table><thead><tr>{spec.columns.map(c => <th key={c.key}>{c.label}</th>)}<th>Actions</th></tr></thead><tbody>
      {visible.length ? visible.map(record => <tr key={record.id} className={isArchived(record) ? 'row-archived' : undefined}>
        {spec.columns.map((c, i) => <td key={c.key}>{i === 0 ? <strong>{cell(record, c)}</strong> : cell(record, c)}</td>)}
        <td><div className="inventory-row-actions">
          {editable && <Button size="sm" variant="outline" aria-label={`Edit ${String(record.name)}`} onClick={() => setEditing(record)}><Pencil size={14}/>Edit</Button>}
          {editable && canArchive && (isArchived(record)
            ? <Button size="sm" variant="ghost" disabled={!!busy} aria-label={`Restore ${String(record.name)}`} onClick={() => archive(record, false)}><ArchiveRestore size={14}/>Restore</Button>
            : <Button size="sm" variant="ghost" disabled={!!busy} aria-label={`Archive ${String(record.name)}`} onClick={() => archive(record, true)}><Archive size={14}/>{spec.key === 'employees' ? 'Deactivate' : 'Archive'}</Button>)}
          {!editable && <span>Read only</span>}
        </div></td>
      </tr>) : <tr><td colSpan={spec.columns.length + 1}><div className="empty-state">{all.length ? `No ${spec.label.toLowerCase()} match these filters.` : `No ${spec.label.toLowerCase()} yet. ${editable ? `Add one or import a CSV.` : ''}`}</div></td></tr>}
    </tbody></table></div>
    <p className="table-scroll-hint">Swipe sideways to see every column.</p>
    <RecordForm spec={spec} workspace={workspace} initial={editing === 'new' ? spec.blank(workspace) : editing} open={editing !== null} busy={busy === spec.saveCommand} onClose={() => setEditing(null)} onSave={save}/>
    {spec.importKind && <CsvImportDialog spec={spec} open={importing} busy={busy === 'import_records'} onClose={() => setImporting(false)} onImport={(rows, mode) => command('import_records', { kind: spec.importKind, mode, rows })}/>}
  </section>;
}
