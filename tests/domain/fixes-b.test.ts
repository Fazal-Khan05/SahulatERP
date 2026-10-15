import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
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

describe('D-10 cancel_payroll releases a stale draft so the month can be created again', () => {
  const settings = { taxRate: '', employerEobi: '5', employeeEobi: '1', eobiBase: '32000', incomeTaxRate: '5', numbering: 'FB', approvalLimit: '0' };
  const month = '2026-10';
  /** Payroll-ready company: one salesperson with a released, approved commission (cash receipt). */
  function payrollReady(tenantId = 'fixes-b-tenant') {
    let w = { ...completed(), tenantId };
    w = run(w, 'save_settings', settings).workspace;
    const emp = run(w, 'save_employee', { name: 'Rep One', role: 'Rep', territory: 'K', salary: '50000', allowance: '0', deduction: '0', attendance: 30, active: true }); w = emp.workspace;
    w = run(w, 'save_plan', { ...w.plans[0], rate: '2' }).workspace;
    const item = run(w, 'save_item', { sku: 'PAY-1', name: 'Payroll item', category: 'General', hsCode: '', unit: 'pcs', price: '100', cost: '10', weight: '1', volume: '1', reorderLevel: 0 }); w = item.workspace;
    w = run(w, 'bulk_stock_increase', { warehouseId: w.warehouses[0].id, date: '2026-10-01', purpose: 'opening_stock', reason: 'Opening', lines: [{ itemId: item.recordId, quantity: '100', cost: '10' }] }).workspace;
    const cust = run(w, 'save_party', { name: 'Pay Customer', type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 0, customerClass: 'Retailer' }); w = cust.workspace;
    const inv = run(w, 'create_document', { kind: 'sales_invoice', partyId: cust.recordId, warehouseId: w.warehouses[0].id, date: '2026-10-02', dueDate: '2026-10-02', lines: [{ itemId: item.recordId, quantity: '10', price: '100', discount: '0', taxRate: '0', employeeId: emp.recordId, splits: [] }] }); w = inv.workspace;
    w = run(w, 'submit_document', { id: inv.recordId }).workspace;
    w = run(w, 'create_receipt', { partyId: cust.recordId, date: '2026-10-03', amount: '1000', method: 'cash', dueDate: '2026-10-03', allocations: [{ invoiceId: inv.recordId, amount: '1000' }], accountId: 'cash' }).workspace;
    const commission = w.commissions[0].id;
    w = run(w, 'approve_commission', { ids: [commission] }).workspace;
    return { w, emp: emp.recordId, commission };
  }

  it('a draft or reviewed run can be cancelled; its commission is free for the recreated run, which keeps the same id', () => {
    for (const reviewed of [false, true]) {
      let { w, emp, commission } = payrollReady();
      const first = run(w, 'create_payroll', { month, date: '2026-10-28' }); w = first.workspace;
      if (reviewed) w = run(w, 'update_payroll', { id: first.recordId, status: 'reviewed' }).workspace;
      expect(() => run(w, 'create_payroll', { month })).toThrow('A payroll run already exists for this month.');
      const cancel = run(w, 'cancel_payroll', { id: first.recordId }); w = cancel.workspace;
      expect(cancel.message).toBe(`PAY-${month} cancelled. Its commissions are released; create payroll for ${month} again to recalculate.`);
      expect(w.payrolls.map(p => p.status)).toEqual(['cancelled']);
      expect(w.journals.filter(j => j.sourceId.startsWith(first.recordId))).toEqual([]);
      // Released in another month's run too, not only in a recreated one.
      expect(run(w, 'create_payroll', { month: '2026-11' }).workspace.payrolls[1].lines.find(l => l.employeeId === emp)!.commissionIds).toEqual([commission]);
      const again = run(w, 'create_payroll', { month, date: '2026-10-28' }); w = again.workspace;
      expect(again.recordId).toBe(first.recordId);
      expect(w.payrolls).toHaveLength(1);
      expect(w.payrolls[0]).toMatchObject({ id: first.recordId, number: `PAY-${month}`, status: 'draft' });
      expect(w.payrolls[0].lines[0].commissionIds).toEqual([commission]);
      for (const status of ['reviewed', 'approved', 'paid']) w = run(w, 'update_payroll', { id: again.recordId, status }).workspace;
      expect(w.commissions[0].paid).toBe(w.commissions[0].released);
    }
  });

  it('approved, paid and already-cancelled runs are refused; a cancelled run cannot move on', () => {
    let { w } = payrollReady();
    const created = run(w, 'create_payroll', { month }); w = created.workspace; const id = created.recordId;
    const cancelled = run(w, 'cancel_payroll', { id }).workspace;
    expect(() => run(cancelled, 'cancel_payroll', { id })).toThrow('Only draft or reviewed payroll runs can be cancelled.');
    expect(() => run(cancelled, 'update_payroll', { id, status: 'reviewed' })).toThrow('Invalid payroll transition.');
    w = run(w, 'update_payroll', { id, status: 'reviewed' }).workspace;
    w = run(w, 'update_payroll', { id, status: 'approved' }).workspace;
    expect(() => run(w, 'cancel_payroll', { id })).toThrow('Only draft or reviewed payroll runs can be cancelled.');
    w = run(w, 'update_payroll', { id, status: 'paid' }).workspace;
    expect(() => run(w, 'cancel_payroll', { id })).toThrow('Only draft or reviewed payroll runs can be cancelled.');
    expect(() => run(w, 'cancel_payroll', { id: 'missing' })).toThrow('Payroll not found.');
  });

  it('has the same roles as update_payroll, is gated by the Payroll module and respects a locked period', () => {
    let { w } = payrollReady();
    const created = run(w, 'create_payroll', { month }); w = created.workspace; const id = created.recordId;
    for (const role of roles) {
      const allowed = canRun(role, 'update_payroll');
      expect(canRun(role, 'cancel_payroll'), role).toBe(allowed);
      if (allowed) expect(() => run(w, 'cancel_payroll', { id }, as(role)), role).not.toThrow();
      else expect(() => run(w, 'cancel_payroll', { id }, as(role)), role).toThrow('Your role does not permit this action.');
    }
    const off = run(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'payroll') }).workspace;
    expect(() => run(off, 'cancel_payroll', { id })).toThrow('Payroll is turned off for this company.');
    const locked = run(w, 'set_period', { month, locked: true }).workspace;
    expect(() => run(locked, 'cancel_payroll', { id })).toThrow(`Accounting period ${month} is locked.`);
  });

  it('commits through the real database projection: one run per month after cancel and recreate, audit keeps user ids', async () => {
    const TENANT = '55555555-5555-4555-8555-555555555555';
    const db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to authenticated;
      create table public.schema_migrations (filename text primary key);
      create schema storage;
      create table storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null, owner uuid);
      alter table storage.objects enable row level security;
      create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
      grant usage on schema storage to authenticated; grant select on storage.objects to authenticated;
    `);
    const dir = resolve(__dirname, '../../supabase/migrations');
    for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) await db.exec(readFileSync(resolve(dir, file), 'utf8'));
    let { w } = payrollReady(TENANT);
    await db.query(`insert into public.tenants (id, name) values ($1, 'Fixes B')`, [TENANT]);
    await db.query('insert into public.workspace_snapshots (tenant_id, revision, data) values ($1, $2, $3::jsonb)', [TENANT, w.revision, JSON.stringify(w)]);
    const commit = async (next: Workspace) => {
      const [{ revision }] = (await db.query<{ revision: number | null }>('select public.commit_workspace($1, $2, $3::jsonb) as revision', [TENANT, next.revision - 1, JSON.stringify(next)])).rows;
      expect(revision).toBe(next.revision);
      return next;
    };
    const payAdmin = as('Payroll Administrator', { id: '00000000-0000-4000-8000-0000000000aa', name: 'Pay Admin' });
    const created = run(w, 'create_payroll', { month }, payAdmin); w = await commit(created.workspace);
    w = await commit(run(w, 'cancel_payroll', { id: created.recordId }, payAdmin).workspace);
    expect((await db.query('select status from public.payroll_runs where tenant_id = $1', [TENANT])).rows).toEqual([{ status: 'cancelled' }]);
    w = await commit(run(w, 'create_payroll', { month }, payAdmin).workspace);
    w = await commit(run(w, 'update_payroll', { id: created.recordId, status: 'reviewed' }, payAdmin).workspace);
    expect((await db.query('select id, payroll_month, status from public.payroll_runs where tenant_id = $1', [TENANT])).rows).toEqual([{ id: created.recordId, payroll_month: month, status: 'reviewed' }]);
    const actors = (await db.query<{ actor: string }>(`select actor from public.audit_events where tenant_id = $1 and action in ('create_payroll', 'cancel_payroll', 'update_payroll')`, [TENANT])).rows.map(r => r.actor);
    expect(actors).toEqual([payAdmin.id, payAdmin.id, payAdmin.id, payAdmin.id]);
    await db.close();
  }, 60_000);
});
