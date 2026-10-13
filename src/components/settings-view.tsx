'use client';
import { useRef, useState, type ReactNode } from 'react';
import { Loader2, RefreshCw, Save } from 'lucide-react';
import { Button } from './ui/button';
import { CompanyForm, readCompanyForm, type CompanyDraft } from './company-form';
import { BrandingForm, type BrandingDraft } from './branding-form';
import { ModulePicker } from './module-picker';
import { ConfirmPasswordDialog } from './confirm-password-dialog';
import { moduleCatalogue, moduleRecordCounts, withRequirements } from '@/modules/erp/modules';
import { roles } from '@/modules/erp/types';
import type { Role, ToggleModule, Workspace } from '@/modules/erp/types';

type CommandResult = { ok: boolean; message: string; passwordRequired?: boolean };
type Tab = 'company' | 'features' | 'access' | 'audit';

export function SettingsView({ workspace, realRole, role, setRole, busy, command, onWorkspace, onReset, audit }: {
  workspace: Workspace;
  realRole: Role;
  role: Role;
  setRole: (role: Role) => void;
  busy: string;
  command: (type: string, payload: Record<string, unknown>, options?: { confirmPassword?: string }) => Promise<CommandResult>;
  onWorkspace: (next: Workspace) => void;
  onReset: () => void;
  audit: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('company');
  const readOnly = role === 'Auditor';
  const tabs: { key: Tab; label: string }[] = [{ key: 'company', label: 'Company & documents' }, { key: 'features', label: 'Features' }, { key: 'access', label: 'Access' }, { key: 'audit', label: 'Audit history' }];
  return <div className="stack">
    <div className="tabs" role="tablist">{tabs.map(item => <button key={item.key} role="tab" aria-selected={tab === item.key} className={`tab ${tab === item.key ? 'active' : ''}`} onClick={() => setTab(item.key)}>{item.label}</button>)}</div>
    {tab === 'company' && <CompanySettings workspace={workspace} busy={busy} readOnly={readOnly} command={command} onWorkspace={onWorkspace}/>}
    {tab === 'features' && <FeaturesSettings workspace={workspace} readOnly={readOnly} command={command}/>}
    {tab === 'access' && <section className="card"><div className="card-heading"><div><h2>Company and access</h2><p>Role preview shows the screens and data that role receives. Server permissions still use your real role.</p></div>{workspace.demo && realRole === 'Owner' && <Button variant="destructive" disabled={!!busy} onClick={onReset}>{busy === 'reset' ? <Loader2 className="spin" size={16}/> : <RefreshCw size={16}/>}Reset demo</Button>}</div><div className="settings-grid"><div><span>Company</span><strong>{workspace.company.name}</strong></div><div><span>Tax identity</span><strong>{workspace.company.taxId || 'Not configured'}</strong></div><label>View as role<select value={role} disabled={!(workspace.demo && realRole === 'Owner')} onChange={event => setRole(event.target.value as Role)}>{roles.map(value => <option key={value}>{value}</option>)}</select></label><div><span>Revision</span><strong>{workspace.revision}</strong></div></div></section>}
    {tab === 'audit' && audit}
  </div>;
}

function CompanySettings({ workspace, busy, readOnly, command, onWorkspace }: { workspace: Workspace; busy: string; readOnly: boolean; command: SettingsViewCommand; onWorkspace: (next: Workspace) => void }) {
  const [company, setCompany] = useState<CompanyDraft>({ name: workspace.company.name, address: workspace.company.address, phone: workspace.company.phone, email: workspace.company.email, taxId: workspace.company.taxId });
  const [branding, setBranding] = useState<BrandingDraft>({ accent: workspace.branding.accent, footer: workspace.branding.footer });
  const [saved, setSaved] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(company) !== JSON.stringify({ name: workspace.company.name, address: workspace.company.address, phone: workspace.company.phone, email: workspace.company.email, taxId: workspace.company.taxId })
    || branding.accent !== workspace.branding.accent || branding.footer !== workspace.branding.footer;
  async function save() {
    setSaved('');
    const draft = form.current ? readCompanyForm(form.current) : company;
    const first = await command('save_company', draft);
    if (!first.ok) return setSaved(first.message);
    const second = await command('save_branding', { ...workspace.branding, ...branding });
    setSaved(second.ok ? 'Company details and document branding saved.' : second.message);
  }
  return <section className="card">
    <div className="card-heading"><div><h2>Company & documents</h2><p>What customers and suppliers see on every printed document.</p></div>{!readOnly && <Button disabled={!!busy || !dirty} onClick={save}>{busy === 'save_company' || busy === 'save_branding' ? <Loader2 className="spin" size={16}/> : <Save size={16}/>}Save changes</Button>}</div>
    <div className="card-body stack">
      <form ref={form} onSubmit={event => { event.preventDefault(); save(); }}><CompanyForm value={company} onChange={setCompany} disabled={readOnly || !!busy}/></form>
      <BrandingForm workspace={workspace} company={company} value={branding} onChange={setBranding} onWorkspace={onWorkspace} disabled={readOnly || !!busy}/>
      {saved && <p className={saved.includes('saved') ? 'form-note' : 'error-note'} role="status">{saved}</p>}
    </div>
  </section>;
}

type SettingsViewCommand = (type: string, payload: Record<string, unknown>, options?: { confirmPassword?: string }) => Promise<CommandResult>;

function FeaturesSettings({ workspace, readOnly, command }: { workspace: Workspace; readOnly: boolean; command: SettingsViewCommand }) {
  const [pending, setPending] = useState<ToggleModule[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const labelOf = (key: ToggleModule) => moduleCatalogue.find(item => item.key === key)!.label;

  async function change(next: ToggleModule[]) {
    setError('');
    const enabled = withRequirements(next);
    const removed = workspace.modules.filter(key => !enabled.includes(key));
    if (removed.length) { setPending(enabled); return; }
    setBusy(true);
    const result = await command('set_modules', { enabled });
    setBusy(false);
    if (!result.ok) setError(result.message);
  }
  async function confirm(password: string) {
    if (!pending) return;
    setBusy(true); setError('');
    const result = await command('set_modules', { enabled: pending }, { confirmPassword: password });
    setBusy(false);
    if (result.ok) setPending(null); else setError(result.message);
  }
  const removing = pending ? workspace.modules.filter(key => !pending.includes(key)) : [];
  return <section className="card">
    <div className="card-heading"><div><h2>Features</h2><p>Turn modules on or off. Turning one off hides it and keeps every record; your password confirms it.</p></div></div>
    <div className="card-body">
      <ModulePicker selected={workspace.modules} onChange={change} workspace={workspace} disabled={readOnly || busy} showPresets={false}/>
      {error && !pending && <p className="error-note" role="alert">{error}</p>}
    </div>
    <ConfirmPasswordDialog open={pending !== null} title={`Hide ${removing.map(labelOf).join(', ')}?`} busy={busy} error={error} confirmLabel="Hide and keep records"
      description={<>{removing.map(key => { const counts = moduleRecordCounts(workspace, key).filter(c => c.count > 0); return <span key={key} className="confirm-line"><strong>{labelOf(key)}</strong>{counts.length ? `: ${counts.map(c => `${c.count} ${c.label}`).join(', ')} will be hidden, not deleted.` : ': nothing recorded yet.'}</span>; })} Drafts inside a hidden module cannot be submitted until it is turned back on.</>}
      onCancel={() => { setPending(null); setError(''); }} onConfirm={confirm}/>
  </section>;
}
