'use client';
import { useRef, useState } from 'react';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { DocumentPreview, type BrandingAssets } from './document-preview';
import type { CompanyDraft } from './company-form';
import { documentView, sampleInvoiceView } from '@/modules/erp/documents';
import type { Branding, Workspace } from '@/modules/erp/types';

export type BrandingDraft = Pick<Branding, 'accent' | 'footer'>;
// fetch() rejects only when the request never reached the server; the browser's own text ("Failed to fetch") means nothing to a user.
const offline = () => { throw new Error('No internet connection. Check your connection and try again.'); };
const swatches = ['#087f69', '#1f5fa8', '#7a3fa0', '#b94145', '#c2611a', '#2f3e4e', '#0e7490', '#4d7c0f'];

/**
 * Colour, footer and image uploads with a live preview of the standard invoice template.
 * Uploads post straight to /api/branding/upload and the parent receives the updated workspace.
 */
export function BrandingForm({ workspace, company, value, onChange, onWorkspace, disabled = false }: {
  workspace: Workspace;
  company: CompanyDraft;
  value: BrandingDraft;
  onChange: (next: BrandingDraft) => void;
  onWorkspace: (next: Workspace) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<'logo' | 'letterhead' | ''>('');
  const [error, setError] = useState('');
  const logoInput = useRef<HTMLInputElement>(null);
  const letterheadInput = useRef<HTMLInputElement>(null);
  const version = workspace.revision;
  const assets: BrandingAssets = {
    logoUrl: workspace.branding.logoPath ? `/api/branding/logo?tenant=${workspace.tenantId}&v=${version}` : undefined,
    letterheadUrl: workspace.branding.letterheadPath ? `/api/branding/letterhead?tenant=${workspace.tenantId}&v=${version}` : undefined,
  };
  const invoice = workspace.documents.find(d => d.kind === 'sales_invoice' && d.status === 'submitted');
  const view = invoice ? documentView(workspace, invoice) : sampleInvoiceView();
  const previewCompany = { ...workspace.company, ...company, logo: company.name.trim().charAt(0).toUpperCase() || workspace.company.logo };

  async function upload(kind: 'logo' | 'letterhead', file: File | undefined) {
    if (!file) return;
    setBusy(kind); setError('');
    try {
      const form = new FormData();
      form.set('kind', kind); form.set('file', file);
      const response = await fetch('/api/branding/upload', { method: 'POST', headers: { 'x-tenant-id': workspace.tenantId }, body: form }).catch(offline);
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || 'Upload failed.');
      onWorkspace(result.workspace);
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setBusy(''); if (logoInput.current) logoInput.current.value = ''; if (letterheadInput.current) letterheadInput.current.value = ''; }
  }
  async function remove(kind: 'logo' | 'letterhead') {
    setBusy(kind); setError('');
    try {
      const payload = { ...workspace.branding, ...value, [kind === 'logo' ? 'logoPath' : 'letterheadPath']: undefined };
      const response = await fetch('/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-id': workspace.tenantId }, body: JSON.stringify({ type: 'save_branding', payload, idempotencyKey: crypto.randomUUID() }) }).catch(offline);
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || 'Could not remove the image.');
      onWorkspace(result.workspace);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not remove the image.'); }
    finally { setBusy(''); }
  }

  return <div className="branding-layout">
    <div className="branding-controls">
      <div className="branding-option">
        <span className="branding-label">Logo <span className="field-optional">PNG or JPG, up to 1 MB</span></span>
        <div className="branding-upload">
          <input ref={logoInput} type="file" accept="image/png,image/jpeg" aria-label="Upload logo" disabled={disabled || !!busy} onChange={event => upload('logo', event.target.files?.[0])}/>
          <Button type="button" variant="outline" disabled={disabled || !!busy} onClick={() => logoInput.current?.click()}>{busy === 'logo' ? <Loader2 className="spin" size={16}/> : <ImagePlus size={16}/>}{workspace.branding.logoPath ? 'Replace logo' : 'Upload logo'}</Button>
          {workspace.branding.logoPath && <Button type="button" variant="ghost" disabled={disabled || !!busy} onClick={() => remove('logo')}><Trash2 size={15}/>Remove</Button>}
        </div>
      </div>
      <div className="branding-option">
        <span className="branding-label">Letterhead <span className="field-optional">optional · replaces the whole header · up to 2 MB</span></span>
        <div className="branding-upload">
          <input ref={letterheadInput} type="file" accept="image/png,image/jpeg" aria-label="Upload letterhead" disabled={disabled || !!busy} onChange={event => upload('letterhead', event.target.files?.[0])}/>
          <Button type="button" variant="outline" disabled={disabled || !!busy} onClick={() => letterheadInput.current?.click()}>{busy === 'letterhead' ? <Loader2 className="spin" size={16}/> : <ImagePlus size={16}/>}{workspace.branding.letterheadPath ? 'Replace letterhead' : 'Upload letterhead'}</Button>
          {workspace.branding.letterheadPath && <Button type="button" variant="ghost" disabled={disabled || !!busy} onClick={() => remove('letterhead')}><Trash2 size={15}/>Remove</Button>}
        </div>
      </div>
      <div className="branding-option">
        <span className="branding-label">Accent colour</span>
        <div className="swatches" role="radiogroup" aria-label="Accent colour">
          {swatches.map(colour => <button key={colour} type="button" role="radio" aria-checked={value.accent === colour} aria-label={colour} className={`swatch ${value.accent === colour ? 'active' : ''}`} style={{ background: colour }} disabled={disabled} onClick={() => onChange({ ...value, accent: colour })}/>)}
          <input type="color" aria-label="Custom accent colour" value={value.accent} disabled={disabled} onChange={event => onChange({ ...value, accent: event.target.value })}/>
        </div>
      </div>
      <label className="branding-option">Footer text <span className="field-optional">bank details, terms, signature line</span>
        <textarea rows={3} maxLength={1000} value={value.footer} disabled={disabled} onChange={event => onChange({ ...value, footer: event.target.value })} placeholder={'Bank: … · Account: …\nGoods once sold are not returnable without prior approval.'}/>
      </label>
      {error && <p className="error-note" role="alert">{error}</p>}
    </div>
    <div className="branding-preview">
      <span className="branding-label">Preview{invoice ? ` · ${invoice.number}` : ' · sample invoice'}</span>
      <div className="branding-preview-frame" tabIndex={0} role="region" aria-label="Invoice preview"><DocumentPreview view={view} company={previewCompany} branding={{ ...workspace.branding, ...value }} assets={assets} compact/></div>
    </div>
  </div>;
}
