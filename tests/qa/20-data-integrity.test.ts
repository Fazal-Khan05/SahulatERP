/**
 * SQA pack 20 — Data integrity, concurrency, failure recovery, migrations (DAT).
 * Executed here: the pure engine (money, idempotency, numbering, validation, fuzzing), the real migrations and
 * commit_workspace/sync_projection in PGlite (same stubs as tests/domain/database.test.ts), the codec, the
 * workspace/branding route handlers with a controllable workspace-store, and the client retry function
 * (postCommand) extracted from workbench.tsx and run against a fake fetch.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { D, actor, buildDemoWorkspace, execute, expectInvariants, freshCompany, invariants, money, outstanding, owner, refused, run, sum, today, withDocument, withItem, withParty } from './helpers';
import { allocate } from '../../src/modules/erp/money';
import { businessToday } from '../../src/modules/erp/dates';
import { decodeWorkspace } from '../../src/modules/erp/codec';
import { documentView } from '../../src/modules/erp/documents';
import { stock } from '../../src/modules/erp/engine';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { DEMO_TENANT, PARTNER_TENANT, type Workspace } from '../../src/modules/erp/types';

const S = vi.hoisted(() => ({
  read: (async () => { throw new Error('unset'); }) as (tenant: string) => Promise<{ workspace: Workspace; revision: number }>,
  commits: [] as { tenant: string; expected: number; workspace: Workspace }[], commitResult: true as boolean, uploadError: false,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/workspace-store', () => ({
  requireMember: async (tenantId: string | null) => { if (!tenantId) throw new Error('TENANT_REQUIRED'); return { actor: { id: 'u-dat', name: 'Dat Owner', role: 'Owner', branchIds: [] }, user: { id: 'u-dat', email: 'dat@qa.example' } }; },
  readWorkspace: (tenant: string) => S.read(tenant),
  commitWorkspace: async (tenant: string, expected: number, workspace: Workspace) => { S.commits.push({ tenant, expected, workspace }); return S.commitResult; },
}));
vi.mock('@/lib/password', () => ({ verifyPassword: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => ({ storage: { from: () => ({ remove: async () => ({}), upload: async () => ({ error: S.uploadError ? { message: 'fetch failed' } : null }) }) } }) }));
vi.mock('@/lib/branding-store', () => import('../../src/lib/branding-store'));
vi.mock('@/modules/erp/access', () => import('../../src/modules/erp/access'));
vi.mock('@/modules/erp/engine', () => import('../../src/modules/erp/engine'));
vi.mock('@/modules/erp/modules', () => import('../../src/modules/erp/modules'));
import * as workspaceRoute from '../../src/app/api/workspace/route';
import * as uploadRoute from '../../src/app/api/branding/upload/route';

const root = resolve(__dirname, '../..');
const wbSource = readFileSync(resolve(root, 'src/components/workbench.tsx'), 'utf8');
const line = (itemId: string, quantity: string, price: string, extra: Record<string, unknown> = {}) => ({ itemId, quantity, price, ...extra });
function trading(stockQty = '100') {
  let w = freshCompany(); let item: string, item2: string, cust: string, supp: string;
  [w, item] = withItem(w, { cost: '10' }, { quantity: stockQty, cost: '10' }); [w, item2] = withItem(w, { cost: '5' }, { quantity: stockQty, cost: '5' });
  [w, cust] = withParty(w); [w, supp] = withParty(w, 'supplier');
  return { w, item, item2, cust, supp };
}
function postCommandWith(responses: (() => Response)[]) {
  const start = wbSource.indexOf('async function postCommand(');
  const fn = wbSource.slice(start, wbSource.indexOf('\n  async function command(', start));
  const calls: string[] = [];
  const fetch = async (_: string, init: { body: string }) => { calls.push(init.body); return responses[Math.min(calls.length - 1, responses.length - 1)](); };
  const post = new Function('fetch', 'workspace', 'setTimeout', `${stripTypeScriptTypes(fn)}; return postCommand;`)(fetch, { tenantId: 't' }, (r: () => void) => r()) as (body: string) => Promise<{ response: Response; result: Record<string, unknown> }>;
  return { post, calls };
}
const allStrings = (v: unknown, out: [string, unknown][] = [], path = ''): [string, unknown][] => {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) allStrings(x, out, `${path}.${k}`); else out.push([path, v]);
  return out;
};

// ---------- PGlite with the real migrations ----------
const OWNER = '00000000-0000-4000-8000-000000000001';
const QA = '44444444-4444-4444-8444-444444444444';
const QA2 = '33333333-3333-4333-8333-333333333333';
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
const migrations = () => { const dir = resolve(root, 'supabase/migrations'); return readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => [f, readFileSync(resolve(dir, f), 'utf8')] as const); };
const commit = (tenant: string, expected: number, w: Workspace, rebuild = false) => db.query<{ revision: number | null }>('select public.commit_workspace($1, $2, $3::jsonb, $4) as revision', [tenant, expected, JSON.stringify(w), rebuild]).then(r => r.rows[0].revision);
const snapshot = async (tenant: string) => { const r = (await db.query<{ data: Workspace; revision: number }>('select data, revision from public.workspace_snapshots where tenant_id = $1', [tenant])).rows[0]; return { workspace: decodeWorkspace(r.data), revision: r.revision }; };
const count = async (table: string, tenant: string) => (await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where tenant_id = $1`, [tenant])).rows[0].n;
const projectionTables = ['documents', 'journals', 'journal_lines', 'stock_movements', 'receipts', 'parties', 'items', 'commissions', 'commission_movements', 'audit_events', 'warehouses', 'branches'];
const others = async (except: string) => Object.fromEntries(await Promise.all(projectionTables.map(async t => [t, (await db.query<{ n: number }>(`select count(*)::int as n from public.${t} where tenant_id <> $1`, [except])).rows[0].n] as const)));
async function apply(tenant: string, steps: [string, Record<string, unknown>][]) {
  for (const [type, payload] of steps) { const { workspace, revision } = await snapshot(tenant); const r = run(workspace, type, payload); expect(await commit(tenant, revision, r.workspace)).toBe(revision + 1); }
  return snapshot(tenant);
}
async function projectionMatches(tenant: string) {
  const { workspace: w } = await snapshot(tenant);
  expect(await count('documents', tenant)).toBe(w.documents.length);
  expect(await count('journals', tenant)).toBe(w.journals.length);
  expect(await count('journal_lines', tenant)).toBe(w.journals.reduce((n, j) => n + j.lines.length, 0));
  expect(await count('stock_movements', tenant)).toBe(w.stockMoves.length);
  expect(await count('receipts', tenant)).toBe(w.receipts.length);
  expect(await count('parties', tenant)).toBe(w.parties.length);
  expect(await count('items', tenant)).toBe(w.items.length);
  expect(await count('audit_events', tenant)).toBe(w.audit.length);
  const totals = (await db.query<{ id: string; total: string }>('select id, total::text as total from public.documents where tenant_id = $1', [tenant])).rows;
  expect(Object.fromEntries(totals.map(r => [r.id, money(r.total)]))).toEqual(Object.fromEntries(w.documents.map(d => [d.id, d.total])));
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(supabaseStubs);
  const files = migrations();
  for (const [f, sql] of files) if (f < '202610120001') await db.exec(sql);
  const { modules: _m, setup: _s, branding: _b, ...demo } = buildDemoWorkspace();
  await db.query('insert into auth.users (id) values ($1)', [OWNER]);
  await db.query(`insert into public.tenants (id, name, is_demo) values ($1, 'Demo', true), ($2, 'Partner', false), ($3, 'QA Co', false)`, [DEMO_TENANT, PARTNER_TENANT, QA]);
  await db.query(`insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'Owner'), ($3, $2, 'Owner')`, [DEMO_TENANT, OWNER, QA]);
  await db.query(`insert into public.workspace_snapshots (tenant_id, revision, data) values ($1, $2, $3::jsonb), ($4, 0, to_jsonb($5::text))`, [DEMO_TENANT, demo.revision, JSON.stringify(demo), PARTNER_TENANT, JSON.stringify(blankWorkspace(false))]);
  for (const [f, sql] of files) if (f >= '202610120001') await db.exec(sql);
  const qa = { ...freshCompany(), tenantId: QA };
  await db.query('insert into public.workspace_snapshots (tenant_id, revision, schema_version, data) values ($1, $2, 1, $3::jsonb)', [QA, qa.revision, JSON.stringify(qa)]);
  await db.query('select private.sync_projection($1, data, true) from public.workspace_snapshots where tenant_id = $1', [QA]);
}, 60_000);
beforeEach(() => { S.commits = []; S.commitResult = true; S.uploadError = false; });

describe('20 data integrity', () => {
  it('DAT-001 money is stored as 4-dp decimal strings; no floats anywhere in the snapshot', () => {
    const w = buildDemoWorkspace();
    const numbers = allStrings(JSON.parse(JSON.stringify(w))).filter(([, v]) => typeof v === 'number');
    expect(numbers.filter(([, v]) => !Number.isInteger(v))).toEqual([]);
    expect([...new Set(numbers.map(([p]) => p.split('.').at(-1)))].sort()).toEqual(['attendance', 'reorderLevel', 'revision', 'schemaVersion', 'step', 'terms']);
    const moneyFields = allStrings(JSON.parse(JSON.stringify({ d: w.documents.map(d => [d.net, d.tax, d.total, d.paid, d.returned]), j: w.journals.flatMap(j => j.lines.map(l => [l.debit, l.credit])), s: w.stockMoves.map(m => m.value), c: w.commissions.map(c => [c.earned, c.released, c.paid]) })));
    expect(moneyFields.filter(([, v]) => !/^-?\d+\.\d{4}$/.test(String(v)))).toEqual([]);
  });
  it('DAT-002 0.1 summed ten times is exactly 1.0000 (helpers and an invoice)', () => {
    expect(money(sum(Array(10).fill('0.1')))).toBe('1.0000');
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '10', '0.1')]);
    expect(w.documents.find(d => d.id === doc)!.total).toBe('1.0000');
  });
  it('DAT-003 allocating 100 across 3 lines is exact [case-corrected: 33.3333 / 33.3333 / 33.3334 — the last line takes the remainder]', () => {
    const parts = allocate('100', ['1', '1', '1']);
    expect(parts).toEqual(['33.3333', '33.3333', '33.3334']);
    expect(money(sum(parts))).toBe('100.0000');
  });
  it('DAT-004 quantity precision 4 dp: 0.00005 rounds consistently between the document and stock [defect: line keeps 0.00005, stock move is 0.0001]', () => {
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '0.00005', '100')]);
    const d = w.documents.find(x => x.id === doc)!;
    const moved = w.stockMoves.find(m => m.sourceId === doc)!;
    expect(D(moved.quantity).abs().toFixed(4)).toBe(D(d.lines[0].quantity).toFixed(4));
    expect(D(moved.quantity).abs().eq(d.lines[0].quantity)).toBe(true);
  });
  it('DAT-005 FX precision [documented: fxRate 280.12345 is stored as entered and used at full precision; posted PKR amounts round half-up to 4 dp]', () => {
    const t = trading(); const [w, bill] = withDocument(t.w, 'supplier_invoice', t.supp, [line(t.item, '1', '1')], { currency: 'USD', fxRate: '280.12345' });
    const doc = w.documents.find(d => d.id === bill)!;
    expect(doc.fxRate).toBe('280.12345');
    const j = w.journals.find(x => x.sourceId === bill)!;
    expect(j.lines.find(l => l.account === '2000')!.credit).toBe('280.1235');
  });
  it('DAT-006 tax is computed per line, summed, then rounded once; print totals agree', () => {
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '0.33335', { taxRate: '18' }), line(t.item2, '1', '0.33335', { taxRate: '18' })]);
    const d = w.documents.find(x => x.id === doc)!;
    expect(d.tax).toBe(money(D('0.33335').mul(18).div(100).mul(2)));
    const view = documentView(w, d);
    expect(view.totals.find(r => r.label === 'Sales tax 18%')!.value).toBe(d.tax);
    expect(D(d.net).plus(d.tax).toFixed(4)).toBe(d.total);
  });
  it('DAT-007 negative zero is never stored', () => {
    const t = trading(); let w = t.w; let doc: string;
    [w, doc] = withDocument(w, 'sales_invoice', t.cust, [line(t.item, '2', '50')]);
    w = run(w, 'return_document', { id: doc, date: today(), lines: [{ lineId: w.documents.find(d => d.id === doc)!.lines[0].id, quantity: '2' }] }).workspace;
    w = run(w, 'stock_adjust', { itemId: t.item, warehouseId: w.warehouses[0].id, quantity: '-1', reason: 'QA', date: today() }).workspace;
    expect(JSON.stringify(w)).not.toContain('"-0.0000"');
    expect(JSON.stringify(buildDemoWorkspace())).not.toContain('"-0.0000"');
  });
  it('DAT-008 very large values: 1e11 stored; one-trillion guard refuses 1e12', () => {
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '100000000000')], { }, false);
    expect(w.documents.find(d => d.id === doc)!.total).toBe('100000000000.0000');
    refused(t.w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: t.w.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '1', '1000000000000')] }, /Enter a valid number below one trillion/);
  });
  it('DAT-009 retrying create_document with the same key creates one document', () => {
    const t = trading();
    const c = { type: 'create_document', payload: { kind: 'sales_invoice', partyId: t.cust, warehouseId: t.w.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '1', '1')] }, idempotencyKey: 'dat-009-retry' };
    const once = execute(t.w, c, owner).workspace;
    expect(execute(once, c, owner).workspace.documents).toHaveLength(1);
  });
  it('DAT-010 retrying submit with the same key posts one journal and one stock move', () => {
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '1')], {}, false);
    const c = { type: 'submit_document', payload: { id: doc }, idempotencyKey: 'dat-010-retry' };
    const twice = execute(execute(w, c, owner).workspace, c, owner).workspace;
    expect(twice.journals.filter(j => j.sourceId === doc)).toHaveLength(1);
    expect(twice.stockMoves.filter(m => m.sourceId === doc)).toHaveLength(1);
  });
  it('DAT-011 a client retry after the server committed returns the original result [defect: replay returns recordId "" and "This operation was already completed."]', async () => {
    const t = trading(); let current = t.w; let rev = current.revision;
    S.read = async () => ({ workspace: current, revision: rev });
    const body = JSON.stringify({ type: 'create_document', payload: { kind: 'sales_invoice', partyId: t.cust, warehouseId: t.w.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '1', '1')] }, idempotencyKey: 'dat-011-retry-key' });
    const first = await (await workspaceRoute.POST(new Request('http://localhost/api/workspace', { method: 'POST', headers: { 'x-tenant-id': 't' }, body }))).json() as { recordId: string };
    current = S.commits.at(-1)!.workspace; rev++;
    const retry = await (await workspaceRoute.POST(new Request('http://localhost/api/workspace', { method: 'POST', headers: { 'x-tenant-id': 't' }, body }))).json() as { recordId: string; message: string };
    expect(current.documents).toHaveLength(1);
    expect(retry.recordId).toBe(first.recordId);
  });
  it('DAT-012 two writers commit from the same revision: one wins, the other is refused, retry on fresh state applies both', async () => {
    const { workspace, revision } = await snapshot(QA);
    const a = run(workspace, 'save_party', { name: 'Writer A', type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 0, customerClass: '' }).workspace;
    const b = run(workspace, 'save_party', { name: 'Writer B', type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 0, customerClass: '' }).workspace;
    expect(await commit(QA, revision, a)).toBe(revision + 1);
    expect(await commit(QA, revision, b)).toBeNull();
    const fresh = await snapshot(QA);
    const b2 = run(fresh.workspace, 'save_party', { name: 'Writer B', type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 0, customerClass: '' }).workspace;
    expect(await commit(QA, fresh.revision, b2)).toBe(revision + 2);
    const names = (await snapshot(QA)).workspace.parties.map(p => p.name);
    expect(names).toEqual(expect.arrayContaining(['Writer A', 'Writer B']));
  });
  it('DAT-013 10 invoice creations get 10 distinct, gap-free numbers [documented: requests are serialised by the revision check]', () => {
    let { w } = trading(); const t = trading(); w = t.w;
    for (let i = 0; i < 10; i++) [w] = withDocument(w, 'sales_invoice', t.cust, [line(t.item, '1', '1')], {}, false);
    const year = today().slice(0, 4);
    expect(w.documents.map(d => d.number)).toEqual(Array.from({ length: 10 }, (_, i) => `INV-${year}-${String(i + 1).padStart(4, '0')}`));
  });
  it('DAT-014 receipt vs return on the same invoice [case-corrected: a receipt above the outstanding is refused; a return after full payment is allowed and leaves a customer credit (negative outstanding) by design]', () => {
    const t = trading(); let [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '2', '50')]);
    w = run(w, 'create_receipt', { partyId: t.cust, date: today(), amount: '100', method: 'cash', dueDate: today(), allocations: [{ invoiceId: doc, amount: '100' }] }).workspace;
    refused(w, 'create_receipt', { partyId: t.cust, date: today(), amount: '1', method: 'cash', dueDate: today(), allocations: [{ invoiceId: doc, amount: '1' }] }, 'Invalid invoice allocation.');
    w = run(w, 'return_document', { id: doc, date: today(), lines: [{ lineId: w.documents.find(d => d.id === doc)!.lines[0].id, quantity: '1' }] }).workspace;
    expect(outstanding(w.documents.find(d => d.id === doc)!)).toBe('-50.0000');
    expectInvariants(w);
  });
  it('DAT-015 two stock-outs against the same stock: the second is refused when insufficient', () => {
    const t = trading('3'); const [w] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '2', '1')]);
    const second = run(w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: w.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '2', '1', { discount: '0', taxRate: '0', employeeId: '', splits: [] })] });
    refused(second.workspace, 'submit_document', { id: second.recordId }, /Insufficient stock for .* Requested: 2, available: 1\./);
  });
  it('DAT-016 set_stock_quantity with a stale expected quantity → "Stock changed since you opened this item…"', () => {
    const t = trading('10');
    refused(t.w, 'set_stock_quantity', { itemId: t.item, warehouseId: t.w.warehouses[0].id, expectedQuantity: '7', targetQuantity: '5', date: today(), reason: 'count' }, 'Stock changed since you opened this item. Current quantity in Main store: 10. Refresh and try again.');
  });
  it('DAT-017 module toggle vs a gated command is deterministic by order', () => {
    const w = freshCompany();
    const off = run(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'payroll') }).workspace;
    refused(off, 'create_payroll', { month: '2026-10' }, 'Payroll is turned off');
    expect(() => run(w, 'create_payroll', { month: '2026-10' })).toThrow('Enter EOBI and income-tax settings');
  });
  it('DAT-018 commit_workspace rejects a stale p_expected', async () => {
    const { workspace, revision } = await snapshot(QA);
    const next = run(workspace, 'save_company', { name: 'Stale Test Co', address: 'x' }).workspace;
    expect(await commit(QA, revision - 1, { ...next, revision })).toBeNull();
    expect((await snapshot(QA)).revision).toBe(revision);
  });
  it('DAT-019 snapshot and projection are one transaction: a projection failure rolls the snapshot back', async () => {
    const { workspace, revision } = await snapshot(QA);
    const broken = structuredClone(workspace); broken.revision = revision + 1;
    broken.documents.push({ ...structuredClone(buildDemoWorkspace().documents[0]), id: 'orphan-doc', number: 'INV-ORPHAN', partyId: 'no-such-party', warehouseId: 'no-such-warehouse' });
    await expect(db.transaction(tx => tx.query('select public.commit_workspace($1, $2, $3::jsonb)', [QA, revision, JSON.stringify(broken)]))).rejects.toThrow(/foreign key|violates/);
    expect((await snapshot(QA)).revision).toBe(revision);
    expect((await db.query('select 1 from public.documents where id = $1', ['orphan-doc'])).rows).toHaveLength(0);
  });
  it('DAT-020 projection equals the snapshot (counts and totals) after a series of commands', async () => {
    const { workspace } = await snapshot(QA);
    const wh = workspace.warehouses[0].id;
    const steps: [string, Record<string, unknown>][] = [['save_item', { sku: 'DAT-20', name: 'Dat item', category: 'General', hsCode: '', unit: 'pcs', price: '10', cost: '4', weight: '1', volume: '1', reorderLevel: 0 }]];
    let s = await apply(QA, steps);
    const item = s.workspace.items.find(i => i.sku === 'DAT-20')!.id; const cust = s.workspace.parties.find(p => p.type === 'customer')!.id;
    s = await apply(QA, [['bulk_stock_increase', { warehouseId: wh, date: today(), purpose: 'opening_stock', reason: 'QA', lines: [{ itemId: item, quantity: '20', cost: '4' }] }], ['create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: wh, date: today(), dueDate: today(), lines: [line(item, '3', '10', { taxRate: '18' })] }]]);
    const doc = s.workspace.documents.at(-1)!.id;
    s = await apply(QA, [['submit_document', { id: doc }], ['create_receipt', { partyId: cust, date: today(), amount: '10', method: 'cash', dueDate: today(), allocations: [{ invoiceId: doc, amount: '10' }] }]]);
    await projectionMatches(QA);
    expectInvariants(s.workspace);
  });
  it('DAT-021 p_rebuild=true restores a corrupted demo projection', async () => {
    await db.query('delete from public.audit_events where tenant_id = $1', [DEMO_TENANT]);
    await db.query(`delete from public.follow_ups where tenant_id = $1`, [DEMO_TENANT]);
    expect(await count('audit_events', DEMO_TENANT)).toBe(0);
    const { workspace, revision } = await snapshot(DEMO_TENANT);
    expect(await commit(DEMO_TENANT, revision, { ...workspace, revision: revision + 1 }, true)).toBe(revision + 1);
    await projectionMatches(DEMO_TENANT);
  });
  it('DAT-022 a snapshot stored as a JSON string is normalised by migration; the RPC rejects non-objects', async () => {
    const [{ kind }] = (await db.query<{ kind: string }>('select jsonb_typeof(data) as kind from public.workspace_snapshots where tenant_id = $1', [PARTNER_TENANT])).rows;
    expect(kind).toBe('object');
    await expect(db.query(`select public.commit_workspace($1, 0, to_jsonb('x'::text))`, [PARTNER_TENANT])).rejects.toThrow('Snapshot must be a JSON object.');
  });
  it('DAT-024 migrations are idempotent (all applied twice on a fresh database)', async () => {
    const fresh = new PGlite({ extensions: { pgcrypto } });
    await fresh.exec(supabaseStubs);
    const errors: string[] = [];
    for (let pass = 0; pass < 2; pass++) for (const [f, sql] of migrations()) { try { await fresh.exec(sql); } catch (e) { errors.push(`pass ${pass + 1} ${f}: ${(e as Error).message}`); await fresh.exec('rollback').catch(() => undefined); } }
    await fresh.close();
    expect(errors).toEqual([]);
  }, 60_000);
  it('DAT-025 codec fills defaults for old snapshots; setup.complete = demo or has data', () => {
    const { modules: _m, setup: _s, branding: _b, bankAccounts: _ba, followUps: _f, ...legacy } = freshCompany();
    const empty = decodeWorkspace({ ...legacy, parties: [], items: [], documents: [] });
    expect(empty.modules).toHaveLength(9);
    expect(empty.setup).toEqual({ complete: false, step: 1 });
    expect(empty.branding).toEqual({ template: 'standard', accent: '#087f69', footer: '' });
    expect([empty.bankAccounts, empty.followUps]).toEqual([[], []]);
    const withData = decodeWorkspace({ ...legacy, parties: [{ id: 'p' }] });
    expect(withData.setup.complete).toBe(true);
    expect(decodeWorkspace(JSON.stringify({ ...legacy, demo: true, parties: [] })).setup.complete).toBe(true);
    expect(() => decodeWorkspace('[]')).toThrow('The persisted workspace is invalid.');
  });
  it('DAT-026 unknown extra snapshot keys [documented: preserved, except the retired fbr and bankLines keys which are dropped]', () => {
    const w = decodeWorkspace({ ...freshCompany(), futureField: { a: 1 }, fbr: { x: 1 }, bankLines: [1] });
    expect((w as unknown as Record<string, unknown>).futureField).toEqual({ a: 1 });
    expect('fbr' in w).toBe(false);
    expect('bankLines' in w).toBe(false);
  });
  it('DAT-027 schema version path [documented: schemaVersion stays 1; additive fields are defaulted by decodeWorkspace; no version switch exists]', () => {
    const codec = readFileSync(resolve(root, 'src/modules/erp/codec.ts'), 'utf8');
    expect(codec).not.toMatch(/schemaVersion/);
    expect(freshCompany().schemaVersion).toBe(1);
  });
  it('DAT-028 backup and restore of one tenant reproduces it; projection rebuilt', async () => {
    const before = await snapshot(QA);
    const tenantRow = (await db.query<{ name: string; is_demo: boolean }>('select name, is_demo from public.tenants where id = $1', [QA])).rows[0];
    const members = (await db.query<{ user_id: string; role: string }>('select user_id, role from public.memberships where tenant_id = $1', [QA])).rows;
    await db.transaction(async tx => { await tx.query(`select set_config('app.demo_reset', 'on', true)`); await tx.query('delete from public.tenants where id = $1', [QA]); });
    expect(await count('documents', QA)).toBe(0);
    await db.transaction(async tx => {
      await tx.query('insert into public.tenants (id, name, is_demo) values ($1, $2, $3)', [QA, tenantRow.name, tenantRow.is_demo]);
      for (const m of members) await tx.query('insert into public.memberships (tenant_id, user_id, role) values ($1, $2, $3)', [QA, m.user_id, m.role]);
      await tx.query('insert into public.workspace_snapshots (tenant_id, revision, schema_version, data) values ($1, $2, 1, $3::jsonb)', [QA, before.revision, JSON.stringify(before.workspace)]);
      await tx.query('select private.sync_projection($1, data, true) from public.workspace_snapshots where tenant_id = $1', [QA]);
    });
    const after = await snapshot(QA);
    expect(after.revision).toBe(before.revision);
    expect(JSON.stringify(after.workspace)).toBe(JSON.stringify(before.workspace));
  });
  it('DAT-029 restore then rebuild: projection equals the snapshot', async () => {
    await projectionMatches(QA);
  });
  it('DAT-030 invariant sweep after restore: balanced and reconciled', async () => {
    expectInvariants((await snapshot(QA)).workspace);
    const [{ unbalanced }] = (await db.query<{ unbalanced: number }>(`select count(*)::int as unbalanced from (select journal_id from public.journal_lines where tenant_id = $1 group by journal_id having sum(debit - credit) <> 0) x`, [QA])).rows;
    expect(unbalanced).toBe(0);
  });
  it('DAT-031 audit is append-only; one entry per applied command (replays add none)', () => {
    let w = freshCompany(); const start = w.audit.length;
    for (let i = 0; i < 5; i++) w = run(w, 'save_company', { name: `Audit ${i} Co`, address: 'x' }, owner, `dat-031-${i}`).workspace;
    const snapshotAudit = structuredClone(w.audit);
    w = run(w, 'save_company', { name: 'Replay', address: 'x' }, owner, 'dat-031-0').workspace;
    expect(w.audit).toEqual(snapshotAudit);
    expect(w.audit.length - start).toBe(5);
  });
  it('DAT-032 failed commands are not audited [documented: no]', () => {
    const w = freshCompany();
    expect(() => run(w, 'save_company', { name: 'x', address: 'x' })).toThrow();
    expect(w.audit).toHaveLength(3);
  });
  it('DAT-033 revision increases by exactly 1 per applied command (not on replay)', () => {
    let w = freshCompany(); const r0 = w.revision;
    w = run(w, 'save_company', { name: 'Rev Co', address: 'x' }, owner, 'dat-033-a').workspace;
    w = run(w, 'save_company', { name: 'Rev Co 2', address: 'x' }, owner, 'dat-033-b').workspace;
    expect(w.revision).toBe(r0 + 2);
    expect(run(w, 'save_company', { name: 'Rev Co 3', address: 'x' }, owner, 'dat-033-b').workspace.revision).toBe(r0 + 2);
  });
  it('DAT-034 timestamps are ISO-8601 with timezone (UTC Z)', () => {
    const w = buildDemoWorkspace();
    expect(w.audit.every(a => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(a.date))).toBe(true);
    expect(freshCompany().setup.completedAt).toMatch(/Z$/);
  });
  it('DAT-035 today() at 23:30 Karachi (18:30 UTC) is the Karachi date', () => {
    expect(businessToday(new Date('2026-10-14T18:30:00Z'))).toBe('2026-10-14');
    expect(businessToday(new Date('2026-10-14T19:00:00Z'))).toBe('2026-10-15');
  });
  it('DAT-036 document dates are stored as YYYY-MM-DD and invalid dates are refused', () => {
    const w = buildDemoWorkspace();
    expect(w.documents.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && /^\d{4}-\d{2}-\d{2}$/.test(d.dueDate))).toBe(true);
    const t = trading();
    refused(t.w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: t.w.warehouses[0].id, date: '14/10/2026', dueDate: today(), lines: [line(t.item, '1', '1')] }, /Invalid ISO date|invalid_format/);
  });
  it('DAT-037 numbering is per prefix per year and restarts on 1 January', () => {
    const t = trading(); let w = t.w;
    const mk = (date: string) => { const r = run(w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: w.warehouses[0].id, date, dueDate: date, lines: [line(t.item, '1', '1')] }); w = r.workspace; return w.documents.find(d => d.id === r.recordId)!.number; };
    expect([mk('2026-12-30'), mk('2026-12-31'), mk('2027-01-01'), mk('2026-11-01')]).toEqual(['INV-2026-0001', 'INV-2026-0002', 'INV-2027-0001', 'INV-2026-0003']);
    const po = run(w, 'create_document', { kind: 'purchase_order', partyId: t.supp, warehouseId: w.warehouses[0].id, date: '2026-12-31', dueDate: '2026-12-31', lines: [line(t.item, '1', '1')] });
    expect(po.workspace.documents.find(d => d.id === po.recordId)!.number).toBe('PO-2026-0001');
  });
  it('DAT-038 cancelled documents keep their number; numbers are never reused', () => {
    const t = trading(); let [w, a] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '1')], {}, false);
    w = run(w, 'cancel_document', { id: a, reason: 'x' }).workspace;
    let b: string; [w, b] = withDocument(w, 'sales_invoice', t.cust, [line(t.item, '1', '1')], {}, false);
    const nums = [a, b].map(id => w.documents.find(d => d.id === id)!.number);
    expect(nums[0]).toMatch(/0001$/); expect(nums[1]).toMatch(/0002$/);
  });
  it('DAT-039 numbering after 9,999 widens to 5 digits [documented: a plain string sort then puts …-10000 before …-9999]', () => {
    const t = trading(); const w = structuredClone(t.w);
    const year = today().slice(0, 4);
    w.documents.push({ ...structuredClone(buildDemoWorkspace().documents[0]), id: 'seed-9999', number: `INV-${year}-9999`, partyId: t.cust, warehouseId: w.warehouses[0].id, status: 'cancelled' });
    const r = run(w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: w.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '1', '1')] });
    const n = r.workspace.documents.find(d => d.id === r.recordId)!.number;
    expect(n).toBe(`INV-${year}-10000`);
    expect([`INV-${year}-9999`, n].sort()).toEqual([n, `INV-${year}-9999`]);
  });
  it('DAT-040 ids are unique (100k UUIDs, no collision)', () => {
    const ids = new Set(Array.from({ length: 100_000 }, () => crypto.randomUUID()));
    expect(ids.size).toBe(100_000);
  });
  it('DAT-041 renaming a party does not alter document references', () => {
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '1')]);
    const p = w.parties.find(x => x.id === t.cust)!;
    const renamed = run(w, 'save_party', { ...p, name: 'Renamed Customer' }).workspace;
    expect(renamed.documents.find(d => d.id === doc)!.partyId).toBe(t.cust);
    expect(renamed.parties.find(x => x.id === t.cust)!.name).toBe('Renamed Customer');
  });
  it('DAT-042 renaming an item keeps itemId on lines; the document view shows the new name [documented]', () => {
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '1')]);
    const item = w.items.find(i => i.id === t.item)!;
    const renamed = run(w, 'save_item', { ...item, name: 'Renamed Item' }).workspace;
    const d = renamed.documents.find(x => x.id === doc)!;
    expect(d.lines[0].itemId).toBe(t.item);
    expect(documentView(renamed, d).lines[0].description).toBe('Renamed Item');
  });
  it('DAT-043 renaming a warehouse keeps ids stable', () => {
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '1')]);
    const wh = w.warehouses[0];
    const renamed = run(w, 'save_warehouse', { id: wh.id, name: 'Renamed Store', branchId: wh.branchId }).workspace;
    expect(renamed.warehouses[0]).toEqual({ ...wh, name: 'Renamed Store' });
    expect(renamed.documents.find(d => d.id === doc)!.warehouseId).toBe(wh.id);
    expect(stock(renamed, t.item, wh.id)).toEqual(stock(w, t.item, wh.id));
  });
  it('DAT-044 archived flags survive edits', () => {
    const t = trading(); let w = run(t.w, 'set_archived', { kind: 'party', id: t.cust, archived: true }).workspace;
    w = run(w, 'save_party', { ...w.parties.find(p => p.id === t.cust)!, city: 'Lahore' }).workspace;
    expect(w.parties.find(p => p.id === t.cust)!.archived).toBe(true);
    w = run(w, 'set_archived', { kind: 'item', id: t.item, archived: true }).workspace;
    w = run(w, 'save_item', { ...w.items.find(i => i.id === t.item)!, name: 'Edited archived' }).workspace;
    expect(w.items.find(i => i.id === t.item)!.archived).toBe(true);
  });
  it('DAT-045 hidden module data survives off/on cycles', () => {
    const demo = buildDemoWorkspace();
    const off = run(demo, 'set_modules', { enabled: demo.modules.filter(m => !['payroll', 'imports'].includes(m)) }).workspace;
    const on = run(off, 'set_modules', { enabled: demo.modules }).workspace;
    expect([on.payrolls, on.employees, on.shipments]).toEqual([demo.payrolls, demo.employees, demo.shipments]);
    expect(on.modules).toEqual(demo.modules);
  });
  it('DAT-046 company:reset SQL (replayed in PGlite) leaves other tenants untouched', async () => {
    const before = await others(QA);
    const base = blankWorkspace(false);
    const reset = { ...base, tenantId: QA, company: { ...base.company, name: 'My Company', logo: 'M' }, settings: { ...base.settings, numbering: 'MC' } };
    await db.transaction(async tx => {
      await tx.query(`update public.tenants set name = 'My Company' where id = $1`, [QA]);
      await tx.query('update public.workspace_snapshots set data = $2::jsonb, revision = 0, schema_version = 1 where tenant_id = $1', [QA, JSON.stringify(reset)]);
      await tx.query('select private.sync_projection($1, data, true) from public.workspace_snapshots where tenant_id = $1', [QA]);
    });
    expect(await others(QA)).toEqual(before);
    expect(await count('documents', QA)).toBe(0);
    expect(await count('journals', QA)).toBe(0);
    const qa = { ...freshCompany(), tenantId: QA, revision: 1 };
    expect(await commit(QA, 0, qa)).toBe(1);
  });
  it('DAT-047 qa:tenant SQL (replayed in PGlite) leaves other tenants untouched', async () => {
    const before = await others(QA2);
    const ws = { ...blankWorkspace(false), tenantId: QA2, company: { ...blankWorkspace(false).company, name: 'QA Company', logo: 'Q' } };
    for (let i = 0; i < 2; i++) await db.transaction(async tx => {
      await tx.query(`select set_config('app.demo_reset', 'on', true)`);
      await tx.query('delete from public.tenants where id = $1', [QA2]);
      await tx.query(`insert into public.tenants (id, name, is_demo) values ($1, 'QA Company', true)`, [QA2]);
      await tx.query(`insert into public.memberships (tenant_id, user_id, role, branch_ids) values ($1, $2, 'Owner', '{}')`, [QA2, OWNER]);
      await tx.query('insert into public.workspace_snapshots (tenant_id, revision, schema_version, data) values ($1, 0, 1, $2::jsonb)', [QA2, JSON.stringify(ws)]);
      await tx.query('select private.sync_projection($1, data, true) from public.workspace_snapshots where tenant_id = $1', [QA2]);
    });
    expect(await others(QA2)).toEqual(before);
  });
  it('DAT-048 demo reset restores the seed [documented: content is identical; ids and audit timestamps are regenerated, so a raw hash differs]', () => {
    const a = buildDemoWorkspace(), b = buildDemoWorkspace();
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    const ids = new Map<string, string>();
    const norm = (w: Workspace) => JSON.stringify(w, (k, v) => (k === 'date' && typeof v === 'string' && v.includes('T') ? 'T' : typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(v) ? 'uuid' : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, 'uuid');
    expect(norm(a)).toBe(norm(b));
    void ids;
  });
  it('DAT-049 snapshot size for 10k documents stays under 20 MB [documented: extrapolated from 200 invoices]', () => {
    const t = trading('100000'); let w = t.w; const base = JSON.stringify(w).length;
    for (let i = 0; i < 200; i++) [w] = withDocument(w, 'sales_invoice', t.cust, [line(t.item, '1', '10', { taxRate: '18' })]);
    const perInvoice = (JSON.stringify(w).length - base) / 200;
    expect(perInvoice * 10_000 / 1024 / 1024).toBeLessThan(20);
  }, 60_000);
  it('DAT-050 command latency with 10k documents < 1 s [documented: engine only, excluding network/DB]', () => {
    const t = trading(); const [w0] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '10')]);
    const template = w0.documents[0];
    const big = { ...w0, documents: Array.from({ length: 10_000 }, (_, i) => ({ ...template, id: `bulk-${i}`, number: `INV-2025-${String(i + 1).padStart(5, '0')}` })) };
    const t0 = performance.now();
    run(big, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: big.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '1', '1')] });
    expect(performance.now() - t0).toBeLessThan(1000);
  }, 30_000);
  it('DAT-052 engine purity: the same input twice gives the same output (modulo ids/timestamps)', () => {
    const t = trading();
    const c = { type: 'create_document', payload: { kind: 'sales_invoice', partyId: t.cust, warehouseId: t.w.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '2', '3')] }, idempotencyKey: 'dat-052-pure' };
    const strip = (w: Workspace) => JSON.stringify(w).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, 'uuid').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'ts');
    const before = JSON.stringify(t.w);
    expect(strip(execute(t.w, c, owner).workspace)).toBe(strip(execute(t.w, c, owner).workspace));
    expect(JSON.stringify(t.w)).toBe(before);
  });
  it('DAT-053 the input workspace is never mutated when a command throws', () => {
    const t = trading('1');
    const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '5', '1')], {}, false);
    refused(w, 'submit_document', { id: doc }, 'Insufficient stock');
    refused(w, 'create_journal', { date: today(), memo: 'bad', lines: [{ account: '1000', debit: '5', credit: '0' }, { account: '3000', debit: '0', credit: '4' }] }, 'Journal debits and credits must balance.');
  });
  it('DAT-054 multi-step: party saved, then document fails → party exists, no orphan document', () => {
    const t = trading('1');
    const [w, party] = withParty(t.w, 'customer', { name: 'New Walk Co' });
    expect(() => run(w, 'create_document', { kind: 'sales_invoice', partyId: party, warehouseId: w.warehouses[0].id, date: today(), dueDate: today(), lines: [] })).toThrow();
    expect(w.parties.some(p => p.id === party)).toBe(true);
    expect(w.documents).toHaveLength(0);
  });
  it('DAT-055 product saved, opening stock fails → product exists with stock 0', () => {
    const [w, item] = withItem(freshCompany());
    expect(() => run(w, 'bulk_stock_increase', { warehouseId: w.warehouses[0].id, date: today(), purpose: 'opening_stock', reason: 'x', lines: [{ itemId: item, quantity: '5', cost: '-1' }] })).toThrow();
    expect(w.items.some(i => i.id === item)).toBe(true);
    expect(stock(w, item).quantity).toBe('0.0000');
  });
  it('DAT-056 submit fails after create → draft kept; retry updates the same draft and submits', () => {
    const t = trading('1'); let [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '5', '1')], {}, false);
    expect(() => run(w, 'submit_document', { id: doc })).toThrow('Insufficient stock');
    w = run(w, 'update_document', { id: doc, partyId: t.cust, warehouseId: w.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '1', '1')] }).workspace;
    w = run(w, 'submit_document', { id: doc }).workspace;
    expect(w.documents).toHaveLength(1);
    expect(w.documents[0]).toMatchObject({ id: doc, status: 'submitted' });
  });
  it('DAT-057 walk-in account created then the document fails [documented: the walk-in account remains; acceptable]', () => {
    const t = trading('1');
    const [w, walk] = withParty(t.w, 'customer', { name: 'Walk-in customer' });
    expect(() => run(w, 'create_document', { kind: 'sales_invoice', partyId: walk, warehouseId: w.warehouses[0].id, date: 'bad', dueDate: today(), lines: [line(t.item, '1', '1')], partyName: 'Ali' })).toThrow();
    expect(w.parties.find(p => p.id === walk)!.name).toBe('Walk-in customer');
  });
  it('DAT-059 a crash mid-commit leaves the database as before (transaction atomic)', async () => {
    const { workspace, revision } = await snapshot(QA);
    const next = run(workspace, 'save_company', { name: 'Crash Co', address: 'x' }).workspace;
    await expect(db.transaction(async tx => { await tx.query('select public.commit_workspace($1, $2, $3::jsonb)', [QA, revision, JSON.stringify(next)]); throw new Error('server restarted'); })).rejects.toThrow('server restarted');
    const after = await snapshot(QA);
    expect(after.revision).toBe(revision);
    expect(after.workspace.company.name).not.toBe('Crash Co');
  });
  it('DAT-060 database unreachable → 500 with a generic message; retry later works [defect: status 400 "Unexpected request failure.", not 500]', async () => {
    S.read = async () => { throw { message: 'TypeError: fetch failed', details: '', hint: '', code: '' }; };
    const r1 = await workspaceRoute.POST(new Request('http://localhost/api/workspace', { method: 'POST', headers: { 'x-tenant-id': 't' }, body: JSON.stringify({ type: 'save_company', payload: { name: 'A Co', address: 'x' }, idempotencyKey: 'dat-060-key' }) }));
    expect((await r1.json() as { message: string }).message).toBe('Unexpected request failure.');
    const w = freshCompany(); S.read = async () => ({ workspace: w, revision: w.revision });
    const r2 = await workspaceRoute.POST(new Request('http://localhost/api/workspace', { method: 'POST', headers: { 'x-tenant-id': 't' }, body: JSON.stringify({ type: 'save_company', payload: { name: 'A Co', address: 'x' }, idempotencyKey: 'dat-060-key' }) }));
    expect(r2.status).toBe(200);
    expect(r1.status).toBe(500);
  });
  it('DAT-061 storage unreachable on logo upload → error and branding unchanged', async () => {
    S.uploadError = true; const w = freshCompany(); S.read = async () => ({ workspace: w, revision: w.revision });
    const form = new FormData(); form.set('kind', 'logo'); form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0])], 'logo.png', { type: 'image/png' }));
    const r = await uploadRoute.POST(new Request('http://localhost/api/branding/upload', { method: 'POST', headers: { 'x-tenant-id': 't' }, body: form }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ success: false, message: 'The file could not be stored. Try again.' });
    expect(S.commits).toEqual([]);
  });
  it('DAT-063 client clock skew: dates come from the client fields; the server validates format only [documented: future dates are accepted]', () => {
    const t = trading();
    const r = run(t.w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: t.w.warehouses[0].id, date: '2030-01-01', dueDate: '2030-01-31', lines: [line(t.item, '1', '1')] });
    expect(r.workspace.documents[0].date).toBe('2030-01-01');
    refused(t.w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: t.w.warehouses[0].id, date: '2026-13-01', dueDate: today(), lines: [line(t.item, '1', '1')] }, /Invalid ISO date|invalid_format/);
  });
  it('DAT-064 period lock is enforced server-side regardless of the client date', () => {
    const t = trading(); const month = today().slice(0, 7);
    const locked = run(t.w, 'set_period', { month, locked: true }).workspace;
    refused(locked, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: locked.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '1', '1')] }, `Accounting period ${month} is locked.`);
  });
  it('DAT-065 role is enforced server-side regardless of UI', () => {
    refused(freshCompany(), 'create_journal', { date: today(), memo: 'x', lines: [{ account: '1000', debit: '1', credit: '0' }, { account: '3000', debit: '0', credit: '1' }] }, 'Your role does not permit this action.', actor('Salesperson'));
    refused(freshCompany(), 'save_settings', { taxRate: '18' }, 'Your role does not permit this action.', actor('Accountant'));
  });
  it('DAT-066 module gate is enforced server-side', () => {
    const w = { ...freshCompany(), modules: ['sales' as const] };
    refused(w, 'stock_transfer', { itemId: 'x', from: 'a', to: 'b', quantity: '1' }, 'Inventory is turned off for this company.');
  });
  it('DAT-067 journal source uniqueness is enforced in the engine and the database', async () => {
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '1')]);
    refused(w, 'submit_document', { id: doc }, 'Only draft documents can be submitted.');
    const { workspace, revision } = await snapshot(DEMO_TENANT);
    const dup = structuredClone(workspace); dup.revision = revision + 1;
    dup.journals.push({ ...structuredClone(workspace.journals[1]), id: 'dup-source', number: 'JV-77777' });
    await expect(commit(DEMO_TENANT, revision, dup)).rejects.toThrow(/source|duplicate|unique/i);
  });
  it('DAT-068 stock cannot go negative', () => {
    const t = trading('1');
    refused(t.w, 'stock_adjust', { itemId: t.item, warehouseId: t.w.warehouses[0].id, quantity: '-2', reason: 'x', date: today() }, /Insufficient stock/);
  });
  it('DAT-069 credit limit enforced server-side; only an owner with a reason may override', () => {
    let { w, item } = trading(); let cust: string; [w, cust] = withParty(w, 'customer', { creditLimit: '50' });
    const [d1, doc] = withDocument(w, 'sales_invoice', cust, [line(item, '1', '100')], {}, false);
    refused(d1, 'submit_document', { id: doc }, 'Customer credit limit exceeded. An owner must enter an override reason.', actor('Accountant'));
    refused(d1, 'submit_document', { id: doc }, 'Customer credit limit exceeded.');
    const [d2, doc2] = withDocument(w, 'sales_invoice', cust, [line(item, '1', '100')], { creditOverride: 'Known customer' }, false);
    expect(run(d2, 'submit_document', { id: doc2 }).workspace.documents.find(d => d.id === doc2)!.status).toBe('submitted');
  });
  it('DAT-070 allocation sums are enforced server-side', () => {
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '1', '100')]);
    refused(w, 'create_receipt', { partyId: t.cust, date: today(), amount: '60', method: 'cash', dueDate: today(), allocations: [{ invoiceId: doc, amount: '50' }] }, 'Allocations must equal the receipt amount.');
  });
  it('DAT-071 validation errors return a message and change nothing', () => {
    refused(freshCompany(), 'save_party', { name: 'X', type: 'customer' }, /invalid|expected|Too small/i);
  });
  it('DAT-072 unknown payload fields are ignored', () => {
    const [w, id] = withParty(freshCompany(), 'customer', { isAdmin: true, __hack: 'x', revision: 999 });
    expect(Object.keys(w.parties.find(p => p.id === id)!)).not.toEqual(expect.arrayContaining(['isAdmin', '__hack']));
    expect(w.revision).not.toBe(999);
  });
  it('DAT-073 strings are trimmed; null is not accepted for text fields', () => {
    const [w, id] = withParty(freshCompany(), 'customer', { name: '  Spaced Co  ' });
    expect(w.parties.find(p => p.id === id)!.name).toBe('Spaced Co');
    expect(run(freshCompany(), 'save_company', { name: '  Trim Co ', address: ' x ' }).workspace.company).toMatchObject({ name: 'Trim Co', address: 'x' });
    refused(freshCompany(), 'save_party', { name: 'Null Co', type: 'customer', city: null, email: '', taxId: '', registered: false, creditLimit: '0', terms: 0, customerClass: '' }, /expected string/i);
  });
  it('DAT-074 Unicode normalisation of names [documented: not normalised; NFC and NFD forms are distinct]', () => {
    let w = freshCompany(); [w] = withParty(w, 'customer', { name: 'Café' });
    const [after] = withParty(w, 'customer', { name: 'Café' });
    expect(after.parties.map(p => p.name.normalize('NFC')).filter(n => n === 'Café')).toHaveLength(2);
  });
  it('DAT-075 whitespace-only inputs are rejected where required [defect: save_party accepts "   " and stores an empty name]', () => {
    refused(freshCompany(), 'save_company', { name: '   ', address: 'x' }, /too_small/);
    refused(freshCompany(), 'save_party', { name: '   ', type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 0, customerClass: '' }, /.+/);
  });
  it('DAT-076 extremely long strings are capped by the schema', () => {
    const t = trading();
    refused(t.w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: t.w.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '1', '1')], notes: 'x'.repeat(2001) }, /Too big|at most/i);
    refused(t.w, 'save_party', { name: 'x'.repeat(121), type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 0, customerClass: '' }, /Too big|at most/i);
  });
  it('DAT-077 deeply nested JSON is rejected by the schema', () => {
    let deep: unknown = 'x'; for (let i = 0; i < 5000; i++) deep = { a: deep };
    const t = trading();
    refused(t.w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: t.w.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '1', '1')], notes: deep }, /expected string/i);
    expect(() => run(t.w, 'save_company', { name: 'Deep Co', address: 'x', extra: deep })).not.toThrow();
  });
  it('DAT-078 __proto__ keys do not pollute prototypes', () => {
    const payload = JSON.parse('{"name":"Proto Co","address":"x","__proto__":{"polluted":"yes"}}');
    const w = run(freshCompany(), 'save_company', payload).workspace;
    const plan = JSON.parse('{"name":"Proto plan","effectiveFrom":"2000-01-01","effectiveTo":"2000-12-31","type":"category","rate":"1","categoryRates":{"__proto__":"5","General":"2"},"classRates":{},"tiers":[{"threshold":"0","rate":"1"}],"target":"0","multiplier":"1"}');
    const w2 = run(w, 'save_plan', plan).workspace;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(w2.plans.at(-1)!.categoryRates.General).toBe('2');
  });
  it('DAT-079 duplicates in arrays are caught (lines, allocations, return lines)', () => {
    const t = trading(); const [w, doc] = withDocument(t.w, 'sales_invoice', t.cust, [line(t.item, '2', '10')]);
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: t.cust, warehouseId: w.warehouses[0].id, date: today(), dueDate: today(), lines: [line(t.item, '1', '1'), line(t.item, '1', '1')] }, 'Use one line per product.');
    refused(w, 'create_receipt', { partyId: t.cust, date: today(), amount: '2', method: 'cash', dueDate: today(), allocations: [{ invoiceId: doc, amount: '1' }, { invoiceId: doc, amount: '1' }] }, 'Duplicate allocation.');
    const lineId = w.documents.find(d => d.id === doc)!.lines[0].id;
    refused(w, 'return_document', { id: doc, date: today(), lines: [{ lineId, quantity: '1' }, { lineId, quantity: '1' }] }, 'Duplicate return line.');
  });
  it('DAT-080 order of lines is preserved', () => {
    const t = trading(); let w = t.w; let item3: string; [w, item3] = withItem(w, {}, { quantity: '5', cost: '1' });
    const [w2, doc] = withDocument(w, 'sales_invoice', t.cust, [line(item3, '1', '1'), line(t.item, '1', '1'), line(t.item2, '1', '1')]);
    expect(w2.documents.find(d => d.id === doc)!.lines.map(l => l.itemId)).toEqual([item3, t.item, t.item2]);
  });
  it('DAT-081 snapshot JSON key order [documented: not normalised; insertion order from the engine]', () => {
    const w = freshCompany();
    expect(Object.keys(JSON.parse(JSON.stringify(w))).slice(0, 4)).toEqual(['schemaVersion', 'tenantId', 'revision', 'demo']);
  });
  it('DAT-082 projection companies.setup_complete mirrors the snapshot', async () => {
    const rows = (await db.query<{ tenant_id: string; setup_complete: boolean }>('select tenant_id, setup_complete from public.companies')).rows;
    for (const r of rows.filter(x => x.tenant_id !== PARTNER_TENANT)) expect(r.setup_complete, r.tenant_id).toBe((await snapshot(r.tenant_id)).workspace.setup.complete);
  });
  it('DAT-083 projection companies.enabled_modules mirrors the snapshot', async () => {
    const rows = (await db.query<{ tenant_id: string; enabled_modules: string[] }>('select tenant_id, enabled_modules from public.companies')).rows;
    for (const r of rows.filter(x => x.tenant_id !== PARTNER_TENANT)) expect(r.enabled_modules, r.tenant_id).toEqual((await snapshot(r.tenant_id)).workspace.modules);
  });
  it('DAT-084 every projected journal balances (SQL)', async () => {
    expect((await db.query('select tenant_id, journal_id from public.journal_lines group by tenant_id, journal_id having sum(debit - credit) <> 0')).rows).toEqual([]);
    expect((await db.query<{ n: number }>('select count(distinct journal_id)::int as n from public.journal_lines')).rows[0].n).toBeGreaterThan(10);
  });
  it('DAT-085 projected document totals equal the snapshot', async () => {
    await projectionMatches(DEMO_TENANT);
  });
  it('DAT-086 tests run against PGlite with the real migrations', async () => {
    const tables = (await db.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' order by 1`)).rows.map(r => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(['workspace_snapshots', 'documents', 'journals', 'journal_lines', 'follow_ups', 'companies']));
    // Every migration file is applied, including the newest (D-07 role-scoped reads).
    expect(migrations().map(([f]) => f)).toHaveLength(6);
    expect((await db.query(`select 1 from pg_proc where proname = 'reads_full_ledger'`)).rows).toHaveLength(1);
  });
  it('DAT-087 pgcrypto is available in the test database', async () => {
    const [{ id }] = (await db.query<{ id: string }>('select gen_random_uuid()::text as id')).rows;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await db.query<{ h: string }>(`select encode(digest('abc', 'sha256'), 'hex') as h`)).rows[0].h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('DAT-090 client retry on 5xx [case-corrected: postCommand retries once with the same body only when the response is not JSON or a 5xx without a message; a 5xx with a message is not retried]', async () => {
    const body = JSON.stringify({ type: 'x', payload: {}, idempotencyKey: 'dat-090-key' });
    const a = postCommandWith([() => Response.json({ success: false }, { status: 502 }), () => Response.json({ success: true })]);
    await a.post(body);
    expect(a.calls).toEqual([body, body]);
    const b = postCommandWith([() => Response.json({ success: false, message: 'The database rejected this change' }, { status: 500 })]);
    const r = await b.post(body);
    expect(b.calls).toHaveLength(1);
    expect(r.result.message).toBe('The database rejected this change');
  });
  it('DAT-091 no retry on 4xx [documented: a 4xx whose body is not JSON is retried once]', async () => {
    const a = postCommandWith([() => Response.json({ success: false, message: 'Your role does not permit this action.' }, { status: 400 })]);
    await a.post('{}');
    expect(a.calls).toHaveLength(1);
    const b = postCommandWith([() => new Response('Bad gateway', { status: 404 }), () => Response.json({ success: false, message: 'x' }, { status: 404 })]);
    await b.post('{}');
    expect(b.calls).toHaveLength(2);
  });
  it('DAT-092 server error wording passes through to the notice', async () => {
    const a = postCommandWith([() => Response.json({ success: false, message: 'Customer credit limit exceeded.' }, { status: 400 })]);
    expect((await a.post('{}')).result.message).toBe('Customer credit limit exceeded.');
    expect(wbSource).toContain("setNotice(result.message||'The change could not be saved.');setNoticeError(true);");
  });
  it('DAT-093 the client workspace is refreshed from the command result', () => {
    expect(wbSource).toContain('if(result.workspace)setWorkspace(result.workspace);');
  });
  it('DAT-094 stale tab commits from an old revision [documented: the server re-reads the latest snapshot on every POST, so the command applies on top without a conflict]', async () => {
    let current = freshCompany(); let rev = current.revision;
    S.read = async () => ({ workspace: current, revision: rev });
    const post = async (name: string, key: string) => { const r = await workspaceRoute.POST(new Request('http://localhost/api/workspace', { method: 'POST', headers: { 'x-tenant-id': 't' }, body: JSON.stringify({ type: 'save_party', payload: { name, type: 'customer', city: '', email: '', taxId: '', registered: false, creditLimit: '0', terms: 0, customerClass: '' }, idempotencyKey: key }) })); current = S.commits.at(-1)!.workspace; rev++; return r.status; };
    expect(await post('Tab One Co', 'dat-094-tab-1')).toBe(200);
    expect(await post('Tab Two Co', 'dat-094-tab-2')).toBe(200);
    expect(current.parties.map(p => p.name)).toEqual(['Tab One Co', 'Tab Two Co']);
    expect(S.commits.map(c => c.expected)).toEqual([current.revision - 2, current.revision - 1]);
  });
  it('DAT-095 1,000 sequential commands all apply; revision advances by 1,000', () => {
    let [w, party] = withParty(freshCompany()); const r0 = w.revision;
    for (let i = 0; i < 1000; i++) w = run(w, 'follow_up', { partyId: party, note: `n${i}`, nextDate: today() }).workspace;
    expect(w.revision - r0).toBe(1000);
    expect(w.followUps).toHaveLength(1000);
  }, 60_000);
  it('DAT-096 fuzz: 500 random valid commands keep every invariant', () => {
    let seed = 20261014; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    let { w, item, item2, cust, supp } = trading('50');
    w = run(w, 'save_warehouse', { name: 'Second store', branchId: w.branches[0].id }).workspace;
    const items = [item, item2]; let applied = 0;
    for (let i = 0; i < 500; i++) {
      const wh = pick(w.warehouses).id; const invoices = w.documents.filter(d => d.kind === 'sales_invoice' && d.status === 'submitted');
      const bills = w.documents.filter(d => d.kind === 'supplier_invoice' && d.status === 'submitted');
      const q = String(1 + Math.floor(rnd() * 3)); const p = (1 + Math.floor(rnd() * 5000) / 100).toFixed(2);
      const ops: (() => ReturnType<typeof run>)[] = [
        () => { const r = run(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: wh, date: today(), dueDate: today(), lines: [line(pick(items), q, p, { taxRate: pick(['0', '18']), discount: pick(['0', '5']), employeeId: '', splits: [] })] }); return run(r.workspace, 'submit_document', { id: r.recordId }); },
        () => { const r = run(w, 'create_document', { kind: 'supplier_invoice', partyId: supp, warehouseId: wh, date: today(), dueDate: today(), lines: [line(pick(items), q, p, { discount: '0', taxRate: pick(['0', '18']), employeeId: '', splits: [] })] }); return run(r.workspace, 'submit_document', { id: r.recordId }); },
        () => { const d = pick(invoices); const o = D(outstanding(d)); const amt = money(D.min(o, D(p))); return run(w, 'create_receipt', { partyId: cust, date: today(), amount: amt, method: 'cash', dueDate: today(), allocations: [{ invoiceId: d.id, amount: amt }] }); },
        () => { const d = pick(bills); const amt = money(D.min(D(outstanding(d)), D(p))); return run(w, 'create_receipt', { partyId: supp, date: today(), amount: amt, method: 'bank', dueDate: today(), allocations: [{ invoiceId: d.id, amount: amt }] }); },
        () => { const d = pick(invoices); const l = pick(d.lines); return run(w, 'return_document', { id: d.id, date: today(), lines: [{ lineId: l.id, quantity: '1' }] }); },
        () => run(w, 'stock_transfer', { itemId: pick(items), from: w.warehouses[0].id, to: w.warehouses[1].id, quantity: q, date: today() }),
        () => run(w, 'stock_adjust', { itemId: pick(items), warehouseId: wh, quantity: pick(['-1', '2']), reason: 'fuzz', date: today() }),
        () => run(w, 'create_journal', { date: today(), memo: 'fuzz', lines: [{ account: '5300', debit: p, credit: '0' }, { account: '3000', debit: '0', credit: p }] }),
      ];
      try { w = pick(ops)().workspace; applied++; } catch { /* business-rule refusal is fine */ }
      if (i % 50 === 49) expectInvariants(w);
    }
    expect(applied).toBeGreaterThan(250);
    expectInvariants(w);
  }, 120_000);
  it('DAT-097 fuzz: 500 random invalid commands are all refused and change nothing', () => {
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const t = trading(); const before = JSON.stringify(t.w);
    const types = ['create_document', 'submit_document', 'create_receipt', 'return_document', 'stock_transfer', 'create_journal', 'save_party', 'save_item', 'set_period', 'update_cheque', 'nonsense'];
    const junk = [null, -1, 'NaN', '1e999', {}, [], '', '   ', '<script>', 1e13, '2026-02-30', true];
    let refusedCount = 0;
    for (let i = 0; i < 500; i++) {
      const type = types[Math.floor(rnd() * types.length)];
      const payload = Object.fromEntries(['id', 'partyId', 'amount', 'lines', 'date', 'name', 'quantity', 'month'].map(k => [k, junk[Math.floor(rnd() * junk.length)]]));
      try { execute(t.w, { type, payload, idempotencyKey: `dat-097-${i}` }, owner); } catch { refusedCount++; }
    }
    expect(refusedCount).toBe(500);
    expect(JSON.stringify(t.w)).toBe(before);
  });
  it('DAT-099 forward compatibility: an unknown new field survives decode and engine commands', () => {
    const w = decodeWorkspace({ ...freshCompany(), futureLedger: { v: 2 } });
    const next = run(w, 'save_company', { name: 'Forward Co', address: 'x' }).workspace as unknown as Record<string, unknown>;
    expect(next.futureLedger).toEqual({ v: 2 });
  });
  it('DAT-100 full invariant suite on a busy workspace and its projection: balanced, reconciled, no duplicates, no negatives', async () => {
    let w = buildDemoWorkspace();
    expectInvariants(w);
    const inv = w.documents.find(d => d.kind === 'sales_invoice' && D(outstanding(d)).gt(0))!;
    w = run(w, 'create_receipt', { partyId: inv.partyId, date: today(), amount: '1', method: 'cash', dueDate: today(), allocations: [{ invoiceId: inv.id, amount: '1' }] }).workspace;
    w = run(w, 'return_document', { id: inv.id, date: today(), lines: [{ lineId: inv.lines[0].id, quantity: '1' }] }).workspace;
    expectInvariants(w);
    expect(invariants(w)).toEqual({ trialBalanced: true, sourcesUnique: true, receivable: true, payable: true, inventory: true, commission: true, stockNonNegative: true, commissionOrder: true });
    for (const tenant of [DEMO_TENANT, QA]) { await projectionMatches(tenant); expectInvariants((await snapshot(tenant)).workspace); }
  });

  const todo: [string, string][] = [
    ['DAT-023', '[manual] migration dry-run on a hosted copy'],
    ['DAT-051', '[browser] page load with 10k documents < 4 s'],
    ['DAT-058', '[browser] browser closed mid-command: server completes; reload shows the result'],
    ['DAT-062', '[manual] slow hosted Supabase auth: UI waits, no duplicate'],
    ['DAT-088', '[browser] Playwright suites pass in any order'],
    ['DAT-089', '[browser] Playwright global warm-up prevents dev-compile 500s'],
    ['DAT-098', '[manual] Vercel deploy rollback: previous build reads current snapshots'],
  ];
  for (const [id, title] of todo) it.todo(`${id} ${title}`);
});
