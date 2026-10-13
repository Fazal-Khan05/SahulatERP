'use client';
import type { Workspace } from '@/modules/erp/types';

// Inputs are uncontrolled (defaultValue) so text typed before React hydrates is not lost;
// callers read the final values with readCompanyForm() on submit and use onChange only for live previews.

export type CompanyDraft = Pick<Workspace['company'], 'name' | 'address' | 'phone' | 'email' | 'taxId'>;

export function readCompanyForm(form: HTMLFormElement): CompanyDraft {
  const data = new FormData(form);
  const v = (key: keyof CompanyDraft) => String(data.get(key) ?? '').trim();
  return { name: v('name'), address: v('address'), phone: v('phone'), email: v('email'), taxId: v('taxId') };
}

export function CompanyForm({ value, onChange, disabled = false }: { value: CompanyDraft; onChange: (next: CompanyDraft) => void; disabled?: boolean }) {
  const set = (key: keyof CompanyDraft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [key]: event.target.value });
  return <div className="field-grid">
    <label className="full-width">Company name<input name="name" defaultValue={value.name} onChange={set('name')} required minLength={2} maxLength={120} disabled={disabled} autoComplete="organization"/></label>
    <label className="full-width">Address<textarea name="address" defaultValue={value.address} onChange={set('address')} rows={2} maxLength={500} required disabled={disabled} autoComplete="street-address" placeholder="Shop / office address as it should appear on invoices"/></label>
    <label>Phone<input name="phone" defaultValue={value.phone} onChange={set('phone')} maxLength={40} disabled={disabled} autoComplete="tel" placeholder="+92 …"/></label>
    <label>Email<input name="email" type="email" defaultValue={value.email} onChange={set('email')} disabled={disabled} autoComplete="email"/></label>
    <label className="full-width">NTN / sales-tax number <span className="field-optional">optional</span><input name="taxId" defaultValue={value.taxId} onChange={set('taxId')} maxLength={100} disabled={disabled}/><small className="field-hint">Printed on documents when filled in.</small></label>
  </div>;
}
