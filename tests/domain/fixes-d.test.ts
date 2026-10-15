/**
 * Regression tests for the security fixes D-07, D-18, D-20, D-22, D-30, D-32 and D-33 (agent D).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import Papa from 'papaparse';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { execute } from '../../src/modules/erp/engine';
import { csvFields, customers, fromCsvCell, toCsv } from '../../src/modules/erp/master-data';
import { toggleModules } from '../../src/modules/erp/modules';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { DEMO_TENANT, PARTNER_TENANT, roles, type Role } from '../../src/modules/erp/types';

type Row = Record<string, unknown>;
const root = resolve(__dirname, '../..');

// Route handlers run for real; the session, snapshot store and storage are stand-ins controlled per test.
const S = vi.hoisted(() => ({
  exchanged: [] as string[],
  member: (async () => ({ actor: { id: 'u-d', name: 'D Owner', role: 'Owner', branchIds: [] }, user: { id: 'u-d', email: 'd@qa.example' } })) as (tenant: string | null) => Promise<unknown>,
  read: (async () => { throw new Error('unset'); }) as (tenant: string) => Promise<unknown>,
  commit: (async () => true) as (tenant: string, expected: number, workspace: unknown) => Promise<boolean>,
  commits: 0,
  events: [] as string[],
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({ auth: { exchangeCodeForSession: async (code: string) => { S.exchanged.push(code); return {}; } } }),
}));
vi.mock('@/lib/workspace-store', () => ({
  requireMember: (tenant: string | null) => { S.events.push('member'); return S.member(tenant); },
  readWorkspace: (tenant: string) => { S.events.push('read'); return S.read(tenant); },
  commitWorkspace: (tenant: string, expected: number, workspace: unknown) => { S.commits++; return S.commit(tenant, expected, workspace); },
}));
vi.mock('@/lib/password', () => ({ verifyPassword: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => ({ storage: { from: () => ({ remove: async () => ({}), upload: async () => ({ error: null }) }) } }) }));
vi.mock('@/lib/branding-store', () => import('../../src/lib/branding-store'));
vi.mock('@/modules/erp/access', () => import('../../src/modules/erp/access'));
vi.mock('@/modules/erp/engine', () => import('../../src/modules/erp/engine'));
vi.mock('@/modules/erp/modules', () => import('../../src/modules/erp/modules'));
import * as callbackRoute from '../../src/app/auth/callback/route';
import * as uploadRoute from '../../src/app/api/branding/upload/route';
import * as workspaceRoute from '../../src/app/api/workspace/route';

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

// ---------- D-18: /auth/callback?next= only redirects within the app ----------
describe('D-18 auth callback redirect stays on the app origin', () => {
  const location = async (next: string, origin = 'http://localhost') => {
    const res = await callbackRoute.GET(new Request(`${origin}/auth/callback?code=c&next=${encodeURIComponent(next)}`));
    expect(res.status).toBe(307);
    return res.headers.get('location')!;
  };

  it('falls back to / for every off-site variant', async () => {
    const offSite = [
      'https://evil.com', 'http://evil.com/account/reset', '//evil.com', '///evil.com', '/\\evil.com', '/\\/evil.com', '\\\\evil.com',
      '/\t/evil.com', '/\n/evil.com', '\t//evil.com', ' //evil.com', '/\r\n/evil.com', 'https:evil.com', 'http://localhost@evil.com',
      'http://localhost.evil.com/', 'https://localhost/', 'javascript:alert(1)', 'data:text/html,hi', 'http://[::1', '',
    ];
    for (const next of offSite) expect(await location(next), JSON.stringify(next)).toBe('http://localhost/');
  });

  it('keeps encoded slashes and backslashes on the app as a path', async () => {
    for (const next of ['/%5Cevil.com', '/%2F%2Fevil.com', '%2F%2Fevil.com', '/%5C%5Cevil.com']) {
      expect(new URL(await location(next)).host, next).toBe('localhost');
    }
  });

  it('keeps legitimate in-app destinations, including query and hash', async () => {
    expect(await location('/account/reset')).toBe('http://localhost/account/reset');
    expect(await location('/sales?tab=invoices#top')).toBe('http://localhost/sales?tab=invoices#top');
    expect(await location('http://localhost/account/reset')).toBe('http://localhost/account/reset');
    expect(await location('/account/reset', 'https://erp.example.com')).toBe('https://erp.example.com/account/reset');
    const res = await callbackRoute.GET(new Request('http://localhost/auth/callback'));
    expect(res.headers.get('location')).toBe('http://localhost/');
    expect(S.exchanged.length).toBeGreaterThan(0);
  });
});

// ---------- D-20: CSV formula injection ----------
describe('D-20 CSV export neutralises formula cells', () => {
  const column = (csv: string) => Papa.parse<string[]>(csv).data.slice(1).map(r => r[0]);

  it('prefixes every risky leading character with an apostrophe, quoting where needed', () => {
    const values = ['=cmd|"/c calc"!A1', '+SUM(1,2)', '-2+3', '@SUM(A1)', '\t=1+1', '\r=1+1', '=HYPERLINK("http://x","y")', '+92 300 1234567', '-', '+'];
    const csv = toCsv(values.map(v => ({ v })), ['v']);
    expect(column(csv)).toEqual(values.map(v => `'${v}`));
    expect(toCsv([{ v: '=1' }], ['v'])).toBe("v\n'=1");
    expect(toCsv([{ v: '\r=1' }], ['v'])).toBe("v\n\"'\r=1\"");
    expect(toCsv([{ v: '=cmd|"/c calc"!A1' }], ['v'])).toBe(`v\n"'=cmd|""/c calc""!A1"`);
  });

  it('keeps plain numbers numeric, including negatives, and leaves ordinary text alone', () => {
    const row = { a: '-60.0000', b: -5, c: '+3', d: '-.5', e: '1234.0000', f: 'LED Panel', g: 'a=b', h: '', i: null, j: undefined, k: 0 };
    expect(toCsv([row], Object.keys(row))).toBe('a,b,c,d,e,f,g,h,i,j,k\n-60.0000,-5,+3,-.5,1234.0000,LED Panel,a=b,,,,0');
    expect(toCsv([{ v: '-1,500.00' }], ['v'])).toBe(`v\n"'-1,500.00"`);
  });

  it('fromCsvCell undoes only the guard toCsv adds', () => {
    expect(["'=1", "'+92 300 1234567", "'-2+3", "'@x", "'\t1"].map(fromCsvCell)).toEqual(['=1', '+92 300 1234567', '-2+3', '@x', '\t1']);
    expect(["'quoted", "O'Brien", "''=1", '-5', ''].map(fromCsvCell)).toEqual(["'quoted", "O'Brien", "''=1", '-5', '']);
  });

  it('an exported customer list imports back unchanged when cells pass through fromCsvCell', () => {
    const owner = { id: 'u-owner', name: 'Owner', role: 'Owner' as const, branchIds: [] };
    const company = () => ({ ...blankWorkspace(false), modules: [...toggleModules] });
    let w = company();
    const people = [{ name: '=Danger Traders', phone: '+92 300 1234567', city: '-Karachi' }, { name: 'Plain Co', phone: '021-1234567', city: 'Lahore' }];
    people.forEach((x, i) => {
      w = execute(w, { type: 'save_party', idempotencyKey: `d20-save-${i}`, payload: { type: 'customer', email: '', taxId: '', registered: false, customerClass: 'Retailer', creditLimit: '0', terms: 30, ...x } }, owner).workspace;
    });
    const exported = toCsv(customers.records(w) as never, csvFields(customers as never).map(f => f.key));
    expect(exported).toContain("'=Danger Traders");
    const parsed = Papa.parse<Record<string, string>>(exported, { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim(), transform: fromCsvCell });
    const imported = execute(company(), { type: 'import_records', idempotencyKey: 'd20-import', payload: { kind: 'customers', mode: 'create', rows: parsed.data } }, owner).workspace;
    const pick = (ws: typeof w) => customers.records(ws).map(p => [p.name, p.phone, p.city]);
    expect(pick(imported)).toEqual(pick(w));
    expect(pick(imported).map(r => r[0])).toEqual(['=Danger Traders', 'Plain Co']);
  });
});

// ---------- D-30: unexpected failures are 500, generic and logged; refusals stay 4xx ----------
const TENANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const companyWorkspace = () => ({ ...blankWorkspace(false), tenantId: TENANT, modules: [...toggleModules] });
let keyN = 0;
const command = (type: string, payload: Row = {}) => ({ type, payload, idempotencyKey: `fixes-d-${++keyN}-${Date.now()}` });
const jsonPost = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new Request('http://localhost/api/workspace', { method: 'POST', headers: { 'x-tenant-id': TENANT, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
async function send(request: Request) {
  const response = await workspaceRoute.POST(request);
  return { status: response.status, json: await response.json() as Row };
}
function resetStore(workspace: unknown = companyWorkspace()) {
  S.member = async () => ({ actor: { id: 'u-d', name: 'D Owner', role: 'Owner', branchIds: [] }, user: { id: 'u-d', email: 'd@qa.example' } });
  S.read = async () => ({ workspace, revision: 1 });
  S.commit = async () => true;
  S.commits = 0;
  S.events = [];
}
const GENERIC = 'Something went wrong on the server. Please try again.';

describe('D-30 workspace API error mapping', () => {
  it('a bug in the engine (TypeError) is a logged 500 with a generic message', async () => {
    resetStore({ ...companyWorkspace(), documents: null });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await send(jsonPost(command('submit_document', { id: 'x' })));
    expect(r).toEqual({ status: 500, json: { success: false, message: GENERIC } });
    expect(log).toHaveBeenCalledWith('Workspace command: unexpected failure', expect.any(TypeError));
    log.mockRestore();
  });

  it('the database or network failing is a logged 500, whatever shape the error has', async () => {
    for (const thrown of [{ message: 'TypeError: fetch failed', code: '' }, new TypeError('fetch failed'), new Error('Workspace not found.'), 'boom']) {
      resetStore(); S.read = async () => { throw thrown; };
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await send(jsonPost(command('save_company', { name: 'A Co', address: 'x' }))), JSON.stringify(thrown)).toEqual({ status: 500, json: { success: false, message: GENERIC } });
      const get = await workspaceRoute.GET(new Request(`http://localhost/api/workspace?tenant=${TENANT}`));
      expect([get.status, await get.json()]).toEqual([500, { success: false, message: GENERIC }]);
      expect(log).toHaveBeenCalledTimes(2);
      log.mockRestore();
    }
  });

  it('business refusals and invalid input stay 400 with their message; sign-in and membership stay 401/403', async () => {
    resetStore();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = await send(jsonPost(command('submit_document', { id: 'missing' })));
    expect(refused.status).toBe(400);
    expect(refused.json.message).toMatch(/not found/);
    expect((await send(jsonPost(command('drop_all_tables')))).json).toMatchObject({ message: 'Check the highlighted information.' });
    expect(await send(jsonPost('{"type":'))).toEqual({ status: 400, json: { success: false, message: 'The request is not valid JSON.' } });
    for (const body of ['null', '[1]', '"text"', '7']) expect(await send(jsonPost(body)), body).toEqual({ status: 400, json: { success: false, message: 'The request must be a JSON object.' } });
    for (const [code, status] of [['AUTH_REQUIRED', 401], ['ACCESS_DENIED', 403], ['TENANT_REQUIRED', 403]] as const) {
      S.member = async () => { throw new Error(code); };
      expect(await send(jsonPost(command('save_company', { name: 'A Co', address: 'x' }))), code).toEqual({ status, json: { success: false, message: code } });
    }
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('a change the database refuses keeps its own 500 message', async () => {
    resetStore(); S.commit = async () => { throw new Error('INTEGRITY:Journal JV-1 is not balanced.'); };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await send(jsonPost(command('save_company', { name: 'A Co', address: 'x' })));
    expect(r.status).toBe(500);
    expect(r.json.message).toBe('The database rejected this change because it would break a financial integrity rule. Nothing was saved.');
    expect(log).toHaveBeenCalledWith('Workspace command: commit rejected by database', 'INTEGRITY:Journal JV-1 is not balanced.');
    log.mockRestore();
  });

  it('branding upload: a body that is not a form is a 400; a storage or database fault is a logged 500', async () => {
    resetStore();
    const upload = (body: BodyInit, headers: Record<string, string> = {}) => uploadRoute.POST(new Request('http://localhost/api/branding/upload', { method: 'POST', headers: { 'x-tenant-id': TENANT, ...headers }, body }));
    const notForm = await upload('kind=logo', { 'content-type': 'text/plain' });
    expect([notForm.status, (await notForm.json()).message]).toEqual([400, 'Choose a logo or letterhead image.']);
    const form = new FormData(); form.set('kind', 'logo'); form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0])], 'logo.png', { type: 'image/png' }));
    S.read = async () => { throw new TypeError('fetch failed'); };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fault = await upload(form);
    expect([fault.status, await fault.json()]).toEqual([500, { success: false, message: GENERIC }]);
    expect(log).toHaveBeenCalledWith('Branding upload: unexpected failure', expect.any(TypeError));
    log.mockRestore();
  });
});
