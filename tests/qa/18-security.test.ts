/**
 * SQA pack 18 — Security, tenancy, roles, API (SEC).
 * Executed here: (1) the real /api/workspace, /api/branding, /api/demo-reset, /auth/callback route handlers and the
 * page/print entries, with the real workspace-store, password gate, branding store and engine running against an
 * in-memory Supabase fake; (2) the real migrations in PGlite with RLS, storage and role stubs (same setup as
 * tests/domain/database.test.ts); (3) the engine and scopeWorkspace directly; (4) static source/config checks.
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { actor, buildDemoWorkspace, execute, freshCompany, owner, refused, run, today, withDocument, withItem, withParty } from './helpers';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { commandSchema, canRun } from '../../src/modules/erp/engine';
import { businessToday } from '../../src/modules/erp/dates';
import { toCsv } from '../../src/modules/erp/master-data';
import { documentView } from '../../src/modules/erp/documents';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { DEMO_TENANT, PARTNER_TENANT, roles, type Role, type Workspace } from '../../src/modules/erp/types';

type Row = Record<string, unknown>;
const S = vi.hoisted(() => {
  const state = {
    user: null as null | { id: string; email?: string; user_metadata: Record<string, unknown> },
    memberships: [] as Row[], tenants: [] as Row[], snapshots: new Map<string, { data: unknown; revision: number }>(),
    adminCalls: 0, rpcCalls: 0, rpcMode: 'normal' as 'normal' | 'conflict' | 'commit-then-error', passwords: {} as Record<string, [string, string]>, uploads: [] as string[], signInCalls: [] as string[],
    table(rows: () => Row[]) {
      const filters: ((r: Row) => boolean)[] = []; let single = false;
      const q: Record<string, unknown> = {
        select: () => q, order: () => q,
        eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q; },
        in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return q; },
        single: () => { single = true; return q; },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          const data = rows().filter(r => filters.every(f => f(r)));
          return Promise.resolve(single ? (data[0] ? { data: data[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }) : { data, error: null }).then(res, rej);
        },
      };
      return q;
    },
    server() {
      return {
        auth: { getUser: async () => ({ data: { user: state.user } }), exchangeCodeForSession: async () => ({}), signOut: async () => ({}) },
        from: (t: string) => state.table(() => (t === 'memberships' ? state.memberships : t === 'tenants' ? state.tenants : [])),
      };
    },
    admin() {
      state.adminCalls++;
      return {
        from: () => state.table(() => [...state.snapshots].map(([tenant_id, v]) => ({ tenant_id, data: v.data, revision: v.revision }))),
        rpc: async (_: string, a: { p_tenant: string; p_expected: number; p_data: unknown }) => {
          state.rpcCalls++;
          const cur = state.snapshots.get(a.p_tenant);
          if (state.rpcMode === 'conflict' || !cur || cur.revision !== a.p_expected) return { data: null, error: null };
          state.snapshots.set(a.p_tenant, { data: JSON.parse(JSON.stringify(a.p_data)), revision: a.p_expected + 1 });
          if (state.rpcMode === 'commit-then-error') return { data: null, error: { message: 'canceling statement due to statement timeout' } };
          return { data: a.p_expected + 1, error: null };
        },
        storage: { from: () => ({ createSignedUrl: async (p: string, s: number) => ({ data: { signedUrl: `https://storage.example/${p}?e=${s}` } }), upload: async (p: string) => { state.uploads.push(p); return { error: null }; }, remove: async () => ({}) }) },
      };
    },
    passwordClient() {
      return { auth: {
        signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
          state.signInCalls.push(email);
          const entry = state.passwords[email];
          return entry && entry[1] === password ? { data: { user: { id: entry[0] } }, error: null } : { data: { user: null }, error: { message: 'Invalid login credentials' } };
        },
        signOut: async () => ({}),
      } };
    },
  };
  return state;
});

vi.mock('server-only', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => S.passwordClient() }));
vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: async () => S.server() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => S.admin() }));
vi.mock('@/lib/workspace-store', () => import('../../src/lib/workspace-store'));
vi.mock('@/lib/password', () => import('../../src/lib/password'));
vi.mock('@/lib/branding-store', () => import('../../src/lib/branding-store'));
vi.mock('@/modules/erp/access', () => import('../../src/modules/erp/access'));
vi.mock('@/modules/erp/codec', () => import('../../src/modules/erp/codec'));
vi.mock('@/modules/erp/demo', () => import('../../src/modules/erp/demo'));
vi.mock('@/modules/erp/documents', () => import('../../src/modules/erp/documents'));
vi.mock('@/modules/erp/engine', () => import('../../src/modules/erp/engine'));
vi.mock('@/modules/erp/modules', () => import('../../src/modules/erp/modules'));
vi.mock('@/modules/erp/money', () => import('../../src/modules/erp/money'));
vi.mock('@/modules/erp/types', () => import('../../src/modules/erp/types'));
vi.mock('@/components/document-preview', () => import('../../src/components/document-preview'));
vi.mock('@/components/print-actions', () => ({ PrintActions: () => null }));
vi.mock('@/components/login-screen', () => ({ LoginScreen: () => null }));
vi.mock('@/components/workbench', () => ({ Workbench: () => null }));

import * as workspaceRoute from '../../src/app/api/workspace/route';
import * as brandingRoute from '../../src/app/api/branding/[kind]/route';
import * as demoResetRoute from '../../src/app/api/demo-reset/route';
import * as callbackRoute from '../../src/app/auth/callback/route';
import EntryPage from '../../src/app/[[...path]]/page';
import PrintPage from '../../src/app/print/[kind]/[id]/page';
import { storeBrandingFile } from '../../src/lib/branding-store';
import { DocumentPreview } from '../../src/components/document-preview';

const root = resolve(__dirname, '../..');
const src = (p: string) => readFileSync(resolve(root, p), 'utf8');
const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ME = { id: 'u-me', email: 'me@qa.example', user_metadata: { display_name: 'QA Me' } };
const company = (tenantId: string, name = 'Sec Co'): Workspace => ({ ...freshCompany(undefined, { name }), tenantId });
function seed(snapshots: Workspace[], memberships: [string, Role, Row?][], user = ME) {
  S.user = user;
  S.snapshots = new Map(snapshots.map(w => [w.tenantId, { data: JSON.parse(JSON.stringify(w)), revision: w.revision }]));
  S.memberships = memberships.map(([tenant_id, role, extra]) => ({ tenant_id, user_id: user.id, role, branch_ids: [], employee_id: null, active: true, ...extra }));
  S.tenants = snapshots.map(w => ({ id: w.tenantId, name: w.company.name, is_demo: w.demo }));
}
const req = (body: unknown, tenant: string | null = T, headers: Record<string, string> = {}) => new Request('http://localhost/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json', ...(tenant ? { 'x-tenant-id': tenant } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
let n = 0;
const cmd = (type: string, payload: Row = {}, extra: Row = {}) => ({ type, payload, idempotencyKey: `sec-${++n}-${Date.now()}`, ...extra });
const POST = async (body: unknown, tenant: string | null = T, headers: Record<string, string> = {}) => { const r = await workspaceRoute.POST(req(body, tenant, headers)); return { status: r.status, json: await r.json() as Row, headers: r.headers }; };
const stored = (tenant = T) => S.snapshots.get(tenant)!.data as Workspace;

// ---------- PGlite with the real migrations (copied from tests/domain/database.test.ts) ----------
const OWNER = '00000000-0000-4000-8000-000000000001';
const SALES = '00000000-0000-4000-8000-000000000002';
const OUTSIDER = '00000000-0000-4000-8000-000000000003';
let db: PGlite;
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
async function as(role: 'authenticated' | 'anon' | 'service_role', userId: string | null, sql: string, params: unknown[] = []) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${userId ?? ''}', false);`);
  try { return (await db.query<Row>(sql, params)).rows; } finally { await db.exec('reset role;'); }
}
async function asError(role: 'authenticated' | 'anon' | 'service_role', userId: string | null, sql: string) {
  try { await as(role, userId, sql); return ''; } catch (e) { return (e as Error).message; }
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(supabaseStubs);
  const dir = resolve(root, 'supabase/migrations');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files.filter(x => x < '202610120001')) await db.exec(readFileSync(resolve(dir, f), 'utf8'));
  const { modules: _m, setup: _s, branding: _b, ...demo } = buildDemoWorkspace();
  await db.query('insert into auth.users (id) values ($1), ($2), ($3)', [OWNER, SALES, OUTSIDER]);
  await db.query(`insert into public.tenants (id, name, is_demo) values ($1, 'Demo', true), ($2, 'Partner', false)`, [DEMO_TENANT, PARTNER_TENANT]);
  await db.query(`insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'Owner'), ($1, $3, 'Salesperson'), ($4, $5, 'Owner')`, [DEMO_TENANT, OWNER, SALES, PARTNER_TENANT, OUTSIDER]);
  await db.query(`insert into public.workspace_snapshots (tenant_id, revision, data) values ($1, $2, $3::jsonb), ($4, 0, to_jsonb($5::text))`, [DEMO_TENANT, demo.revision, JSON.stringify(demo), PARTNER_TENANT, JSON.stringify(blankWorkspace(false))]);
  for (const f of files.filter(x => x >= '202610120001')) await db.exec(readFileSync(resolve(dir, f), 'utf8'));
  await db.query(`update public.memberships set employee_id = 'e-4' where user_id = $1`, [SALES]);
  await db.query(`insert into storage.objects (bucket_id, name) values ('branding', $1), ('branding', $2)`, [`${DEMO_TENANT}/logo.png`, `${PARTNER_TENANT}/logo.png`]);
}, 60_000);

beforeEach(() => { S.adminCalls = 0; S.rpcCalls = 0; S.rpcMode = 'normal'; S.uploads = []; S.signInCalls = []; S.passwords = {}; });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const demo = buildDemoWorkspace();
const salesInvoiceDraft = (w: Workspace) => { let item: string, cust: string; [w, item] = withItem(w, {}, { quantity: '10', cost: '1' }); [w, cust] = withParty(w); return withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '10' }], {}, false); };

describe('18 security', () => {
  it('SEC-001 POST for a tenant you are not a member of → 403; no change', async () => {
    seed([company(T), company(T2, 'Victim Co')], [[T, 'Owner']]);
    const before = JSON.stringify(stored(T2));
    const r = await POST(cmd('save_company', { name: 'Pwned', address: 'x' }), T2);
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ success: false, message: 'ACCESS_DENIED' });
    expect(JSON.stringify(stored(T2))).toBe(before);
    expect(S.rpcCalls).toBe(0);
  });
  it('SEC-002 POST without x-tenant-id is refused [case-corrected: 403 TENANT_REQUIRED, not 400]', async () => {
    seed([company(T)], [[T, 'Owner']]);
    const r = await POST(cmd('save_company', { name: 'X Co', address: 'x' }), null);
    expect(r.status).toBe(403);
    expect(r.json.message).toBe('TENANT_REQUIRED');
    expect(S.rpcCalls).toBe(0);
  });
  it("SEC-003 POST with another member's tenant id and your valid session → refused", async () => {
    seed([company(T), company(T2)], [[T, 'Accountant']]);
    S.memberships.push({ tenant_id: T2, user_id: 'someone-else', role: 'Owner', branch_ids: [], employee_id: null, active: true });
    expect((await POST(cmd('create_journal', {}), T2)).status).toBe(403);
  });
  it('SEC-004 page ?tenant=<other tenant> falls back to own company; no data from the other', async () => {
    seed([company(T, 'Mine'), company(T2, 'Theirs')], [[T, 'Owner']]);
    const el = await EntryPage({ searchParams: Promise.resolve({ tenant: T2 }) }) as ReactElement<{ initialWorkspace: Workspace; memberships: unknown[] }>;
    expect(el.props.initialWorkspace.tenantId).toBe(T);
    expect(JSON.stringify(el.props)).not.toContain('Theirs');
  });
  it("SEC-005 RLS: workspace_snapshots of another tenant → 0 rows for a user JWT; anon has no access [documented: an Owner/Accountant/Auditor can read their own tenant's snapshot; a salesperson none]", async () => {
    expect(await as('authenticated', OUTSIDER, 'select tenant_id from public.workspace_snapshots')).toEqual([{ tenant_id: PARTNER_TENANT }]);
    expect(await as('authenticated', OWNER, `select tenant_id from public.workspace_snapshots where tenant_id = '${PARTNER_TENANT}'`)).toEqual([]);
    expect(await as('authenticated', SALES, 'select tenant_id from public.workspace_snapshots')).toEqual([]);
    expect(await asError('anon', null, 'select 1 from public.workspace_snapshots')).toMatch(/permission denied/);
  });
  it('SEC-006 RLS: memberships lists only your own (owners see their tenant)', async () => {
    expect(await as('authenticated', SALES, 'select user_id from public.memberships')).toEqual([{ user_id: SALES }]);
    expect((await as('authenticated', OUTSIDER, 'select tenant_id from public.memberships')).map(r => r.tenant_id)).toEqual([PARTNER_TENANT]);
  });
  it('SEC-007 RLS: tenants shows only member tenants', async () => {
    expect((await as('authenticated', SALES, 'select id from public.tenants')).map(r => r.id)).toEqual([DEMO_TENANT]);
    expect((await as('authenticated', OUTSIDER, 'select id from public.tenants')).map(r => r.id)).toEqual([PARTNER_TENANT]);
  });
  it("SEC-008 storage: listing branding/<other tenant>/ with a user JWT returns nothing", async () => {
    expect(await as('authenticated', OUTSIDER, `select name from storage.objects where bucket_id = 'branding' and name like '${DEMO_TENANT}/%'`)).toEqual([]);
  });
  it("SEC-009 storage: another tenant's logo object is not readable; own tenant's is", async () => {
    expect(await as('authenticated', SALES, `select name from storage.objects where name = '${PARTNER_TENANT}/logo.png'`)).toEqual([]);
    expect(await as('authenticated', SALES, `select name from storage.objects where name = '${DEMO_TENANT}/logo.png'`)).toEqual([{ name: `${DEMO_TENANT}/logo.png` }]);
  });
  it('SEC-010 service-role key only in the server-only admin module; no client file references it [documented: no build output scanned, source only]', () => {
    const files = execSync('git ls-files src', { cwd: root, encoding: 'utf8' }).split('\n').filter(f => /\.(ts|tsx)$/.test(f));
    const users = files.filter(f => src(f).includes('SUPABASE_SERVICE_ROLE_KEY'));
    expect(users).toEqual(['src/lib/supabase/admin.ts']);
    expect(src('src/lib/supabase/admin.ts').startsWith("import 'server-only';")).toBe(true);
    const clientFiles = files.filter(f => /^['"]use client['"]/.test(src(f)));
    expect(clientFiles.length).toBeGreaterThan(5);
    for (const f of clientFiles) expect(src(f), f).not.toMatch(/createAdminSupabase|@\/lib\/supabase\/admin|workspace-store|SERVICE_ROLE/);
  });
  it('SEC-011 NEXT_PUBLIC_* holds only the Supabase URL and publishable key [documented: .env.example also has NEXT_PUBLIC_APP_URL]', () => {
    const files = execSync('git ls-files src', { cwd: root, encoding: 'utf8' }).split('\n').filter(f => /\.(ts|tsx)$/.test(f));
    const names = new Set(files.flatMap(f => [...src(f).matchAll(/NEXT_PUBLIC_[A-Z_]+/g)].map(m => m[0])));
    expect([...names].sort()).toEqual(['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL']);
    expect([...src('.env.example').matchAll(/^(NEXT_PUBLIC_[A-Z_]+)=/gm)].map(m => m[1])).toEqual(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_APP_URL']);
  });
  it('SEC-012 unauthenticated POST never constructs the service-role client', async () => {
    seed([company(T)], [[T, 'Owner']]); S.user = null; S.adminCalls = 0;
    expect((await POST(cmd('save_company', { name: 'X Co', address: 'x' }))).status).toBe(401);
    expect(S.adminCalls).toBe(0);
    seed([company(T)], []); S.adminCalls = 0;
    expect((await POST(cmd('save_company', { name: 'X Co', address: 'x' }))).status).toBe(403);
    expect(S.adminCalls).toBe(0);
  });
  it('SEC-013 Auditor: every mutating command → "Your role does not permit this action."', async () => {
    for (const type of commandSchema.shape.type.options) expect(canRun('Auditor', type), type).toBe(false);
    seed([company(T)], [[T, 'Auditor']]);
    const r = await POST(cmd('save_company', { name: 'Audit Co', address: 'x' }));
    expect(r.status).toBe(400);
    expect(r.json.message).toBe('Your role does not permit this action.');
  });
  it('SEC-014 Salesperson save_item refused', () => {
    refused(freshCompany(), 'save_item', { sku: 'S1', name: 'Item', category: '', hsCode: '', unit: 'pcs', price: '1', cost: '1', weight: '0', volume: '0', reorderLevel: 0 }, 'Your role does not permit this action.', actor('Salesperson', { employeeId: 'e-4' }));
  });
  it('SEC-015 Salesperson create purchase document → "Your role cannot create purchase documents."', () => {
    let w = freshCompany(); let item: string, supp: string; [w, item] = withItem(w); [w, supp] = withParty(w, 'supplier');
    refused(w, 'create_document', { kind: 'purchase_order', partyId: supp, warehouseId: w.warehouses[0].id, date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '1', price: '1' }] }, 'Your role cannot create purchase documents.', actor('Salesperson', { employeeId: 'e-4' }));
  });
  it('SEC-016 Warehouse Manager create_receipt refused', () => {
    refused(demo, 'create_receipt', { partyId: 'c-1', date: today(), amount: '1', method: 'cash', dueDate: today(), allocations: [{ invoiceId: 'x', amount: '1' }] }, 'Your role does not permit this action.', actor('Warehouse Manager'));
  });
  it('SEC-017 Recovery Officer supplier payment → "Recovery officers cannot pay suppliers."', () => {
    const bill = demo.documents.find(d => d.kind === 'supplier_invoice' && d.status === 'submitted')!;
    refused(demo, 'create_receipt', { partyId: bill.partyId, date: today(), amount: '1', method: 'bank', dueDate: today(), allocations: [{ invoiceId: bill.id, amount: '1' }] }, 'Recovery officers cannot pay suppliers.', actor('Recovery Officer'));
  });
  it('SEC-018 Payroll Administrator submit_document refused', () => {
    const [w, draft] = salesInvoiceDraft(freshCompany());
    refused(w, 'submit_document', { id: draft }, 'Your role does not permit this action.', actor('Payroll Administrator'));
  });
  it('SEC-019 Sales Manager set_period refused', () => {
    refused(freshCompany(), 'set_period', { month: '2026-01', locked: true }, 'Your role does not permit this action.', actor('Sales Manager'));
  });
  it('SEC-020 Accountant reopening a period → "Only the owner can reopen an accounting period."', () => {
    const w = run(freshCompany(), 'set_period', { month: '2026-01', locked: true }).workspace;
    refused(w, 'set_period', { month: '2026-01', locked: false }, 'Only the owner can reopen an accounting period.', actor('Accountant'));
  });
  it('SEC-021 module gate: Payroll off → create_payroll is 400 with the module-off message', async () => {
    seed([company(T)].map(w => ({ ...w, modules: w.modules.filter(m => m !== 'payroll') })), [[T, 'Owner']]);
    const r = await POST(cmd('create_payroll', { month: '2026-10' }));
    expect(r.status).toBe(400);
    expect(r.json.message).toBe('Payroll is turned off for this company. Turn it on in Settings → Features.');
  });
  it('SEC-022 module gate: Sales off → create_document sales_invoice refused', () => {
    let w = freshCompany(); let item: string, cust: string; [w, item] = withItem(w); [w, cust] = withParty(w);
    w = { ...w, modules: w.modules.filter(m => !['sales', 'collections', 'commissions'].includes(m)) };
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: w.warehouses[0].id, date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '1', price: '1' }] }, 'Sales is turned off for this company.');
  });
  it('SEC-023 module gate: Collections off → update_cheque refused', () => {
    const w = { ...demo, modules: demo.modules.filter(m => !['collections', 'commissions'].includes(m)) };
    refused(w, 'update_cheque', { id: demo.receipts[0].id, status: 'deposited' }, 'Collections & PDCs is turned off for this company.');
  });
  it('SEC-024 password gate: set_modules removing a module without password → 401, nothing saved', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'pk');
    const w = company(T); seed([w], [[T, 'Owner']]);
    const r = await POST(cmd('set_modules', { enabled: w.modules.filter(m => m !== 'payroll') }));
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ success: false, message: 'Enter your password to confirm.', passwordRequired: true });
    expect(S.rpcCalls).toBe(0);
  });
  it('SEC-025 password gate with wrong password → 401 "Password incorrect."', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'pk');
    const user = { ...ME, id: 'u-sec-025', email: 'sec025@qa.example' }; S.passwords = { [user.email]: [user.id, 'right-password'] };
    const w = company(T); seed([w], [[T, 'Owner']], user);
    const r = await POST(cmd('set_modules', { enabled: ['sales'] }, { confirmPassword: 'wrong-password' }));
    expect(r.status).toBe(401);
    expect(r.json.message).toBe('Password incorrect.');
    const ok = await POST(cmd('set_modules', { enabled: w.modules.filter(m => m !== 'payroll') }, { confirmPassword: 'right-password' }));
    expect(ok.status).toBe(200);
    expect(stored().modules).not.toContain('payroll');
  });
  it('SEC-026 password gate: adding a module needs no password', async () => {
    const w = { ...company(T), modules: ['sales' as const] }; seed([w], [[T, 'Owner']]);
    const r = await POST(cmd('set_modules', { enabled: ['sales', 'reports'] }));
    expect(r.status).toBe(200);
    expect(S.signInCalls).toEqual([]);
    expect(stored().modules).toEqual(['sales', 'reports']);
  });
  it("SEC-027 password verified against the caller's own account only", async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'pk');
    const user = { ...ME, id: 'u-sec-027', email: 'sec027@qa.example' };
    S.passwords = { [user.email]: [user.id, 'mine-123'], 'colleague@qa.example': ['u-colleague', 'theirs-123'] };
    seed([company(T)], [[T, 'Owner']], user);
    const r = await POST(cmd('set_modules', { enabled: ['sales'] }, { confirmPassword: 'theirs-123' }));
    expect(r.status).toBe(401);
    expect(S.signInCalls).toEqual([user.email]);
  });
  it('SEC-028 branch-limited member posting for a warehouse in another branch → "This warehouse is outside your permitted branches."', () => {
    const lhe = demo.documents.find(d => d.warehouseId === 'lhe-main')!;
    refused(demo, 'stock_transfer', { itemId: 'i-3', from: 'lhe-main', to: 'khi-main', quantity: '1', date: today() }, 'This warehouse is outside your permitted branches.', actor('Warehouse Manager', { branchIds: ['karachi'] }));
    expect(lhe).toBeDefined();
  });
  it('SEC-029 branch scoping on page load: only branch A documents and stock', () => {
    const v = scopeWorkspace(demo, actor('Accountant', { branchIds: ['karachi'] }));
    expect(v.warehouses.map(x => x.id).sort()).toEqual(['khi-main', 'khi-port']);
    expect(v.documents.length).toBeGreaterThan(0);
    expect(v.documents.every(d => d.warehouseId.startsWith('khi-'))).toBe(true);
    expect(v.stockMoves.every(m => m.warehouseId.startsWith('khi-'))).toBe(true);
    expect(v.journals).toEqual([]);
  });
  it('SEC-030 Salesperson scope: API projection (own sales docs, customers, own commissions, zero salaries, no journals/audit/payroll) and the direct RLS path [defect: RLS lets a salesperson read every document in the tenant]', async () => {
    const v = scopeWorkspace(demo, actor('Salesperson', { employeeId: 'e-4' }));
    expect(v.documents.every(d => ['quotation', 'sales_order', 'delivery', 'sales_invoice', 'credit_note'].includes(d.kind) && d.lines.some(l => l.employeeId === 'e-4' || l.splits.some(s => s.employeeId === 'e-4')))).toBe(true);
    expect(v.parties.every(p => p.type === 'customer')).toBe(true);
    expect(v.commissions.every(c => c.employeeId === 'e-4')).toBe(true);
    expect(v.employees.every(e => e.salary === '0' && e.allowance === '0')).toBe(true);
    expect([v.journals, v.audit, v.payrolls]).toEqual([[], [], []]);
    // Same user, same session, querying PostgREST directly with the publishable key:
    const kinds = (await as('authenticated', SALES, 'select distinct kind from public.documents order by kind')).map(r => r.kind);
    expect(kinds.filter(k => !['quotation', 'sales_order', 'delivery', 'sales_invoice', 'credit_note'].includes(k as string))).toEqual([]);
  });
  it('SEC-031 Warehouse Manager page load: warehouse documents and suppliers; no receipts or journals', () => {
    const v = scopeWorkspace(demo, actor('Warehouse Manager'));
    expect(v.documents.every(d => ['purchase_order', 'goods_receipt', 'supplier_invoice', 'supplier_return', 'delivery'].includes(d.kind))).toBe(true);
    expect(v.parties.some(p => p.type === 'supplier')).toBe(true);
    expect([v.receipts, v.journals]).toEqual([[], []]);
  });
  it('SEC-032 Recovery Officer page load: sales documents, receipts, follow-ups; no stock moves', () => {
    const v = scopeWorkspace(demo, actor('Recovery Officer'));
    expect(v.documents.every(d => ['quotation', 'sales_order', 'delivery', 'sales_invoice', 'credit_note'].includes(d.kind))).toBe(true);
    expect(v.receipts.length).toBeGreaterThan(0);
    expect(v.followUps.length).toBe(demo.followUps.length);
    expect(v.stockMoves).toEqual([]);
  });
  it('SEC-033 Payroll Administrator page load: payrolls, employees with salaries, sales invoices only', () => {
    const v = scopeWorkspace(demo, actor('Payroll Administrator'));
    expect(v.payrolls).toEqual(demo.payrolls);
    expect(v.employees).toEqual(demo.employees);
    expect(v.documents.every(d => d.kind === 'sales_invoice')).toBe(true);
    expect(v.journals).toEqual([]);
  });
  it('SEC-034 Auditor page load: everything, read-only', () => {
    const v = scopeWorkspace(demo, actor('Auditor'));
    expect(v.documents).toHaveLength(demo.documents.length);
    expect(v.journals).toHaveLength(demo.journals.length);
    expect(v.audit).toHaveLength(demo.audit.length);
    expect(commandSchema.shape.type.options.filter(t => canRun('Auditor', t))).toEqual([]);
  });
  it('SEC-035 bankAccounts go to every role (names only); balances not derivable without journals', () => {
    for (const role of roles) {
      const v = scopeWorkspace(demo, actor(role, { employeeId: 'e-4' }));
      expect(v.bankAccounts, role).toEqual(demo.bankAccounts);
      if (!['Owner', 'Accountant', 'Auditor'].includes(role)) expect(v.journals, role).toEqual([]);
    }
  });
  it('SEC-036 idempotency: same key twice → second returns the original result; no duplicate [case-corrected: a replay returns the original recordId and message (D-17)]', () => {
    let item: string, cust: string; let w = freshCompany(); [w, item] = withItem(w, {}, { quantity: '5', cost: '1' }); [w, cust] = withParty(w);
    const c = { type: 'create_document', payload: { kind: 'sales_invoice', partyId: cust, warehouseId: w.warehouses[0].id, date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '1', price: '1' }] }, idempotencyKey: 'sec-036-idem' };
    const first = execute(w, c, owner);
    const second = execute(first.workspace, c, owner);
    expect(second.workspace).toBe(first.workspace);
    expect([second.recordId, second.message]).toEqual([first.recordId, first.message]);
    expect(second.workspace.documents).toHaveLength(1);
  });
  it('SEC-037 idempotency key shorter than 8 chars → 400 validation', async () => {
    seed([company(T)], [[T, 'Owner']]);
    const r = await POST({ type: 'save_company', payload: { name: 'Key Co', address: 'x' }, idempotencyKey: 'short' });
    expect(r.status).toBe(400);
    expect(r.json.message).toBe('Check the highlighted information.');
  });
  it('SEC-038 idempotency key of 101 chars → 400 validation', async () => {
    seed([company(T)], [[T, 'Owner']]);
    expect((await POST({ type: 'save_company', payload: { name: 'Key Co', address: 'x' }, idempotencyKey: 'k'.repeat(101) })).status).toBe(400);
    expect((await POST({ type: 'save_company', payload: { name: 'Key Co', address: 'x' }, idempotencyKey: 'k'.repeat(100) })).status).toBe(200);
  });
  it('SEC-039 same key, different payload [case-corrected: treated as a replay — unchanged workspace and the first call\'s recordId and message (D-17)]', () => {
    const first = run(freshCompany(), 'save_company', { name: 'First Name', address: 'x' }, owner, 'sec-039-same-key'); const w = first.workspace;
    const again = execute(w, { type: 'save_company', payload: { name: 'Second Name', address: 'y' }, idempotencyKey: 'sec-039-same-key' }, owner);
    expect(again).toEqual({ workspace: w, recordId: first.recordId, message: 'Company details saved.' });
    expect(again.workspace).toBe(w);
    expect(again.workspace.company.name).toBe('First Name');
  });
  it('SEC-040 the same idempotency key in two tenants is independent', () => {
    const a = run(company(T), 'save_company', { name: 'A Co', address: 'x' }, owner, 'sec-040-shared').workspace;
    const b = run(company(T2), 'save_company', { name: 'B Co', address: 'x' }, owner, 'sec-040-shared').workspace;
    expect([a.company.name, b.company.name]).toEqual(['A Co', 'B Co']);
  });
  it('SEC-041 revision conflict: the losing writer gets 409 [case-corrected: the client does not auto-retry; it shows "Another change was saved first. Refresh and try again."]', async () => {
    seed([company(T)], [[T, 'Owner']]); S.rpcMode = 'conflict';
    const r = await POST(cmd('save_company', { name: 'Loser Co', address: 'x' }));
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ success: false, message: 'Another change was saved first. Refresh and try again.' });
    const wb = src('src/components/workbench.tsx');
    expect(wb.slice(wb.indexOf('async function postCommand('), wb.indexOf('async function command('))).not.toContain('409');
  });
  it('SEC-042 commit_workspace with non-object data is rejected by the RPC', async () => {
    await expect(db.query(`select public.commit_workspace($1, 0, to_jsonb('not an object'::text))`, [PARTNER_TENANT])).rejects.toThrow('Snapshot must be a JSON object.');
    await expect(db.query(`select public.commit_workspace($1, 0, '[1,2]'::jsonb)`, [PARTNER_TENANT])).rejects.toThrow('Snapshot must be a JSON object.');
  });
  it('SEC-043 unknown command type → 400 validation', async () => {
    seed([company(T)], [[T, 'Owner']]);
    const r = await POST(cmd('drop_all_tables', {}));
    expect(r.status).toBe(400);
    expect(r.json.message).toBe('Check the highlighted information.');
  });
  it('SEC-044 5 MB payload → validation error, no crash [documented: no 413 at app level; field limits reject it]', async () => {
    const w = company(T); let item: string, cust: string; let x = w; [x, item] = withItem(x); [x, cust] = withParty(x); seed([x], [[T, 'Owner']]);
    const r = await POST(cmd('create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: x.warehouses[0].id, date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '1', price: '1' }], notes: 'x'.repeat(5 * 1024 * 1024) }));
    expect(r.status).toBe(400);
    expect(r.json.message).toBe('Check the highlighted information.');
    expect(S.rpcCalls).toBe(0);
  });
  it('SEC-045 malformed JSON → 400', async () => {
    seed([company(T)], [[T, 'Owner']]);
    const r = await POST('{"type":"save_company",', T);
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
  });
  it('SEC-046 Content-Type text/plain is refused with 400 [defect: the body is parsed regardless of content type]', async () => {
    seed([company(T)], [[T, 'Owner']]);
    const r = await POST(cmd('save_company', { name: 'Plain Co', address: 'x' }), T, { 'content-type': 'text/plain' });
    expect(r.status).toBe(400);
  });
  it('SEC-047 GET /api/workspace signed out → 401 [documented: signed-in GET returns the role-scoped workspace]', async () => {
    seed([company(T)], [[T, 'Owner']]); S.user = null;
    expect((await workspaceRoute.GET(new Request(`http://localhost/api/workspace?tenant=${T}`))).status).toBe(401);
    seed([demo], [[DEMO_TENANT, 'Salesperson', { employee_id: 'e-4' }]]);
    const r = await workspaceRoute.GET(new Request(`http://localhost/api/workspace?tenant=${DEMO_TENANT}`));
    const body = await r.json() as { workspace: Workspace };
    expect(r.status).toBe(200);
    expect(body.workspace.journals).toEqual([]);
    expect(body.workspace.operations).toEqual([]);
  });
  it('SEC-048 CSRF [documented: session cookies are SameSite=Lax (@supabase/ssr default); the route has no Origin check and also accepts ?tenant= in the URL]', async () => {
    const { DEFAULT_COOKIE_OPTIONS } = await import('@supabase/ssr/dist/main/utils/constants.js') as unknown as { DEFAULT_COOKIE_OPTIONS: { sameSite: string } };
    expect(DEFAULT_COOKIE_OPTIONS.sameSite).toBe('lax');
    const route = src('src/app/api/workspace/route.ts');
    expect(route).not.toMatch(/origin/i);
    expect(route).toContain("new URL(request.url).searchParams.get('tenant')");
  });
  it('SEC-049 CORS: no permissive headers on API responses', async () => {
    seed([company(T)], [[T, 'Owner']]);
    const r = await POST(cmd('save_company', { name: 'Cors Co', address: 'x' }), T, { origin: 'https://evil.example' });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  });
  it('SEC-050 security headers [documented: X-Content-Type-Options, Referrer-Policy, X-Frame-Options DENY, Permissions-Policy on all routes; no CSP; HSTS left to the host]', () => {
    const cfg = src('next.config.ts');
    for (const h of ['"X-Content-Type-Options",value:"nosniff"', '"Referrer-Policy",value:"strict-origin-when-cross-origin"', '"X-Frame-Options",value:"DENY"', '"Permissions-Policy"']) expect(cfg).toContain(h);
    expect(cfg).toContain('source:"/(.*)"');
    expect(cfg).not.toMatch(/Content-Security-Policy|Strict-Transport-Security/);
    expect(cfg).toContain('poweredByHeader: false');
  });
  it('SEC-051 XSS via free-text fields is stored verbatim and escaped on the print template [documented: list/dialog rendering needs a browser]', () => {
    const x = '<img src=x onerror=alert(1)>';
    let w = run(freshCompany(), 'save_branding', { template: 'standard', accent: '#123456', footer: x }).workspace;
    w = run(w, 'save_company', { name: `Co ${x}`, address: x, phone: '', email: '', taxId: x }).workspace;
    let item: string, cust: string, doc: string; [w, item] = withItem(w, { name: `Item ${x}` }, { quantity: '1', cost: '1' }); [w, cust] = withParty(w, 'customer', { name: `Cust ${x}` });
    [w, doc] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '1' }], { notes: x });
    const html = renderToStaticMarkup(createElement(DocumentPreview, { view: documentView(w, w.documents.find(d => d.id === doc)!), company: w.company, branding: w.branding, assets: {} }));
    expect(html).not.toContain('<img src=x');
    expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)!.length).toBeGreaterThanOrEqual(6);
  });
  it('SEC-052 HTML in CSV import cells is stored as literal text and escaped when rendered', () => {
    const w = run(freshCompany(), 'import_records', { kind: 'customers', rows: [{ name: '<b onmouseover=alert(1)>Bold</b>', city: '<i>Karachi</i>' }] }).workspace;
    const p = w.parties.find(x => x.name.startsWith('<b'))!;
    expect(p).toMatchObject({ name: '<b onmouseover=alert(1)>Bold</b>', city: '<i>Karachi</i>' });
    expect(renderToStaticMarkup(createElement('td', null, p.name))).toBe('<td>&lt;b onmouseover=alert(1)&gt;Bold&lt;/b&gt;</td>');
  });
  it('SEC-053 CSV injection: formula-leading cells are neutralised on export [defect: toCsv writes =cmd() verbatim]', () => {
    const csv = toCsv([{ name: '=cmd|"/c calc"!A1', note: '+SUM(1,2)', other: '@x', minus: '-2+3' }], ['name', 'note', 'other', 'minus']);
    const cells = csv.split('\n')[1];
    expect(cells).not.toMatch(/(^|,)"?[=+@-]/);
  });
  it('SEC-054 path traversal in branding: upload filename ignored; saved paths must stay inside the tenant folder', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const stored1 = await storeBrandingFile(T, 'logo', new File([png], '../../other-tenant/logo.png', { type: 'image/png' }));
    expect(stored1).toEqual({ path: `${T}/logo.png` });
    expect(S.uploads).toEqual([`${T}/logo.png`]);
    const w = company(T);
    expect(() => run(w, 'save_branding', { template: 'standard', accent: '#123456', footer: '', logoPath: `${T2}/logo.png` })).toThrow('Branding files must belong to this company.');
    expect(() => run(w, 'save_branding', { template: 'standard', accent: '#123456', footer: '', logoPath: `${T}/../${T2}/logo.png` })).toThrow('Branding files must belong to this company.');
  });
  it('SEC-055 executable renamed .png is refused by content sniffing', async () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
    expect(await storeBrandingFile(T, 'logo', new File([exe], 'logo.png', { type: 'image/png' }))).toEqual({ error: 'Upload a PNG or JPG image.' });
    expect(await storeBrandingFile(T, 'logo', new File(['<svg onload=alert(1)/>'], 'logo.svg', { type: 'image/svg+xml' }))).toEqual({ error: 'Upload a PNG or JPG image.' });
    expect(S.uploads).toEqual([]);
  });
  it('SEC-057 /api/branding/logo?tenant=<other> → 401', async () => {
    seed([company(T), { ...company(T2), branding: { template: 'standard', accent: '#000000', footer: '', logoPath: `${T2}/logo.png` } }], [[T, 'Owner']]);
    const r = await brandingRoute.GET(new Request(`http://localhost/api/branding/logo?tenant=${T2}`), { params: Promise.resolve({ kind: 'logo' }) });
    expect(r.status).toBe(401);
    expect(r.headers.get('location')).toBeNull();
  });
  it('SEC-058 /api/demo-reset for a non-demo member is refused; the RPC refuses rebuilding a non-demo tenant [documented: route always targets the demo tenant]', async () => {
    seed([company(T)], [[T, 'Owner']]);
    const r = await demoResetRoute.POST();
    expect(r.status).toBe(403);
    expect(S.rpcCalls).toBe(0);
    await expect(db.query(`select public.commit_workspace($1, 0, $2::jsonb, true)`, [PARTNER_TENANT, JSON.stringify({ ...blankWorkspace(false), revision: 1 })])).rejects.toThrow('Only demo workspaces can be rebuilt.');
  });
  it('SEC-059 /api/demo-reset as a non-owner demo member is refused', async () => {
    seed([demo], [[DEMO_TENANT, 'Accountant']]);
    const r = await demoResetRoute.POST();
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ success: false, message: 'Only the demo workspace owner can reset this company.' });
    expect(S.rpcCalls).toBe(0);
  });
  it('SEC-060 command rate limiting [documented: none in the app; only the 5-per-15-min password throttle exists]', () => {
    const route = src('src/app/api/workspace/route.ts');
    expect(route).not.toMatch(/rate|throttle|429/i);
    expect(src('src/lib/password.ts')).toContain('const LIMIT = 5;');
  });
  it('SEC-064 no secrets in tracked files; .env* ignored except .env.example', () => {
    expect(src('.gitignore')).toMatch(/^\.env\*$/m);
    expect(src('.gitignore')).toMatch(/^!\.env\.example$/m);
    const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(tracked.filter(f => /(^|\/)\.env/.test(f))).toEqual(['.env.example']);
    const hits = execSync(`git grep -I -n -E "eyJhbGciOiJ[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9]{10,}|service_role\\"?\\s*[:=]\\s*\\"ey|postgres(ql)?://[^:@/ ]+:[^@/ ]{6,}@" -- . ':!package-lock.json' || true`, { cwd: root, encoding: 'utf8' });
    expect(hits.trim()).toBe('');
  });
  it('SEC-065 audit log cannot be edited via API: no audit command; audit is append-only; members cannot write audit_events', async () => {
    expect(commandSchema.shape.type.options.filter(t => /audit/.test(t))).toEqual([]);
    const w1 = run(freshCompany(), 'save_company', { name: 'Audit One', address: 'x' }).workspace;
    const w2 = run(w1, 'save_company', { name: 'Audit Two', address: 'x' }).workspace;
    expect(w2.audit.slice(0, w1.audit.length)).toEqual(w1.audit);
    expect(await asError('authenticated', OWNER, `update public.audit_events set detail = 'x'`)).toMatch(/permission denied/);
    expect(await asError('authenticated', OWNER, `delete from public.audit_events`)).toMatch(/permission denied/);
  });
  it('SEC-066 audit records actor id, action and time, never payload secrets [defect: audit stores the editable display name, not the user id]', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'pk');
    const user = { ...ME, id: 'u-sec-066', email: 'sec066@qa.example' }; S.passwords = { [user.email]: [user.id, 'audit-pass-1'] };
    const w = company(T); seed([w], [[T, 'Owner']], user);
    expect((await POST(cmd('set_modules', { enabled: w.modules.filter(m => m !== 'payroll') }, { confirmPassword: 'audit-pass-1' }))).status).toBe(200);
    const entry = stored().audit.at(-1)!;
    expect(JSON.stringify(stored())).not.toContain('audit-pass-1');
    expect(entry).toMatchObject({ action: 'set_modules', role: 'Owner' });
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(entry.actor).toBe(user.id);
  });
  it('SEC-067 error responses carry no stack traces', async () => {
    seed([company(T)], [[T, 'Owner']]);
    const bodies = [await POST('{bad json'), await POST(cmd('nope')), await POST(cmd('create_document', { kind: 'sales_invoice' })), await POST(cmd('save_company', { name: 'x' }))];
    for (const b of bodies) {
      expect(b.status).toBe(400);
      expect(JSON.stringify(b.json)).not.toMatch(/\n\s+at |\.ts:\d+|node_modules/);
    }
  });
  it('SEC-068 an unexpected engine exception returns 500 with a generic message and is logged server-side [defect: returns 400 with the raw TypeError text, nothing logged]', async () => {
    const broken = { ...company(T), documents: null } as unknown as Workspace;
    seed([broken], [[T, 'Owner']]);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await POST(cmd('submit_document', { id: 'x' }));
    expect(r.json.message).not.toMatch(/Cannot read|null|undefined/);
    expect(r.status).toBe(500);
    expect(log).toHaveBeenCalled();
  });
  it('SEC-070 RLS enabled and forced on every public table that members can read', async () => {
    const rows = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; granted: boolean }>(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'select') as granted
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`);
    const exposed = rows.rows.filter(r => r.granted);
    expect(exposed.length).toBeGreaterThan(15);
    expect(exposed.filter(r => !r.relrowsecurity || !r.relforcerowsecurity).map(r => r.relname)).toEqual([]);
    expect(rows.rows.filter(r => !r.relrowsecurity).map(r => r.relname)).toEqual(['schema_migrations']);
  });
  it('SEC-071 private.sync_projection is not callable by anon or authenticated', async () => {
    expect(await asError('anon', null, `select private.sync_projection('${DEMO_TENANT}', '{}'::jsonb, false)`)).toMatch(/permission denied/);
    expect(await asError('authenticated', OWNER, `select private.sync_projection('${DEMO_TENANT}', '{}'::jsonb, false)`)).toMatch(/permission denied/);
  });
  it('SEC-072 commit_workspace is executable only by service_role', async () => {
    expect(await asError('anon', null, `select public.commit_workspace('${PARTNER_TENANT}', 0, '{}'::jsonb)`)).toMatch(/permission denied/);
    expect(await asError('authenticated', OUTSIDER, `select public.commit_workspace('${PARTNER_TENANT}', 0, '{}'::jsonb)`)).toMatch(/permission denied/);
    const priv = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(`select has_function_privilege('anon', 'public.commit_workspace(uuid,integer,jsonb,boolean)', 'execute') as anon, has_function_privilege('authenticated', 'public.commit_workspace(uuid,integer,jsonb,boolean)', 'execute') as authenticated, has_function_privilege('service_role', 'public.commit_workspace(uuid,integer,jsonb,boolean)', 'execute') as service`);
    expect(priv.rows[0]).toEqual({ anon: false, authenticated: false, service: true });
  });
  it('SEC-073 demo reset guard: deleting a tenant with posted journals fails without the flag and succeeds with it', async () => {
    await expect(db.query('delete from public.tenants where id = $1', [DEMO_TENANT])).rejects.toThrow(/Posted journals are immutable/);
    let deleted = -1;
    await db.transaction(async tx => {
      await tx.query(`select set_config('app.demo_reset', 'on', true)`);
      await tx.query('delete from public.tenants where id = $1', [DEMO_TENANT]);
      deleted = (await tx.query<{ n: number }>('select count(*)::int as n from public.journals where tenant_id = $1', [DEMO_TENANT])).rows[0].n;
      await tx.rollback();
    });
    expect(deleted).toBe(0);
    expect((await db.query<{ n: number }>('select count(*)::int as n from public.tenants where id = $1', [DEMO_TENANT])).rows[0].n).toBe(1);
  });
  it('SEC-074 member removed → refused on the very next request', async () => {
    seed([company(T)], [[T, 'Owner']]);
    expect((await POST(cmd('save_company', { name: 'Before Co', address: 'x' }))).status).toBe(200);
    S.memberships = [];
    expect((await POST(cmd('save_company', { name: 'After Co', address: 'x' }))).status).toBe(403);
    expect(stored().company.name).toBe('Before Co');
  });
  it('SEC-075 role changed → next request uses the new role', async () => {
    seed([company(T)], [[T, 'Accountant']]);
    expect((await POST(cmd('create_journal', { date: today(), memo: 'Top up', lines: [{ account: '1000', debit: '5', credit: '0' }, { account: '3000', debit: '0', credit: '5' }] }))).status).toBe(200);
    S.memberships[0].role = 'Salesperson';
    const r = await POST(cmd('create_journal', { date: today(), memo: 'Top up', lines: [{ account: '1000', debit: '5', credit: '0' }, { account: '3000', debit: '0', credit: '5' }] }));
    expect(r.json.message).toBe('Your role does not permit this action.');
  });
  it('SEC-076 view-as-role preview cannot elevate: the server uses the membership role, ignoring any role in the body', async () => {
    seed([company(T)], [[T, 'Salesperson']]);
    const r = await POST(cmd('create_journal', { date: today(), memo: 'Elevate', lines: [{ account: '1000', debit: '5', credit: '0' }, { account: '3000', debit: '0', credit: '5' }] }, { role: 'Owner', actor: { role: 'Owner', branchIds: [] } }));
    expect(r.json.message).toBe('Your role does not permit this action.');
    expect(src('src/components/workbench.tsx')).toContain("JSON.stringify({type,payload,idempotencyKey:crypto.randomUUID(),...(options?.confirmPassword?{confirmPassword:options.confirmPassword}:{})})");
  });
  it('SEC-077 branch ids changed → scoping updates on the next request', async () => {
    seed([demo], [[DEMO_TENANT, 'Accountant', { branch_ids: ['karachi'] }]]);
    const get = async () => ((await (await workspaceRoute.GET(new Request(`http://localhost/api/workspace?tenant=${DEMO_TENANT}`))).json()) as { workspace: Workspace }).workspace.warehouses.map(x => x.id).sort();
    expect(await get()).toEqual(['khi-main', 'khi-port']);
    S.memberships[0].branch_ids = ['lahore'];
    expect(await get()).toEqual(['lhe-main']);
  });
  it('SEC-078 document id of another tenant in submit_document → "Document not found."', () => {
    const [, otherDraft] = salesInvoiceDraft(company(T2));
    refused(freshCompany(), 'submit_document', { id: otherDraft }, 'Document not found.');
  });
  it('SEC-079 party id of another tenant → not found', () => {
    let w = freshCompany(); let item: string; [w, item] = withItem(w, {}, { quantity: '1', cost: '1' });
    const [, otherParty] = withParty(company(T2));
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: otherParty, warehouseId: w.warehouses[0].id, date: today(), dueDate: today(), lines: [{ itemId: item, quantity: '1', price: '1' }] }, 'Party not found.');
  });
  it('SEC-080 ids are random UUID v4 and lookups stay scoped [documented]', () => {
    const [w, doc] = salesInvoiceDraft(freshCompany());
    expect(doc).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(w.parties.every(p => /^[0-9a-f-]{36}$/.test(p.id))).toBe(true);
  });
  it('SEC-081 print route with another tenant document id → not found', async () => {
    const victim = demo; const d = victim.documents.find(x => x.kind === 'sales_invoice')!;
    seed([company(T), victim], [[T, 'Owner']]);
    const attempt = async (tenant: string) => { try { await PrintPage({ params: Promise.resolve({ kind: 'sales_invoice', id: d.id }), searchParams: Promise.resolve({ tenant }) }); return 200; } catch (e) { return String((e as { digest?: string }).digest).includes('404') ? 404 : 500; } };
    expect(await attempt(DEMO_TENANT)).toBe(404);
    expect(await attempt(T)).toBe(404);
  });
  it('SEC-082 member:create, company:reset and qa:tenant fail without their env secrets', () => {
    expect(src('scripts/create-member.ts')).toContain("if (!url || !key || !db || !email || !password) throw new Error(");
    expect(src('scripts/reset-company.ts')).toContain("if (!url || !key || !db || !email) throw new Error(");
    expect(src('scripts/create-qa-tenant.ts')).toContain("if (!url || !ownerId) throw new Error('DATABASE_URL and BOOTSTRAP_OWNER_ID are required.')");
  });
  it('SEC-083 company:reset only touches the member\'s own non-demo company', () => {
    const s = src('scripts/reset-company.ts');
    expect(s).toContain("where m.user_id = ${user.id} and m.role = 'Owner' and not t.is_demo");
    const writes = [...s.matchAll(/tx`(update|delete|insert|select private)[^`]*`/g)].map(m => m[0]);
    expect(writes).toHaveLength(3);
    for (const sql of writes) expect(sql).toContain('${tenantId}');
  });
  it('SEC-084 qa:tenant only touches the QA tenant id', () => {
    const s = src('scripts/create-qa-tenant.ts');
    const statements = [...s.matchAll(/tx`([^`]*)`/g)].map(m => m[1]).filter(x => !x.startsWith('select set_config'));
    expect(statements).toHaveLength(5);
    for (const sql of statements) expect(sql).toContain('${QA_TENANT}');
    expect(s).toContain("export const QA_TENANT = '33333333-3333-4333-8333-333333333333';");
  });
  it('SEC-088 clickjacking: framing blocked by X-Frame-Options DENY', () => {
    expect(src('next.config.ts')).toContain('{key:"X-Frame-Options",value:"DENY"}');
  });
  it('SEC-089 open redirect in next= is blocked for every variant [defect: "/\\evil.com" redirects off-site]', async () => {
    for (const next of ['https://evil.com', '//evil.com', '/\\evil.com', '/\\/evil.com', '%2F%2Fevil.com']) {
      const r = await callbackRoute.GET(new Request(`http://localhost/auth/callback?next=${encodeURIComponent(next)}`));
      expect(new URL(r.headers.get('location')!).host, next).toBe('localhost');
    }
  });
  it('SEC-090 100 memberships: page still loads with all of them in the switcher', async () => {
    const tenants = Array.from({ length: 100 }, (_, i) => company(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `Co ${i}`));
    seed(tenants, tenants.map(t => [t.tenantId, 'Owner'] as [string, Role]));
    const el = await EntryPage({ searchParams: Promise.resolve({}) }) as ReactElement<{ memberships: unknown[]; initialWorkspace: Workspace }>;
    expect(el.props.memberships).toHaveLength(100);
    expect(el.props.initialWorkspace.tenantId).toBe(tenants[0].tenantId);
  });
  it('SEC-091 Unicode look-alikes in duplicate checks [documented: names are compared with trim + toLowerCase only; NFC "Café" and NFD "Café" are both accepted]', () => {
    let w = freshCompany();
    [w] = withParty(w, 'customer', { name: 'Café Traders' });
    expect(() => withParty(w, 'customer', { name: ' CAFÉ traders ' })).toThrow('already exists');
    const [after] = withParty(w, 'customer', { name: 'Café Traders' });
    expect(after.parties.filter(p => p.name.normalize('NFC') === 'Café Traders')).toHaveLength(2);
  });
  it('SEC-092 command replay after commit: no double posting and no second commit [case-corrected: a replay returns the original recordId and message (D-17)]', async () => {
    let w = company(T); let item: string, cust: string, draft: string; [w, item] = withItem(w, {}, { quantity: '5', cost: '1' }); [w, cust] = withParty(w);
    [w, draft] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '10' }], {}, false);
    seed([w], [[T, 'Owner']]);
    const c = cmd('submit_document', { id: draft });
    const original = await POST(c);
    expect(original.status).toBe(200);
    const journals = stored().journals.length; const rpc = S.rpcCalls;
    const replay = await POST(c);
    expect([replay.json.recordId, replay.json.message]).toEqual([original.json.recordId, original.json.message]);
    expect(S.rpcCalls).toBe(rpc);
    expect(stored().journals).toHaveLength(journals);
  });
  it('SEC-093 timeout mid-commit (committed, error returned): retry with the same key is safe [case-corrected: a replay returns the original recordId and message (D-17)]', async () => {
    let w = company(T); let item: string, cust: string, draft: string; [w, item] = withItem(w, {}, { quantity: '5', cost: '1' }); [w, cust] = withParty(w);
    [w, draft] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '10' }], {}, false);
    seed([w], [[T, 'Owner']]); S.rpcMode = 'commit-then-error';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = cmd('submit_document', { id: draft });
    const first = await POST(c);
    expect(first.status).toBe(500);
    S.rpcMode = 'normal';
    const retry = await POST(c);
    expect(retry.status).toBe(200);
    expect([retry.json.recordId, retry.json.message]).toEqual([draft, expect.stringContaining('submitted. Related balances updated.')]);
    expect(stored().journals.filter(j => j.sourceId === draft)).toHaveLength(1);
  });
  it('SEC-094 today() uses Asia/Karachi, not the server clock zone', () => {
    expect(businessToday(new Date('2026-10-13T19:30:00Z'))).toBe('2026-10-14');
    expect(businessToday(new Date('2026-10-13T18:59:59Z'))).toBe('2026-10-13');
  });
  it('SEC-095 server logs carry no PII or payloads [documented: only "Empty workspace command body" (method/length/type) and database rejection messages are logged]', () => {
    const files = execSync('git ls-files src', { cwd: root, encoding: 'utf8' }).split('\n').filter(f => /\.(ts|tsx)$/.test(f));
    const logs = files.flatMap(f => [...src(f).matchAll(/console\.(log|error|warn|info)\(([^;]*)\)/g)].map(m => `${f}: ${m[2]}`));
    expect(logs).toEqual([
      "src/app/api/workspace/route.ts: 'Workspace commit rejected by database', message",
      "src/app/api/workspace/route.ts: 'Empty workspace command body', { method: request.method, length: request.headers.get('content-length'), type: request.headers.get('content-type') }",
    ]);
  });
  it('SEC-099 role matrix: RLS role sets in the migrations match access.ts', () => {
    const mig = src('supabase/migrations/202610120001_transactional_projection.sql');
    const set = (name: string) => mig.match(new RegExp(`${name} constant text := 'array\\[(.*?)\\]`))![1].replace(/''/g, '').split(',').sort();
    const access = src('src/modules/erp/access.ts');
    expect(set('ledger')).toEqual(['Accountant', 'Auditor', 'Owner']);
    expect(access).toContain('export const ledgerRoles: Role[] = ["Owner", "Accountant", "Auditor"];');
    expect(set('payroll')).toEqual(['Accountant', 'Auditor', 'Owner', 'Payroll Administrator']);
    expect(access).toContain('const payRoles: Role[] = [...ledgerRoles, "Payroll Administrator"];');
    expect(set('recovery')).toEqual(['Accountant', 'Auditor', 'Owner', 'Recovery Officer', 'Sales Manager']);
    expect(access).toContain('["Sales Manager", "Recovery Officer"].includes(role) || canReadLedger(role) ? source.followUps');
  });
  it('SEC-100 eight roles × scripted commands: allow/deny matrix (company, branding and modules are Settings, Owner/Accountant only after setup)', () => {
    let base = freshCompany(); let item: string, cust: string, supp: string, draft: string;
    [base, item] = withItem(base, {}, { quantity: '50', cost: '1' }); [base, cust] = withParty(base); [base, supp] = withParty(base, 'supplier');
    const e = run(base, 'save_employee', { name: 'Rep One', role: 'Rep', territory: 'K', salary: '1', allowance: '0', deduction: '0', attendance: 30, active: true }); base = e.workspace;
    [base, draft] = withDocument(base, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '10', employeeId: e.recordId }], {}, false);
    let inv: string; [base, inv] = withDocument(base, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '10' }]);
    const wh = base.warehouses[0].id;
    const line = (extra: Row = {}) => ({ itemId: item, quantity: '1', price: '10', discount: '0', taxRate: '0', employeeId: '', splits: [], ...extra });
    const commands: Record<string, [string, Row]> = {
      save_item: ['save_item', { sku: 'MX-1', name: 'Matrix item', category: '', hsCode: '', unit: 'pcs', price: '1', cost: '1', weight: '0', volume: '0', reorderLevel: 0 }],
      sale: ['create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: wh, date: today(), dueDate: today(), lines: [line({ employeeId: e.recordId })] }],
      purchase: ['create_document', { kind: 'purchase_order', partyId: supp, warehouseId: wh, date: today(), dueDate: today(), lines: [line()] }],
      submit: ['submit_document', { id: draft }],
      receipt: ['create_receipt', { partyId: cust, date: today(), amount: '10', method: 'cash', dueDate: today(), allocations: [{ invoiceId: inv, amount: '10' }] }],
      journal: ['create_journal', { date: today(), memo: 'Matrix', lines: [{ account: '1000', debit: '1', credit: '0' }, { account: '3000', debit: '0', credit: '1' }] }],
      lock: ['set_period', { month: '2026-01', locked: true }],
      payroll: ['create_payroll', { month: '2026-10' }],
      company: ['save_company', { name: 'Renamed Co', address: 'x' }],
      branding: ['save_branding', { template: 'standard', accent: '#000000', footer: 'x' }],
      modules: ['set_modules', { enabled: ['sales', 'reports'] }],
    };
    const allowed: Record<Role, string[]> = {
      Owner: ['save_item', 'sale', 'purchase', 'submit', 'receipt', 'journal', 'lock', 'payroll', 'company', 'branding', 'modules'],
      Accountant: ['save_item', 'sale', 'purchase', 'submit', 'receipt', 'journal', 'lock', 'payroll', 'company', 'branding', 'modules'],
      'Sales Manager': ['sale', 'submit'],
      Salesperson: ['sale'],
      'Recovery Officer': ['receipt'],
      'Warehouse Manager': ['save_item'],
      'Payroll Administrator': ['payroll'],
      Auditor: [],
    };
    const matrix: Record<string, string[]> = {};
    for (const role of roles) {
      matrix[role] = [];
      for (const [name, [type, payload]] of Object.entries(commands)) {
        let message = '';
        try { run(base, type, payload, actor(role, { employeeId: e.recordId })); } catch (err) { message = (err as Error).message; }
        const roleRefusal = /Your role|role cannot|Warehouse users can|Salespeople can|Recovery officers cannot|require manager approval/.test(message);
        if (!roleRefusal) matrix[role].push(name);
      }
    }
    expect(matrix).toEqual(allowed);
  });

  const todo: [string, string][] = [
    ['SEC-056', '[manual] logo signed URL reused after its 600 s expiry fails (hosted Storage)'],
    ['SEC-061', '[manual] session fixation: sign-in issues a new session (hosted Supabase Auth)'],
    ['SEC-062', '[manual] logout invalidates the refresh token (hosted Supabase Auth)'],
    ['SEC-063', '[manual] password reset token is single-use (hosted Supabase Auth)'],
    ['SEC-069', '[manual] npm audit: no high/critical (needs the npm registry)'],
    ['SEC-085', '[manual] Vercel env exposes no service key as NEXT_PUBLIC_*'],
    ['SEC-086', '[manual] HTTPS only with HSTS on the deployed host'],
    ['SEC-087', '[manual] production cookies carry Secure'],
    ['SEC-096', '[manual] backup/restore of the production snapshot table, then rebuild the projection'],
    ['SEC-097', '[manual] OWASP ZAP baseline scan: no high alerts'],
    ['SEC-098', '[manual] auth brute force hits hosted Supabase limits'],
  ];
  for (const [id, title] of todo) it.todo(`${id} ${title}`);
});
