'use client';
import { useRef, useState } from 'react';
import Papa from 'papaparse';
import { Download, FileUp, Loader2, Upload } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { csvFields, mapHeader, toCsv, type EntitySpec } from '@/modules/erp/master-data';

type Parsed = { headers: string[]; mapping: Record<string, string | null>; rows: Record<string, string>[] };
/** Same limit as the `import_records` command. */
export const maxImportRows = 2000;

/**
 * Reads CSV rows one at a time (blank lines skipped) and stops at the first row over the limit, so a huge file is
 * refused after its first chunk instead of being parsed whole on the main thread.
 */
export function readCsvRows(input: File | string, done: (result: { headers: string[]; rows: Record<string, string>[]; tooMany: boolean }) => void, failed: () => void = () => {}) {
  const rows: Record<string, string>[] = [];
  let headers: string[] = [];
  let tooMany = false;
  Papa.parse<Record<string, string>, File>(input as File, {
    header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim(),
    step: (row, parser) => {
      if (rows.length >= maxImportRows) { tooMany = true; parser.abort(); return; }
      headers = row.meta.fields ?? headers;
      rows.push(row.data);
    },
    complete: () => done({ headers, rows, tooMany }),
    error: failed,
  });
}

/**
 * CSV import for one entity: parse in the browser, match columns by header, show a preview and
 * the full validation result, then send one all-or-nothing `import_records` command.
 */
export function CsvImportDialog({ spec, open, busy, onClose, onImport }: {
  spec: EntitySpec<never>;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onImport: (rows: Record<string, unknown>[], mode: 'create' | 'upsert') => Promise<{ ok: boolean; message: string }>;
}) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mode, setMode] = useState<'create' | 'upsert'>('create');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const fields = csvFields(spec);

  function reset() { setParsed(null); setError(''); setFileName(''); if (input.current) input.current.value = ''; }
  function parse(file: File | undefined) {
    if (!file) return;
    setError(''); setFileName(file.name);
    readCsvRows(file, ({ headers, rows, tooMany }) => {
      if (tooMany) { setError('Import at most 2,000 rows at a time.'); setParsed(null); return; }
      if (!headers.length || !rows.length) { setError('The file has no data rows.'); setParsed(null); return; }
      const mapping = Object.fromEntries(headers.map(h => [h, mapHeader(h, fields)]));
      setParsed({ headers, mapping, rows });
    }, () => { setError('The file could not be read. Save it as CSV (UTF-8) and try again.'); setParsed(null); });
  }
  function template() {
    const example: Record<string, string> = { name: `Example ${spec.singular}`, sku: 'ABC-001', city: 'Karachi', phone: '+92 300 1234567', email: 'contact@example.com', taxId: '1234567-8', registered: 'yes', customerClass: spec.key === 'suppliers' ? 'Importer' : 'Retailer', creditLimit: '100000', terms: '30', category: 'General', unit: 'pcs', price: '1000', cost: '800', hsCode: '8504.4000', reorderLevel: '20', weight: '1', volume: '0.01', role: 'Order Booker', territory: 'Karachi', salary: '50000', allowance: '5000', deduction: '0', attendance: '30', active: 'yes', manager: '' };
    const headers = fields.map(f => f.key);
    const blob = new Blob([toCsv([Object.fromEntries(headers.map(h => [h, example[h] ?? '']))], headers)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${spec.key}-template.csv`; a.click(); URL.revokeObjectURL(url);
  }
  async function submit() {
    if (!parsed) return;
    setError('');
    const rows = parsed.rows.map(row => { const out: Record<string, unknown> = {}; for (const [header, key] of Object.entries(parsed.mapping)) if (key) out[key] = row[header] ?? ''; return out; });
    const result = await onImport(rows, mode);
    if (result.ok) { reset(); onClose(); } else setError(result.message);
  }
  const mapped = parsed ? Object.values(parsed.mapping).filter(Boolean) : [];
  const unmapped = parsed ? parsed.headers.filter(h => !parsed.mapping[h]) : [];
  const required = fields.filter(f => f.required).map(f => f.key).filter(k => !mapped.includes(k));

  return <Dialog open={open} onOpenChange={value => { if (!value) { reset(); onClose(); } }}>
    <DialogContent className="import-dialog">
      <DialogTitle>Import {spec.label.toLowerCase()} from CSV</DialogTitle>
      <DialogDescription>Columns are matched by their header. Nothing is saved unless every row is valid.</DialogDescription>
      <div className="import-toolbar">
        <input ref={input} type="file" accept=".csv,text/csv" aria-label="Choose CSV file" onChange={event => parse(event.target.files?.[0])} style={{ display: 'none' }}/>
        <Button type="button" variant="outline" onClick={() => input.current?.click()}><FileUp size={16}/>{fileName ? 'Choose another file' : 'Choose CSV file'}</Button>
        <Button type="button" variant="ghost" onClick={template}><Download size={16}/>Download template</Button>
        {fileName && <span className="import-filename">{fileName}</span>}
      </div>
      {parsed && <>
        <div className="import-mapping">
          <span className="branding-label">Columns</span>
          <ul>{parsed.headers.map(h => <li key={h} className={parsed.mapping[h] ? 'ok' : 'skip'}><strong>{h}</strong> → {parsed.mapping[h] ? fields.find(f => f.key === parsed.mapping[h])?.label ?? parsed.mapping[h] : 'ignored'}</li>)}</ul>
          {unmapped.length > 0 && <small className="field-hint">Ignored columns are not imported. Rename a header to one of: {fields.map(f => f.key).join(', ')}.</small>}
          {required.length > 0 && <p className="error-note">Missing required column{required.length > 1 ? 's' : ''}: {required.join(', ')}.</p>}
        </div>
        <div className="table-scroll import-preview"><table><thead><tr>{parsed.headers.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{parsed.rows.slice(0, 5).map((row, i) => <tr key={i}>{parsed.headers.map(h => <td key={h}>{row[h]}</td>)}</tr>)}</tbody></table></div>
        <p className="import-count">{parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} in the file{parsed.rows.length > 5 ? ', first 5 shown' : ''}.</p>
        <div className="import-mode" role="radiogroup" aria-label="Import mode">
          <label><input type="radio" name="mode" checked={mode === 'create'} onChange={() => setMode('create')}/> Create only <small>rows that already exist are reported as errors</small></label>
          <label><input type="radio" name="mode" checked={mode === 'upsert'} onChange={() => setMode('upsert')}/> Create and update existing <small>matched by {spec.key === 'items' ? 'SKU' : 'name'}; blank cells keep current values</small></label>
        </div>
      </>}
      {error && <pre className="error-note import-errors" role="alert">{error}</pre>}
      <div className="form-actions"><Button type="button" variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button><Button type="button" disabled={!parsed || busy || required.length > 0} onClick={submit}>{busy ? <Loader2 className="spin" size={16}/> : <Upload size={16}/>}Import {parsed ? parsed.rows.length : ''} rows</Button></div>
    </DialogContent>
  </Dialog>;
}
