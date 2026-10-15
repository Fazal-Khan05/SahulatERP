import { describe, expect, it } from 'vitest';
import { canRun, execute } from '../../src/modules/erp/engine';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { roles, type Actor, type Role, type Workspace } from '../../src/modules/erp/types';

let n = 0;
const as = (role: Role, extra: Partial<Actor> = {}): Actor => ({ id: `user-${role.toLowerCase().replace(/\s+/g, '-')}`, name: `Fixes ${role}`, role, branchIds: [], ...extra });
const owner = as('Owner');
const run = (w: Workspace, type: string, payload: Record<string, unknown> = {}, actor: Actor = owner, idempotencyKey = `fixes-b-${++n}`) => execute(w, { type, payload, idempotencyKey }, actor);
const company = { name: 'Fixes Trading', address: '1 Test Road, Karachi' };
function completed(): Workspace {
  let w = { ...blankWorkspace(false), tenantId: 'fixes-b-tenant' };
  w = run(w, 'save_company', company).workspace;
  w = run(w, 'set_modules', { enabled: ['sales', 'purchasing', 'inventory', 'collections', 'cashbank', 'commissions', 'payroll', 'reports'] }).workspace;
  return run(w, 'complete_setup').workspace;
}

describe('D-08 company, branding and modules are Owner/Accountant only after setup', () => {
  const settings: [string, Record<string, unknown>][] = [
    ['save_company', company],
    ['save_branding', { accent: '#123456', footer: '' }],
    ['set_modules', { enabled: ['sales', 'reports'] }],
  ];
  it('during setup every member except the Auditor may run the wizard commands', () => {
    const w = { ...blankWorkspace(false), tenantId: 'fixes-b-tenant' };
    for (const role of roles) for (const [type, payload] of settings) {
      if (role === 'Auditor') expect(() => run(w, type, payload, as(role)), `${role} ${type}`).toThrow('Your role does not permit this action.');
      else expect(() => run(w, type, payload, as(role)), `${role} ${type}`).not.toThrow();
    }
  });
  it('after setup only Owner and Accountant may run them', () => {
    const w = completed();
    for (const role of roles) for (const [type, payload] of settings) {
      if (role === 'Owner' || role === 'Accountant') expect(() => run(w, type, payload, as(role)), `${role} ${type}`).not.toThrow();
      else expect(() => run(w, type, payload, as(role)), `${role} ${type}`).toThrow('Your role does not permit this action.');
    }
  });
  it('canRun reports the post-setup rule without a workspace and the setup rule with an open wizard', () => {
    expect(canRun('Salesperson', 'save_company')).toBe(false);
    expect(canRun('Salesperson', 'save_company', { setup: { complete: false, step: 1 } })).toBe(true);
    expect(canRun('Salesperson', 'save_company', { setup: { complete: true, step: 4 } })).toBe(false);
    expect(canRun('Auditor', 'save_company', { setup: { complete: false, step: 1 } })).toBe(false);
    expect(canRun('Accountant', 'set_modules')).toBe(true);
  });
});
