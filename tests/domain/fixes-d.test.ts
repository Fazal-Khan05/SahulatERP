/**
 * Regression tests for the security fixes D-07, D-18, D-20, D-22, D-30, D-32 and D-33 (agent D).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { DEMO_TENANT, PARTNER_TENANT, roles, type Role } from '../../src/modules/erp/types';

type Row = Record<string, unknown>;
const root = resolve(__dirname, '../..');

// ---------- D-07: role-aware reads on the relational projection (PGlite with the real migrations) ----------
const supabaseStubs = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated;
  create table public.schema_migrations (filename text primary key);
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null, owner uuid);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema storage to authenticated;
  grant select on storage.objects to authenticated;
`;
const projection = [
  'companies', 'branches', 'warehouses', 'fiscal_periods', 'workspace_snapshots', 'parties', 'items', 'employees',
  'documents', 'journals', 'journal_lines', 'stock_movements', 'receipts', 'commission_plans', 'commissions',
  'commission_movements', 'shipments', 'payroll_runs', 'follow_ups', 'audit_events',
];
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// One user per role in the demo tenant, plus branch-limited ledger members, an inactive owner and an outsider.
const members: { id: string; role: Role; branchIds?: string[]; active?: boolean; employeeId?: string }[] = [
  ...roles.map((role, i) => ({ id: uid(i + 1), role, ...(role === 'Salesperson' ? { employeeId: 'e-4' } : {}) })),
  { id: uid(20), role: 'Owner', branchIds: ['karachi'] },
  { id: uid(21), role: 'Accountant', branchIds: ['karachi'] },
  { id: uid(22), role: 'Auditor', branchIds: ['lahore'] },
  { id: uid(23), role: 'Owner', active: false },
];
const OUTSIDER = uid(30);
const userOf = (role: Role) => members.find(m => m.role === role && !m.branchIds && m.active !== false)!.id;
const fullLedger = (m: (typeof members)[number]) => ['Owner', 'Accountant', 'Auditor'].includes(m.role) && !m.branchIds && m.active !== false;

let db: PGlite;
async function as(userId: string | null, sql: string, role: 'authenticated' | 'anon' = 'authenticated') {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${userId ?? ''}', false);`);
  try { return (await db.query<Row>(sql)).rows; } finally { await db.exec('reset role;'); }
}
const count = async (table: string, tenant = DEMO_TENANT) => (await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where tenant_id = $1`, [tenant])).rows[0].n;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(supabaseStubs);
  const dir = resolve(root, 'supabase/migrations');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files.filter(x => x < '202610120001')) await db.exec(readFileSync(resolve(dir, f), 'utf8'));
  const { modules: _m, setup: _s, branding: _b, ...demo } = buildDemoWorkspace();
  for (const id of [...members.map(m => m.id), OUTSIDER]) await db.query('insert into auth.users (id) values ($1)', [id]);
  await db.query(`insert into public.tenants (id, name, is_demo) values ($1, 'Demo', true), ($2, 'Partner', false)`, [DEMO_TENANT, PARTNER_TENANT]);
  for (const m of members) await db.query('insert into public.memberships (tenant_id, user_id, role, branch_ids, active) values ($1, $2, $3, $4, $5)', [DEMO_TENANT, m.id, m.role, m.branchIds ?? [], m.active ?? true]);
  await db.query(`insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'Owner')`, [PARTNER_TENANT, OUTSIDER]);
  await db.query(`insert into public.workspace_snapshots (tenant_id, revision, data) values ($1, $2, $3::jsonb), ($4, 0, to_jsonb($5::text))`, [DEMO_TENANT, demo.revision, JSON.stringify(demo), PARTNER_TENANT, JSON.stringify(blankWorkspace(false))]);
  for (const f of files.filter(x => x >= '202610120001')) await db.exec(readFileSync(resolve(dir, f), 'utf8'));
  await db.query(`update public.memberships set employee_id = 'e-4' where user_id = $1`, [userOf('Salesperson')]);
  await db.query(`insert into storage.objects (bucket_id, name) values ('branding', $1), ('branding', $2)`, [`${DEMO_TENANT}/logo.png`, `${PARTNER_TENANT}/logo.png`]);
}, 60_000);

describe('D-07 RLS: only full-ledger members read the projection directly', () => {
  it('Owner, Accountant and Auditor without a branch limit read every projection row of their tenant', async () => {
    for (const m of members.filter(fullLedger)) {
      for (const table of projection) expect((await as(m.id, `select 1 from public.${table}`)).length, `${m.role} ${table}`).toBe(await count(table));
    }
    expect(await count('documents')).toBeGreaterThan(0);
  });

  it('every other role, branch-limited and inactive members read no projection rows directly', async () => {
    for (const m of members.filter(x => !fullLedger(x))) {
      for (const table of projection) expect(await as(m.id, `select 1 from public.${table}`), `${m.role} ${m.branchIds ?? ''} ${table}`).toEqual([]);
    }
  });

  it("a salesperson cannot read purchase documents or other salespeople's sales directly, but the API still serves their own", async () => {
    const sales = userOf('Salesperson');
    expect(await as(sales, `select id from public.documents where kind in ('purchase_order', 'goods_receipt', 'supplier_invoice')`)).toEqual([]);
    expect(await as(sales, `select id from public.documents where not (data -> 'lines') @> '[{"employeeId":"e-4"}]'`)).toEqual([]);
    expect(await as(sales, `select id from public.commissions where employee_id <> 'e-4'`)).toEqual([]);
    const view = scopeWorkspace(buildDemoWorkspace(), { id: sales, name: 'Sales', role: 'Salesperson', branchIds: [], employeeId: 'e-4' });
    expect(view.documents.length).toBeGreaterThan(0);
  });

  it('every member still reads their own membership and tenant (the page picks the company with them)', async () => {
    for (const m of members.filter(x => x.active !== false)) {
      expect(await as(m.id, `select user_id from public.memberships where user_id = '${m.id}'`), m.role).toEqual([{ user_id: m.id }]);
      expect(await as(m.id, 'select id from public.tenants'), m.role).toEqual([{ id: DEMO_TENANT }]);
    }
    expect((await as(userOf('Owner'), `select user_id from public.memberships where tenant_id = '${DEMO_TENANT}'`)).length).toBe(members.length);
    // Logos are shown to every role, so branding files stay readable by any member of the tenant.
    expect(await as(userOf('Salesperson'), 'select name from storage.objects')).toEqual([{ name: `${DEMO_TENANT}/logo.png` }]);
  });

  it('tenants stay isolated and anonymous callers are refused', async () => {
    for (const table of projection) expect(await as(OUTSIDER, `select 1 from public.${table} where tenant_id = '${DEMO_TENANT}'`), table).toEqual([]);
    expect((await as(OUTSIDER, 'select tenant_id from public.companies')).map(r => r.tenant_id)).toEqual([PARTNER_TENANT]);
    await expect(as(null, 'select 1 from public.documents', 'anon')).rejects.toThrow(/permission denied/);
    await expect(as(null, `select private.reads_full_ledger('${DEMO_TENANT}')`, 'anon')).rejects.toThrow(/permission denied/);
  });

  it('every RLS-protected public table except tenants and memberships uses the full-ledger read rule', async () => {
    const policies = (await db.query<{ tablename: string; qual: string; cmd: string; roles: string[] | string }>(
      `select tablename, qual, cmd, roles from pg_policies where schemaname = 'public' and tablename not in ('tenants', 'memberships') order by tablename`)).rows;
    expect(policies.map(p => p.tablename).sort()).toEqual([...projection].sort());
    for (const p of policies) {
      expect(p.cmd, p.tablename).toBe('SELECT');
      expect(p.qual, p.tablename).toMatch(/^private\.reads_full_ledger\(tenant_id\)$/);
    }
    const unprotected = (await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname <> 'schema_migrations'`)).rows;
    expect(unprotected).toEqual([]);
  });
});
