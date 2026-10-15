import { describe, expect, it } from 'vitest';
import { decodeWorkspace } from '../../src/modules/erp/codec';
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

describe('D-19 branding paths are exactly <tenant>/<logo|letterhead>.<png|jpg|jpeg>', () => {
  const brand = (extra: Record<string, unknown>) => ({ accent: '#123456', footer: '', ...extra });
  it('accepts the stored names for each kind, and empty paths', () => {
    const w = completed(); const t = w.tenantId;
    for (const ext of ['png', 'jpg', 'jpeg']) {
      const r = run(w, 'save_branding', brand({ logoPath: `${t}/logo.${ext}`, letterheadPath: `${t}/letterhead.${ext}` })).workspace.branding;
      expect([r.logoPath, r.letterheadPath]).toEqual([`${t}/logo.${ext}`, `${t}/letterhead.${ext}`]);
    }
    const cleared = run(w, 'save_branding', brand({ logoPath: '', letterheadPath: '' })).workspace.branding;
    expect(cleared).toEqual({ template: 'standard', accent: '#123456', footer: '' });
  });
  it('refuses traversal, other folders, other names, other extensions and swapped kinds', () => {
    const w = completed(); const t = w.tenantId;
    const bad = [`${t}/../other/logo.png`, `${t}/..%2Fother/logo.png`, `other/logo.png`, `${t}/sub/logo.png`, `${t}/logo.svg`, `${t}/logo.png.exe`, `${t}/evil.png`, `${t}/letterhead.png`, `/${t}/logo.png`, `${t}//logo.png`, `${t}/LOGO.PNG`, ` ${t}/logo.png`];
    for (const logoPath of bad) expect(() => run(w, 'save_branding', brand({ logoPath })), logoPath).toThrow('Branding files must belong to this company.');
    expect(() => run(w, 'save_branding', brand({ letterheadPath: `${t}/logo.png` }))).toThrow('Branding files must belong to this company.');
    expect(() => run(w, 'save_branding', brand({ letterheadPath: `${t}/../x/letterhead.jpg` }))).toThrow('Branding files must belong to this company.');
  });
});

describe('D-17 a replayed command returns its original result', () => {
  const party = (name: string) => ({ name, type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 0, customerClass: '' });
  it('stores recordId and message with the key and returns them on replay, unchanged workspace', () => {
    const w = completed();
    const first = run(w, 'save_party', party('Replay Customer'), owner, 'fixes-b-replay-1');
    expect(first.workspace.operations.at(-1)).toEqual({ key: 'fixes-b-replay-1', recordId: first.recordId, message: 'Replay Customer saved.' });
    const again = run(first.workspace, 'save_party', party('Other Name'), owner, 'fixes-b-replay-1');
    expect(again).toEqual({ workspace: first.workspace, recordId: first.recordId, message: 'Replay Customer saved.' });
    expect(again.workspace).toBe(first.workspace);
  });
  it('old snapshots with plain-string operations load and replay without re-running the command', () => {
    const w = completed();
    const legacy = JSON.parse(JSON.stringify({ ...w, operations: ['old-key-0001', 'old-key-0002'] }));
    const decoded = decodeWorkspace(JSON.stringify(legacy));
    expect(decoded.operations).toEqual([
      { key: 'old-key-0001', recordId: '', message: 'This operation was already completed.' },
      { key: 'old-key-0002', recordId: '', message: 'This operation was already completed.' },
    ]);
    const replay = run(decoded, 'save_party', party('Never Saved'), owner, 'old-key-0002');
    expect(replay).toEqual({ workspace: decoded, recordId: '', message: 'This operation was already completed.' });
    const next = run(decoded, 'save_branding', { accent: '#222222', footer: '' }, owner, 'new-key-0001').workspace;
    expect(next.operations.map(o => o.key)).toEqual(['old-key-0001', 'old-key-0002', 'new-key-0001']);
    expect(decodeWorkspace({ ...legacy, operations: undefined }).operations).toEqual([]);
  });
  it('a replay is not audited again', () => {
    const w = completed();
    const first = run(w, 'save_branding', { accent: '#111111', footer: '' }, owner, 'fixes-b-replay-audit');
    expect(run(first.workspace, 'save_branding', { accent: '#111111', footer: '' }, owner, 'fixes-b-replay-audit').workspace.audit).toHaveLength(first.workspace.audit.length);
  });
  it('keeps only the most recent 500 operations and never mutates the input history', () => {
    let w = completed();
    for (let i = 0; i < 520; i++) w = run(w, 'save_branding', { accent: '#123456', footer: `f${i}` }, owner, `cap-key-${String(i).padStart(4, '0')}`).workspace;
    expect(w.operations).toHaveLength(500);
    expect(w.operations.at(-1)!.key).toBe('cap-key-0519');
    expect(w.operations[0].key).toBe('cap-key-0020');
    const before = JSON.stringify(w.operations);
    run(w, 'save_branding', { accent: '#654321', footer: '' }, owner, 'cap-key-next');
    expect(JSON.stringify(w.operations)).toBe(before);
  });
});

describe('D-21 audit stores the stable user id, with the display name for showing', () => {
  it('records actor = user id and actorName = display name; renaming the member does not change the id', () => {
    let w = completed();
    w = run(w, 'save_branding', { accent: '#123456', footer: '' }, as('Accountant', { id: 'user-42', name: 'Ayesha' })).workspace;
    w = run(w, 'save_branding', { accent: '#123457', footer: '' }, as('Accountant', { id: 'user-42', name: 'Ayesha Khan' })).workspace;
    expect(w.audit.slice(-2).map(a => [a.actor, a.actorName, a.role])).toEqual([['user-42', 'Ayesha', 'Accountant'], ['user-42', 'Ayesha Khan', 'Accountant']]);
  });
  it('older entries (display name in actor) decode with actorName filled in', () => {
    const w = completed();
    const legacy = { ...w, audit: [{ id: 'a1', date: '2026-10-01T00:00:00.000Z', actor: 'Old Name', role: 'Owner', action: 'save_company', sourceId: w.tenantId, detail: 'Company details saved.' }] };
    expect(decodeWorkspace(JSON.stringify(legacy)).audit).toEqual([{ ...legacy.audit[0], actorName: 'Old Name' }]);
    const current = run(w, 'save_branding', { accent: '#123456', footer: '' }).workspace;
    expect(decodeWorkspace(JSON.stringify(current)).audit).toEqual(current.audit);
  });
});
