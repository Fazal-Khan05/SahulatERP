'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader2, Sparkles } from 'lucide-react';
import { Button } from './ui/button';
import { CompanyForm, readCompanyForm, type CompanyDraft } from './company-form';
import { BrandingForm, type BrandingDraft } from './branding-form';
import { ModulePicker } from './module-picker';
import { moduleCatalogue, presets, withRequirements } from '@/modules/erp/modules';
import type { Actor, ToggleModule, Workspace } from '@/modules/erp/types';

type Step = 1 | 2 | 3 | 4;
const steps: { step: Step; title: string; hint: string }[] = [
  { step: 1, title: 'Company', hint: 'Name and contact details for your documents' },
  { step: 2, title: 'Documents', hint: 'How your invoices should look' },
  { step: 3, title: 'Features', hint: 'Choose what you need; change it any time' },
  { step: 4, title: 'Review', hint: 'Check and create your workspace' },
];

type CommandResult = { ok: boolean; message: string; workspace?: Workspace };

/**
 * First-run setup for a company. Each step is saved as it is completed so a closed tab resumes
 * where it stopped. Finishing provisions the chosen modules and unlocks the workspace.
 */
export function SetupWizard({ workspace, actor, memberships, onWorkspace, command }: {
  workspace: Workspace;
  actor: Actor;
  memberships: { tenantId: string; name: string }[];
  onWorkspace: (next: Workspace) => void;
  command: (type: string, payload: Record<string, unknown>) => Promise<CommandResult>;
}) {
  const [step, setStep] = useState<Step>(workspace.setup.step);
  // The signed-in email is the natural default for the company's contact email.
  const [company, setCompany] = useState<CompanyDraft>({ name: workspace.company.name, address: workspace.company.address, phone: workspace.company.phone, email: workspace.company.email || actor.email || '', taxId: workspace.company.taxId });
  const [branding, setBranding] = useState<BrandingDraft>({ accent: workspace.branding.accent, footer: workspace.branding.footer });
  const [modules, setModules] = useState<ToggleModule[]>(workspace.modules.length ? workspace.modules : withRequirements(presets[0].modules));
  const [busy, setBusy] = useState(false);
  // Buttons stay disabled until React has hydrated, so a click on the server-rendered page is never lost.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [error, setError] = useState('');
  const companyForm = useRef<HTMLFormElement>(null);

  async function run(type: string, payload: Record<string, unknown>) {
    const result = await command(type, payload);
    if (!result.ok) throw new Error(result.message);
    return result;
  }
  async function next() {
    setBusy(true); setError('');
    try {
      if (step === 1) { const draft = companyForm.current ? readCompanyForm(companyForm.current) : company; setCompany(draft); if (draft.name.length < 2 || !draft.address) throw new Error('Enter the company name and address.'); await run('save_company', draft); }
      if (step === 2) await run('save_branding', { ...workspace.branding, ...branding });
      if (step === 3) { if (!modules.length) throw new Error('Turn on at least one feature.'); await run('set_modules', { enabled: modules }); }
      const target = Math.min(4, step + 1) as Step;
      await run('save_setup_step', { step: target });
      setStep(target);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save this step.'); }
    finally { setBusy(false); }
  }
  async function finish() {
    setBusy(true); setError('');
    try { await run('complete_setup', {}); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not finish setup.'); setBusy(false); }
  }
  const labelOf = (key: ToggleModule) => moduleCatalogue.find(item => item.key === key)!.label;

  return <main className="wizard-shell">
    <aside className="wizard-side">
      <div className="login-brand"><span className="brand-mark">S</span><span>Sahulat<strong>ERP</strong></span></div>
      <ol className="wizard-steps">{steps.map(item => <li key={item.step} className={item.step === step ? 'current' : item.step < step ? 'done' : ''} aria-current={item.step === step ? 'step' : undefined}><span className="wizard-step-index">{item.step < step ? <Check size={14}/> : item.step}</span><div><strong>{item.title}</strong><small>{item.hint}</small></div></li>)}</ol>
      <div className="wizard-side-note"><p>Setting up <strong>{workspace.company.name}</strong> as {actor.name}. Everything here can be changed later in Settings.</p>{memberships.filter(m => m.tenantId !== workspace.tenantId).map(m => <a key={m.tenantId} href={`/?tenant=${encodeURIComponent(m.tenantId)}`}>Switch to {m.name}</a>)}<form action="/auth/signout" method="post"><button type="submit" className="text-button">Sign out</button></form></div>
    </aside>
    <section className="wizard-main">
      <header className="wizard-heading"><span className="eyebrow">STEP {step} OF 4</span><h1>{steps[step - 1].title}</h1><p>{steps[step - 1].hint}</p></header>
      {step === 1 && <form ref={companyForm} onSubmit={event => { event.preventDefault(); next(); }}><CompanyForm value={company} onChange={setCompany} disabled={busy}/></form>}
      {step === 2 && <BrandingForm workspace={workspace} company={company} value={branding} onChange={setBranding} onWorkspace={onWorkspace} disabled={busy}/>}
      {step === 3 && <ModulePicker selected={modules} onChange={setModules} disabled={busy}/>}
      {step === 4 && <div className="wizard-review">
        <section className="card"><div className="card-heading"><div><h2>Company</h2><p>Shown on every document</p></div><Button variant="ghost" onClick={() => setStep(1)}>Edit</Button></div><dl className="review-list"><div><dt>Name</dt><dd>{company.name}</dd></div><div><dt>Address</dt><dd>{company.address}</dd></div>{company.phone && <div><dt>Phone</dt><dd>{company.phone}</dd></div>}{company.email && <div><dt>Email</dt><dd>{company.email}</dd></div>}{company.taxId && <div><dt>NTN / STRN</dt><dd>{company.taxId}</dd></div>}</dl></section>
        <section className="card"><div className="card-heading"><div><h2>Documents</h2><p>Standard template</p></div><Button variant="ghost" onClick={() => setStep(2)}>Edit</Button></div><dl className="review-list"><div><dt>Logo</dt><dd>{workspace.branding.logoPath ? 'Uploaded' : 'Company initial'}</dd></div><div><dt>Letterhead</dt><dd>{workspace.branding.letterheadPath ? 'Uploaded' : 'None'}</dd></div><div><dt>Accent</dt><dd><span className="swatch tiny" style={{ background: branding.accent }}/> {branding.accent}</dd></div><div><dt>Footer</dt><dd>{branding.footer || '—'}</dd></div></dl></section>
        <section className="card"><div className="card-heading"><div><h2>Features</h2><p>{modules.length} turned on</p></div><Button variant="ghost" onClick={() => setStep(3)}>Edit</Button></div><ul className="review-modules">{modules.map(key => <li key={key}><Check size={14}/>{labelOf(key)}</li>)}</ul></section>
      </div>}
      {error && <p className="error-note" role="alert">{error}</p>}
      <footer className="wizard-actions">
        {step > 1 ? <Button variant="outline" disabled={busy} onClick={() => setStep((step - 1) as Step)}><ArrowLeft size={16}/>Back</Button> : <span/>}
        {step < 4
          ? <Button disabled={busy || !ready} onClick={next}>{busy ? <Loader2 className="spin" size={16}/> : null}Continue<ArrowRight size={16}/></Button>
          : <Button disabled={busy || !ready} onClick={finish}>{busy ? <Loader2 className="spin" size={16}/> : <Sparkles size={16}/>}Create my workspace</Button>}
      </footer>
    </section>
  </main>;
}
