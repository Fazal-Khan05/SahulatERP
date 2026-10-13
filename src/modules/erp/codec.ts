import { toggleModules } from './modules';
import type { Workspace } from './types';

/**
 * Reads a persisted snapshot and fills in fields added after it was written, so older
 * snapshots keep working without a data migration:
 * - followUps (Oct 2026)
 * - company contact, branding, modules and setup (Oct 2026 onboarding). A snapshot that
 *   predates module toggles has every module on and counts as set up when it already has
 *   documents or is the demo; an empty, non-demo one goes through the wizard.
 */
export function decodeWorkspace(value: unknown): Workspace {
  const decoded = typeof value === 'string' ? JSON.parse(value) : value;
  if (!decoded || typeof decoded !== 'object' || !('tenantId' in decoded) || !('company' in decoded)) {
    throw new Error('The persisted workspace is invalid.');
  }
  const raw = decoded as Partial<Workspace> & { company: Partial<Workspace['company']>; fbr?: unknown; bankLines?: unknown };
  const { fbr: _fbr, bankLines: _bankLines, ...rest } = raw;
  const legacy = !Array.isArray(raw.modules);
  const hasData = (raw.documents?.length ?? 0) > 0 || (raw.items?.length ?? 0) > 0 || (raw.parties?.length ?? 0) > 0;
  return {
    ...(rest as Workspace),
    company: { ...raw.company, phone: raw.company.phone ?? '', email: raw.company.email ?? '' } as Workspace['company'],
    branding: raw.branding ?? { template: 'standard', accent: '#087f69', footer: '' },
    modules: legacy ? [...toggleModules] : raw.modules!,
    setup: raw.setup ?? { complete: !!raw.demo || hasData, step: 1 },
    followUps: raw.followUps ?? [],
    bankAccounts: raw.bankAccounts ?? [],
  };
}
