import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { execute } from '../../src/modules/erp/engine';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { DEMO_TENANT, PARTNER_TENANT, type Actor, type Workspace } from '../../src/modules/erp/types';

const owner: Actor = { id: 'db-owner', name: 'DB Owner', role: 'Owner', branchIds: [] };
const OWNER = '00000000-0000-4000-8000-000000000001';
const SALES = '00000000-0000-4000-8000-000000000002';
const OUTSIDER = '00000000-0000-4000-8000-000000000003';
let db: PGlite;

// Stand-ins for what Supabase provides: auth schema, auth.uid() and the API roles.
const supabaseStubs = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated;
  create table public.schema_migrations (filename text primary key);
`;

const commit = (tenant: string, expected: number, workspace: Workspace, rebuild = false) =>
  db.query<{ revision: number | null }>('select public.commit_workspace($1, $2, $3::jsonb, $4) as revision', [tenant, expected, JSON.stringify(workspace), rebuild]);
const count = async (table: string, tenant = DEMO_TENANT) => (await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where tenant_id = $1`, [tenant])).rows[0].n;

async function asUser(userId: string, sql: string) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`);
  try { return (await db.query(sql)).rows; } finally { await db.exec('reset role;'); }
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(supabaseStubs);
  const dir = resolve(__dirname, '../../supabase/migrations');
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  const latest = files.pop()!;
  for (const file of files) await db.exec(readFileSync(resolve(dir, file), 'utf8'));
  // Reproduce the hosted state before the latest migration: a stale-free demo snapshot with no projection,
  // and a partner snapshot stored as a double-encoded JSON string by an earlier seed.
  const demo = buildDemoWorkspace();
  await db.query(`insert into auth.users (id) values ($1), ($2), ($3)`, [OWNER, SALES, OUTSIDER]);
  await db.query(`insert into public.tenants (id, name, is_demo) values ($1, 'Demo', true), ($2, 'Partner', false)`, [DEMO_TENANT, PARTNER_TENANT]);
  await db.query(`insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'Owner'), ($1, $3, 'Salesperson'), ($4, $5, 'Owner')`, [DEMO_TENANT, OWNER, SALES, PARTNER_TENANT, OUTSIDER]);
  await db.query(`insert into public.workspace_snapshots (tenant_id, revision, data) values ($1, $2, $3::jsonb), ($4, 0, to_jsonb($5::text))`, [DEMO_TENANT, demo.revision, JSON.stringify(demo), PARTNER_TENANT, JSON.stringify(blankWorkspace(false))]);
  await db.exec(readFileSync(resolve(dir, latest), 'utf8'));
  await db.query(`update public.memberships set employee_id = 'e-4' where user_id = $1`, [SALES]);
}, 60_000);

describe('transactional workspace commits', () => {
  it('normalises string-encoded snapshots and builds their projection', async () => {
    const [{ kind }] = (await db.query<{ kind: string }>(`select jsonb_typeof(data) as kind from public.workspace_snapshots where tenant_id = $1`, [PARTNER_TENANT])).rows;
    expect(kind).toBe('object');
    expect(await count('companies', PARTNER_TENANT)).toBe(1);
    expect(await count('warehouses', PARTNER_TENANT)).toBe(3);
  });

  it('projects the snapshot exactly into relational tables', async () => {
    const demo = buildDemoWorkspace();
    expect(await count('documents')).toBe(demo.documents.length);
    expect(await count('journals')).toBe(demo.journals.length);
    expect(await count('stock_movements')).toBe(demo.stockMoves.length);
    expect(await count('audit_events')).toBe(demo.audit.length);
    const [{ difference }] = (await db.query<{ difference: string }>(`select coalesce(sum(debit - credit), 0)::text as difference from public.journal_lines where tenant_id = $1`, [DEMO_TENANT])).rows;
    expect(Number(difference)).toBe(0);
  });

  it('commits a command to snapshot and projection together', async () => {
    const [{ data, revision }] = (await db.query<{ data: Workspace; revision: number }>('select data, revision from public.workspace_snapshots where tenant_id = $1', [DEMO_TENANT])).rows;
    const result = execute(data, { type: 'create_journal', idempotencyKey: 'db-test-journal', payload: { date: '2026-10-05', memo: 'Owner top-up', lines: [{ account: '1000', debit: '500', credit: '0' }, { account: '3000', debit: '0', credit: '500' }] } }, owner);
    expect((await commit(DEMO_TENANT, revision, result.workspace)).rows[0].revision).toBe(revision + 1);
    expect(await count('journals')).toBe(result.workspace.journals.length);
    expect(await count('audit_events')).toBe(result.workspace.audit.length);
    // A second writer still holding the old revision is refused without changing anything.
    expect((await commit(DEMO_TENANT, revision, result.workspace)).rows[0].revision).toBeNull();
  });

  it('rolls back the snapshot when a journal does not balance', async () => {
    const [{ data, revision }] = (await db.query<{ data: Workspace; revision: number }>('select data, revision from public.workspace_snapshots where tenant_id = $1', [DEMO_TENANT])).rows;
    const broken = structuredClone(data);
    broken.revision = revision + 1;
    broken.journals.push({ id: 'unbalanced', number: 'JV-99999', sourceId: 'unbalanced', date: '2026-10-05', memo: 'bad', status: 'posted', lines: [{ account: '1000', debit: '10.0000', credit: '0.0000' }, { account: '3000', debit: '0.0000', credit: '9.0000' }] });
    await expect(db.transaction(tx => tx.query('select public.commit_workspace($1, $2, $3::jsonb)', [DEMO_TENANT, revision, JSON.stringify(broken)]))).rejects.toThrow(/not balanced/);
    const [{ current }] = (await db.query<{ current: number }>('select revision as current from public.workspace_snapshots where tenant_id = $1', [DEMO_TENANT])).rows;
    expect(current).toBe(revision);
    expect((await db.query(`select 1 from public.journals where tenant_id = $1 and id = 'unbalanced'`, [DEMO_TENANT])).rows).toHaveLength(0);
  });

  it('refuses to alter a posted journal or reuse its source', async () => {
    const [{ data, revision }] = (await db.query<{ data: Workspace; revision: number }>('select data, revision from public.workspace_snapshots where tenant_id = $1', [DEMO_TENANT])).rows;
    const altered = structuredClone(data);
    altered.revision = revision + 1;
    altered.journals[0].memo = 'rewritten history';
    await expect(commit(DEMO_TENANT, revision, altered)).rejects.toThrow(/immutable/);
    const duplicate = structuredClone(data);
    duplicate.revision = revision + 1;
    duplicate.journals.push({ ...structuredClone(data.journals[1]), id: 'dup', number: 'JV-88888' });
    await expect(commit(DEMO_TENANT, revision, duplicate)).rejects.toThrow(/source_id|duplicate|unique/i);
  });

  it('only rebuilds demo tenants and is not callable by members', async () => {
    const partner = blankWorkspace(false);
    await expect(commit(PARTNER_TENANT, 0, { ...partner, revision: 1 }, true)).rejects.toThrow(/Only demo/);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER}', false);`);
    try { await expect(db.query(`select public.commit_workspace('${DEMO_TENANT}', 0, '{}'::jsonb)`)).rejects.toThrow(/permission denied/); }
    finally { await db.exec('reset role;'); }
  });
});

describe('row-level security', () => {
  it('lets a member read only their own membership, and the owner read all', async () => {
    expect(await asUser(SALES, 'select user_id from public.memberships')).toEqual([{ user_id: SALES }]);
    expect((await asUser(OWNER, `select user_id from public.memberships where tenant_id = '${DEMO_TENANT}'`)).length).toBe(2);
  });

  it('hides snapshots, journals, salaries and payroll from a salesperson', async () => {
    for (const table of ['workspace_snapshots', 'journals', 'journal_lines', 'employees', 'payroll_runs', 'audit_events', 'commissions']) {
      expect(await asUser(SALES, `select 1 from public.${table}`)).toHaveLength(0);
    }
    expect((await asUser(SALES, 'select 1 from public.documents')).length).toBeGreaterThan(0);
  });

  it('isolates tenants', async () => {
    expect(await asUser(OUTSIDER, `select 1 from public.documents where tenant_id = '${DEMO_TENANT}'`)).toHaveLength(0);
    expect(await asUser(OUTSIDER, `select 1 from public.tenants where id = '${DEMO_TENANT}'`)).toHaveLength(0);
  });
});
