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
 * First-run setup, shown as a centred card over the blurred workspace so the product is visible
 * from the first minute. Each step is saved as it is completed so a closed tab resumes where it
 * stopped. Finishing provisions the chosen modules and reveals the workspace behind the card.
 */
export function SetupWizard({ workspace, actor, memberships, onWorkspace, command, onProvisioning }: {
  workspace: Workspace;
  actor: Actor;
  memberships: { tenantId: string; name: string }[];
  onWorkspace: (next: Workspace) => void;
  command: (type: string, payload: Record<string, unknown>) => Promise<CommandResult>;
  /** Keeps the card mounted while the provisioning screen plays; the parent reveals the workspace when it ends. */
  onProvisioning?: (active: boolean) => void;
}) {
  const [step, setStep] = useState<Step>(workspace.setup.step);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
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
  const card = useRef<HTMLDivElement>(null);
  // Each step starts at the top of the card, which scrolls on short screens.
  useEffect(() => { card.current?.scrollTo({ top: 0 }); }, [step]);

  const labelOf = (key: ToggleModule) => moduleCatalogue.find(item => item.key === key)!.label;
  async function run(type: string, payload: Record<string, unknown>) {
    const result = await command(type, payload);
    if (!result.ok) throw new Error(result.message);
    return result;
  }
  function goTo(target: Step) { setDirection(target > step ? 'forward' : 'back'); setStep(target); }
  // Another session finished setup while this card was open: load the finished workspace so the card closes.
  async function openFinishedWorkspace(error: unknown) {
    if (!(error instanceof Error) || error.message !== 'Setup is already complete.') return false;
    try {
      const response = await fetch(`/api/workspace?tenant=${encodeURIComponent(workspace.tenantId)}`, { cache: 'no-store' });
      const result = await response.json() as { workspace?: Workspace };
      if (!response.ok || !result.workspace?.setup.complete) return false;
      onWorkspace(result.workspace);
      return true;
    } catch { return false; }
  }
  async function next() {
    setBusy(true); setError('');
    try {
      if (step === 1) { const draft = companyForm.current ? readCompanyForm(companyForm.current) : company; setCompany(draft); if (draft.name.length < 2 || !draft.address) throw new Error('Enter the company name and address.'); await run('save_company', draft); }
      if (step === 2) await run('save_branding', { ...workspace.branding, ...branding });
      if (step === 3) { if (!modules.length) throw new Error('Turn on at least one feature.'); await run('set_modules', { enabled: modules }); }
      const target = Math.min(4, step + 1) as Step;
      await run('save_setup_step', { step: target });
      goTo(target);
    } catch (e) { if (!await openFinishedWorkspace(e)) setError(e instanceof Error ? e.message : 'Could not save this step.'); }
    finally { setBusy(false); }
  }
  const [finishing, setFinishing] = useState(false);
  async function finish() {
    setBusy(true); setError(''); setFinishing(true); onProvisioning?.(true);
    // The provisioning screen stays up long enough to read even when the server answers instantly.
    const pause = new Promise(resolve => setTimeout(resolve, 2600));
    try { await Promise.all([run('complete_setup', {}), pause]); onProvisioning?.(false); }
    catch (e) {
      if (await openFinishedWorkspace(e)) { onProvisioning?.(false); return; }
      setError(e instanceof Error ? e.message : 'Could not finish setup.'); setBusy(false); setFinishing(false); onProvisioning?.(false);
    }
  }
  const provisionLines = [...modules.map(key => `Setting up ${labelOf(key)}`), 'Opening your books', 'Preparing your workspace'];
  const others = memberships.filter(m => m.tenantId !== workspace.tenantId);

  return <div className="setup-layer" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <div className="setup-card" ref={card}>
      <div className="setup-progress" aria-hidden="true"><span style={{ width: `${(step / 4) * 100}%` }}/></div>
      <header className="setup-head">
        <div className="login-brand"><span className="brand-mark">S</span><span>Sahulat<strong>ERP</strong></span></div>
        <ol className="setup-steps">{steps.map(item => <li key={item.step} className={item.step === step ? 'current' : item.step < step ? 'done' : ''} aria-current={item.step === step ? 'step' : undefined}><span className="setup-step-index">{item.step < step ? <Check size={12}/> : item.step}</span><span className="setup-step-title">{item.title}</span></li>)}</ol>
      </header>
      {finishing ? <div className="setup-provisioning" role="status" aria-live="polite">
        <span className="provision-ring" aria-hidden="true"/>
        <h1 id="setup-title">Setting up {company.name || workspace.company.name}</h1>
        <p>Creating your lists, number series and accounts. This takes a few seconds.</p>
        <ul className="provision-lines">{provisionLines.map((line, index) => <li key={line} style={{ '--i': index } as React.CSSProperties}><span className="provision-check"><Check size={12}/></span>{line}</li>)}</ul>
      </div> : <div key={step} className={`setup-body step-${direction}`}>
        <div className="wizard-heading"><h1 id="setup-title">{steps[step - 1].title}</h1><p>Step {step} of 4. {steps[step - 1].hint}</p></div>
        {step === 1 && <form ref={companyForm} onSubmit={event => { event.preventDefault(); next(); }}><CompanyForm value={company} onChange={setCompany} disabled={busy}/></form>}
        {step === 2 && <BrandingForm workspace={workspace} company={company} value={branding} onChange={setBranding} onWorkspace={onWorkspace} disabled={busy}/>}
        {step === 3 && <ModulePicker selected={modules} onChange={setModules} disabled={busy}/>}
        {step === 4 && <div className="wizard-review">
          <section className="card"><div className="card-heading"><div><h2>Company</h2><p>Shown on every document</p></div><Button variant="ghost" onClick={() => goTo(1)}>Edit</Button></div><dl className="review-list"><div><dt>Name</dt><dd>{company.name}</dd></div><div><dt>Address</dt><dd>{company.address}</dd></div>{company.phone && <div><dt>Phone</dt><dd>{company.phone}</dd></div>}{company.email && <div><dt>Email</dt><dd>{company.email}</dd></div>}{company.taxId && <div><dt>NTN / STRN</dt><dd>{company.taxId}</dd></div>}</dl></section>
          <section className="card"><div className="card-heading"><div><h2>Documents</h2><p>Standard template</p></div><Button variant="ghost" onClick={() => goTo(2)}>Edit</Button></div><dl className="review-list"><div><dt>Logo</dt><dd>{workspace.branding.logoPath ? 'Uploaded' : 'Company initial'}</dd></div><div><dt>Letterhead</dt><dd>{workspace.branding.letterheadPath ? 'Uploaded' : 'None'}</dd></div><div><dt>Accent</dt><dd><span className="swatch tiny" style={{ background: branding.accent }}/> {branding.accent}</dd></div><div><dt>Footer</dt><dd>{branding.footer || '—'}</dd></div></dl></section>
          <section className="card"><div className="card-heading"><div><h2>Features</h2><p>{modules.length} turned on</p></div><Button variant="ghost" onClick={() => goTo(3)}>Edit</Button></div><ul className="review-modules">{modules.map(key => <li key={key}><Check size={14}/>{labelOf(key)}</li>)}</ul></section>
        </div>}
        {error && <p className="error-note" role="alert">{error}</p>}
      </div>}
      {!finishing && <footer className="wizard-actions setup-actions">
        {step > 1 ? <Button variant="outline" disabled={busy} onClick={() => goTo((step - 1) as Step)}><ArrowLeft size={16}/>Back</Button> : <span/>}
        {step < 4
          ? <Button disabled={busy || !ready} onClick={next}>{busy ? <Loader2 className="spin" size={16}/> : null}Continue<ArrowRight size={16}/></Button>
          : <Button className="button-gradient" disabled={busy || !ready} onClick={finish}>{busy ? <Loader2 className="spin" size={16}/> : <Sparkles size={16}/>}Create my workspace</Button>}
      </footer>}
    </div>
    <div className="setup-foot">Setting up <strong>{workspace.company.name}</strong> as {actor.name}. Everything here can be changed later in Settings.{others.map(m => <a key={m.tenantId} href={`/?tenant=${encodeURIComponent(m.tenantId)}`}>Switch to {m.name}</a>)}<form action="/auth/signout" method="post"><button type="submit" className="text-button">Sign out</button></form></div>
  </div>;
}
