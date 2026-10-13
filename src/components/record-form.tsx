'use client';
import { useState, type FormEvent } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import type { EntitySpec, FieldSpec } from '@/modules/erp/master-data';
import type { Workspace } from '@/modules/erp/types';

type Draft = Record<string, unknown>;

/** "Key = value" lines ↔ record / tier array, for commission-plan rate tables. */
function pairsToText(value: unknown, key: string) {
  if (key === 'tiers' && Array.isArray(value)) return value.map(t => `${t.threshold} = ${t.rate}`).join('\n');
  if (value && typeof value === 'object') return Object.entries(value as Record<string, string>).map(([k, v]) => `${k} = ${v}`).join('\n');
  return '';
}
function textToPairs(text: string, key: string) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [k, ...rest] = l.split('='); return [k.trim(), rest.join('=').trim()] as [string, string]; }).filter(([k, v]) => k && v);
  if (key === 'tiers') return lines.length ? lines.map(([threshold, rate]) => ({ threshold, rate })) : [{ threshold: '0', rate: '0' }];
  return Object.fromEntries(lines);
}

/** Generic create/edit dialog driven by an entity spec. Validation messages come from the engine. */
export function RecordForm({ spec, workspace, initial, open, busy, onClose, onSave }: {
  spec: EntitySpec<never>;
  workspace: Workspace;
  initial: Draft | null;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: Draft) => Promise<{ ok: boolean; message: string }>;
}) {
  const [error, setError] = useState('');
  const isNew = !initial?.id;
  const fields = spec.fields as FieldSpec[];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    const data = new FormData(event.currentTarget);
    const payload: Draft = { ...(initial ?? {}) };
    for (const field of fields) {
      const raw = data.get(field.key);
      if (field.type === 'checkbox') payload[field.key] = data.get(field.key) === 'on';
      else if (field.type === 'pairs') payload[field.key] = textToPairs(String(raw ?? ''), field.key);
      else if (field.type === 'number') payload[field.key] = String(raw ?? '').trim() === '' ? 0 : Number(raw);
      else if (field.type === 'select' && String(raw ?? '') === '') delete payload[field.key];
      else payload[field.key] = String(raw ?? '').trim();
    }
    const result = await onSave(payload);
    if (!result.ok) setError(result.message);
  }

  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <DialogContent className="record-dialog">
      <DialogTitle>{isNew ? `New ${spec.singular}` : `Edit ${spec.singular}`}</DialogTitle>
      <DialogDescription>{isNew ? `Add a ${spec.singular} to ${workspace.company.name}.` : 'Changes apply to future documents; posted history is unchanged.'}</DialogDescription>
      <form key={String(initial?.id ?? 'new')} className="field-grid record-form" onSubmit={submit}>
        {fields.map(field => {
          const value = initial?.[field.key];
          const options = typeof field.options === 'function' ? field.options(workspace) : field.options ?? [];
          const label = <span className="record-label">{field.label}{field.required && <span aria-hidden="true" className="record-required">*</span>}</span>;
          const hint = field.hint && <small className="field-hint">{field.hint}</small>;
          const className = field.full ? 'full-width' : undefined;
          if (field.type === 'checkbox') return <label key={field.key} className={`${className ?? ''} record-checkbox`}><input type="checkbox" name={field.key} defaultChecked={!!value}/> {field.label}{hint}</label>;
          if (field.type === 'select') return <label key={field.key} className={className}>{label}<select name={field.key} defaultValue={String(value ?? '')} required={field.required}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>{hint}</label>;
          if (field.type === 'pairs') return <label key={field.key} className={className}>{label}<textarea name={field.key} rows={3} defaultValue={pairsToText(value, field.key)} placeholder={field.key === 'tiers' ? '0 = 2\n500000 = 3' : 'Lighting = 2.5'}/>{hint}</label>;
          if (field.type === 'textarea') return <label key={field.key} className={className}>{label}<textarea name={field.key} rows={2} defaultValue={String(value ?? '')}/>{hint}</label>;
          const numeric = field.type === 'number' || field.type === 'money' || field.type === 'percent';
          return <label key={field.key} className={className}>{label}<input name={field.key} type={numeric ? 'number' : 'text'} step={field.type === 'number' ? '1' : '0.0001'} min={numeric ? '0' : undefined} max={field.type === 'percent' ? '100' : undefined} defaultValue={String(value ?? '')} required={field.required} autoFocus={field === fields[0]}/>{hint}</label>;
        })}
        {error && <p className="error-note full-width" role="alert">{error}</p>}
        <div className="form-actions full-width"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? <Loader2 className="spin" size={16}/> : <Save size={16}/>}{isNew ? `Add ${spec.singular}` : 'Save changes'}</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
