import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { describe, expect, it } from 'vitest';
import { commandSchema, postJournal } from '../../src/modules/erp/engine';
import { decodeWorkspace } from '../../src/modules/erp/codec';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { toggleModules } from '../../src/modules/erp/modules';
import { toCsv } from '../../src/modules/erp/master-data';
import { allocate } from '../../src/modules/erp/money';
import { agedBalances, balanceSheet, chartOf, generalLedger, profitAndLoss, trialBalance } from '../../src/modules/erp/reports';
import { DEMO_TENANT, PARTNER_TENANT, type Workspace } from '../../src/modules/erp/types';
import { accountBalance, actor, blankWorkspace, buildDemoWorkspace, D, execute, expectInvariants, freshCompany, invariants, money, owner, refused, run, sum, today, withDocument, withItem, withParty } from './helpers';

const T = today();
const MONTH = T.slice(0, 7);
const accountant = actor('Accountant');
const bal = (w: Workspace, code: string) => accountBalance(w, code);
const last = (w: Workspace) => w.journals[w.journals.length - 1];
const jFor = (w: Workspace, sourceId: string) => w.journals.filter(j => j.sourceId === sourceId);
const journal = (lines: [string, string, string][], memo = 'Manual', date = T) => ({ memo, date, lines: lines.map(([account, debit, credit]) => ({ account, debit, credit })) });
const balanced = (w: Workspace) => w.journals.every(j => sum(j.lines.map(l => l.debit)).eq(sum(j.lines.map(l => l.credit))));
/** Fresh company with a stocked product (100 @ 60), a customer and a supplier. */
function base() {
  let w = freshCompany(); let item: string, cust: string, sup: string;
  [w, item] = withItem(w, {}, { quantity: '100', cost: '60' });
  [w, cust] = withParty(w);
  [w, sup] = withParty(w, 'supplier');
  return { w, item, cust, sup, wh: w.warehouses[0].id };
}
const receiptPayload = (party: string, inv: string, amount: string, extra: Record<string, unknown> = {}) => ({ partyId: party, date: T, amount, method: 'bank', dueDate: T, allocations: [{ invoiceId: inv, amount }], accountId: 'main-bank', ...extra });
const source = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8');
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }

// Local PGlite with the project's migrations (no hosted Supabase), mirroring tests/domain/database.test.ts.
let dbPromise: Promise<PGlite> | undefined;
function database() {
  dbPromise ??= (async () => {
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
      grant usage on schema storage to authenticated; grant select on storage.objects to authenticated;`);
    const dir = resolve(__dirname, '../../supabase/migrations');
    const files = readdirSync(dir).filter(n => n.endsWith('.sql')).sort();
    for (const f of files.filter(n => n < '202610120001')) await db.exec(readFileSync(resolve(dir, f), 'utf8'));
    const { modules: _m, setup: _s, branding: _b, ...demo } = buildDemoWorkspace();
    await db.query(`insert into public.tenants (id, name, is_demo) values ($1, 'Demo', true), ($2, 'Partner', false)`, [DEMO_TENANT, PARTNER_TENANT]);
    await db.query(`insert into public.workspace_snapshots (tenant_id, revision, data) values ($1, $2, $3::jsonb), ($4, 0, $5::jsonb)`, [DEMO_TENANT, demo.revision, JSON.stringify(demo), PARTNER_TENANT, JSON.stringify(blankWorkspace(false))]);
    for (const f of files.filter(n => n >= '202610120001')) await db.exec(readFileSync(resolve(dir, f), 'utf8'));
    return db;
  })();
  return dbPromise;
}
const commit = async (expected: number, w: Workspace, rebuild = false) => (await (await database()).query<{ revision: number | null }>('select public.commit_workspace($1, $2, $3::jsonb, $4) as revision', [DEMO_TENANT, expected, JSON.stringify(w), rebuild])).rows[0].revision;
const snapshot = async () => { const row = (await (await database()).query<{ data: Workspace; revision: number }>('select data, revision from public.workspace_snapshots where tenant_id = $1', [DEMO_TENANT])).rows[0]; return { data: decodeWorkspace(row.data), revision: row.revision }; };
const projection = async () => (await (await database()).query<{ journals: number; lines: number; debit: string; credit: string }>(`select (select count(*)::int from public.journals where tenant_id = $1) as journals, (select count(*)::int from public.journal_lines where tenant_id = $1) as lines, (select coalesce(sum(debit),0)::numeric(20,4)::text from public.journal_lines where tenant_id = $1) as debit, (select coalesce(sum(credit),0)::numeric(20,4)::text from public.journal_lines where tenant_id = $1) as credit`, [DEMO_TENANT])).rows[0];

describe('14 Accounting (ACC)', () => {
  it('ACC-001 journals carry number, date, memo and posted status [browser: list ordering newest first]', () => {
    const w = buildDemoWorkspace();
    for (const j of w.journals) { expect(j.number).toMatch(/^JV-\d{5}$/); expect(j.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(typeof j.memo).toBe('string'); expect(j.status).toBe('posted'); }
    expect(source('src/components/workbench.tsx')).toContain('workspace.journals.slice(-8).reverse()');
  });

  it('ACC-002 a journal resolves account names and its totals are equal [browser: detail view]', () => {
    const w = buildDemoWorkspace(); const chart = chartOf(w);
    for (const j of w.journals) { for (const l of j.lines) expect(chart[l.account]).toBeTruthy(); expect(money(sum(j.lines.map(l => l.debit)))).toBe(money(sum(j.lines.map(l => l.credit)))); }
  });

  it('ACC-003 trial balance debits equal credits', () => {
    const tb = trialBalance(buildDemoWorkspace(), '2099-12-31');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(D(tb.totalDebit).gt(0)).toBe(true);
  });

  it('ACC-004 manual journal Dr 5300 100 / Cr cash 100', () => {
    const r = run(freshCompany(), 'create_journal', journal([['5300', '100', '0'], ['1002', '0', '100']], 'Office tea'));
    expect(r.message).toBe('Balanced journal posted.');
    expect(last(r.workspace)).toMatchObject({ sourceId: r.recordId, memo: 'Office tea', status: 'posted', lines: [{ account: '5300', debit: '100.0000', credit: '0.0000' }, { account: '1002', debit: '0.0000', credit: '100.0000' }] });
  });

  it('ACC-005 unbalanced journal is refused', () => {
    refused(freshCompany(), 'create_journal', journal([['5300', '100', '0'], ['1002', '0', '99.9999']]), 'Journal debits and credits must balance.');
  });

  it('ACC-006 unknown account code is refused', () => {
    refused(freshCompany(), 'create_journal', journal([['9999', '1', '0'], ['1002', '0', '1']]), 'Journal accounts and amounts must be valid.');
  });

  it('ACC-007 a line with both debit and credit is refused', () => {
    refused(freshCompany(), 'create_journal', journal([['5300', '5', '5'], ['1002', '0', '0'], ['3000', '0', '0']]), 'Journal accounts and amounts must be valid.');
  });

  it('ACC-008 negative amount is refused [case-corrected: rejected at validation with "Amount cannot be negative."]', () => {
    refused(freshCompany(), 'create_journal', journal([['5300', '-1', '0'], ['1002', '0', '-1']]), 'Amount cannot be negative.');
  });

  it('ACC-009 one line only fails validation (min 2)', () => {
    refused(freshCompany(), 'create_journal', journal([['5300', '0', '0']]), /too_small/);
  });

  it('ACC-010 zero lines are dropped; if nothing is left no journal is posted [documented: the command still reports "Balanced journal posted."]', () => {
    const r = run(freshCompany(), 'create_journal', journal([['5300', '0', '0'], ['1002', '0', '0']]));
    expect(r.workspace.journals).toEqual([]);
    expect(r.message).toBe('Balanced journal posted.');
    const mixed = run(freshCompany(), 'create_journal', journal([['5300', '10', '0'], ['1100', '0', '0'], ['1002', '0', '10']])).workspace;
    expect(last(mixed).lines.map(l => l.account)).toEqual(['5300', '1002']);
  });

  it('ACC-011 0.0001 amounts post', () => {
    const w = run(freshCompany(), 'create_journal', journal([['5300', '0.0001', '0'], ['1002', '0', '0.0001']])).workspace;
    expect(bal(w, '5300')).toBe('0.0001');
  });

  it('ACC-012 empty memo [documented: an empty string is allowed; omitting memo fails validation]', () => {
    const w = run(freshCompany(), 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']], '')).workspace;
    expect(last(w).memo).toBe('');
    refused(freshCompany(), 'create_journal', { date: T, lines: journal([['5300', '1', '0'], ['1002', '0', '1']]).lines }, /invalid_type/);
  });

  it('ACC-013 journal using a bank account code is allowed', () => {
    let w = run(freshCompany(), 'save_bank_account', { name: 'HBL', type: 'bank' }).workspace;
    w = run(w, 'create_journal', journal([['1003', '500', '0'], ['3000', '0', '500']], 'Capital')).workspace;
    expect(bal(w, '1003')).toBe('500.0000');
  });

  it('ACC-014 reversing a manual journal posts swapped lines with reversalOf [case-corrected: memo "Reversal · JV-00001"; message is the generic "Changes saved."]', () => {
    let r = run(freshCompany(), 'create_journal', journal([['5300', '100', '0'], ['1002', '0', '100']]));
    const original = last(r.workspace);
    r = run(r.workspace, 'reverse_journal', { id: original.id, date: T });
    expect(r.message).toBe('Changes saved.');
    expect(last(r.workspace)).toMatchObject({ number: 'JV-00002', memo: 'Reversal · JV-00001', reversalOf: original.id, lines: [{ account: '5300', debit: '0.0000', credit: '100.0000' }, { account: '1002', debit: '100.0000', credit: '0.0000' }] });
    expect(bal(r.workspace, '5300')).toBe('0.0000');
  });

  it('ACC-015 reversing twice is refused', () => {
    let w = run(freshCompany(), 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']])).workspace;
    const id = last(w).id;
    w = run(w, 'reverse_journal', { id }).workspace;
    refused(w, 'reverse_journal', { id }, 'Journal is already reversed.');
  });

  it('ACC-016 reversing an invoice journal is refused', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    refused(w, 'reverse_journal', { id: jFor(w, inv)[0].id }, 'Use the source document\'s correction workflow for operational journals.');
  });

  it('ACC-017 reversing an opening-balance journal is refused (demo opening balances and opening stock entered in-app) [defect]', () => {
    const demo = buildDemoWorkspace();
    refused(demo, 'reverse_journal', { id: demo.journals.find(j => j.sourceId === 'opening-balances')!.id }, "Use the source document's correction workflow for operational journals.");
    // Opening stock entered through Inventory (bulk_stock_increase, purpose opening_stock) posts Dr 1200 / Cr 3000 with the user's reason as memo.
    const { w } = base();
    const opening = w.journals.find(j => j.lines.some(l => l.account === '3000'))!;
    let error: unknown; let after: Workspace | undefined;
    try { after = run(w, 'reverse_journal', { id: opening.id }).workspace; } catch (e) { error = e; }
    if (after) expect(invariants(after).inventory, 'inventory control after reversing opening stock').toBe(true);
    expect(error, 'reversal of an opening-stock journal should be refused').toBeInstanceOf(Error);
  });

  it('ACC-018 reversing a receipt journal is refused', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    const r = run(w, 'create_receipt', receiptPayload(cust, inv, '100'));
    refused(r.workspace, 'reverse_journal', { id: jFor(r.workspace, `${r.recordId}:cleared`)[0].id }, "Use the source document's correction workflow for operational journals.");
  });

  it('ACC-019 reversal with a custom date is dated accordingly; a locked date is refused', () => {
    let w = run(freshCompany(), 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']], 'Manual', '2026-09-10')).workspace;
    const id = last(w).id;
    expect(last(run(w, 'reverse_journal', { id, date: '2026-09-20' }).workspace).date).toBe('2026-09-20');
    w = run(w, 'set_period', { month: '2026-08', locked: true }).workspace;
    refused(w, 'reverse_journal', { id, date: '2026-08-31' }, 'Accounting period 2026-08 is locked.');
  });

  it('ACC-020 lock period 2026-09', () => {
    const r = run(freshCompany(), 'set_period', { month: '2026-09', locked: true }, accountant);
    expect(r.message).toBe('Period locked.');
    expect(r.workspace.periods).toEqual([{ month: '2026-09', locked: true }]);
  });

  it('ACC-021 posting anything dated in a locked month is refused', () => {
    let { w, item, cust } = base();
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    const msg = 'Accounting period 2026-09 is locked.';
    refused(w, 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']], 'x', '2026-09-30'), msg);
    refused(w, 'record_expense', { accountId: 'cash', amount: '1', date: '2026-09-01', memo: 'Fuel' }, msg);
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: w.warehouses[0].id, date: '2026-09-15', dueDate: '2026-09-15', lines: [{ itemId: item, quantity: '1', price: '1', discount: '0', taxRate: '0', employeeId: '', splits: [] }] }, msg);
    refused(w, 'stock_adjust', { itemId: item, warehouseId: w.warehouses[0].id, quantity: '-1', date: '2026-09-15', reason: 'Damage' }, msg);
  });

  it('ACC-022 Accountant cannot reopen a period', () => {
    const w = run(freshCompany(), 'set_period', { month: '2026-09', locked: true }).workspace;
    refused(w, 'set_period', { month: '2026-09', locked: false }, 'Only the owner can reopen an accounting period.', accountant);
  });

  it('ACC-023 Owner reopens a period', () => {
    let w = run(freshCompany(), 'set_period', { month: '2026-09', locked: true }).workspace;
    const r = run(w, 'set_period', { month: '2026-09', locked: false });
    expect(r.message).toBe('Period reopened.');
    w = run(r.workspace, 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']], 'x', '2026-09-30')).workspace;
    expect(last(w).date).toBe('2026-09-30');
  });

  it('ACC-024 lock month 2026-00 fails validation', () => {
    refused(freshCompany(), 'set_period', { month: '2026-00', locked: true }, /invalid_format/);
  });

  it('ACC-025 locking the current month blocks an invoice dated today', () => {
    let { w, item, cust } = base();
    w = run(w, 'set_period', { month: MONTH, locked: true }).workspace;
    refused(w, 'create_document', { kind: 'sales_invoice', partyId: cust, warehouseId: w.warehouses[0].id, date: T, dueDate: T, lines: [{ itemId: item, quantity: '1', price: '1', discount: '0', taxRate: '0', employeeId: '', splits: [] }] }, `Accounting period ${MONTH} is locked.`);
  });

  it('ACC-026 locking a future month is allowed; postings there are refused', () => {
    const w = run(freshCompany(), 'set_period', { month: '2027-06', locked: true }).workspace;
    refused(w, 'record_expense', { accountId: 'cash', amount: '1', date: '2027-06-15', memo: 'Fuel' }, 'Accounting period 2027-06 is locked.');
    expect(run(w, 'record_expense', { accountId: 'cash', amount: '1', date: '2027-07-01', memo: 'Fuel' }).workspace.journals).toHaveLength(1);
  });

  it('ACC-027 reports for a locked month can still be viewed', () => {
    let w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '40', date: '2026-09-12', memo: 'Fuel' }).workspace;
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    expect(profitAndLoss(w, '2026-09-01', '2026-09-30').totalExpenses).toBe('40.0000');
    expect(trialBalance(w, '2026-09-30').totalDebit).toBe('40.0000');
  });

  it('ACC-028 submitting a draft dated in a locked month is refused; redating to an open month works', () => {
    let { w, item, cust } = base(); let inv: string;
    const lines = [{ itemId: item, quantity: '1', price: '100', discount: '0', taxRate: '0', employeeId: '', splits: [] }];
    [w, inv] = withDocument(w, 'sales_invoice', cust, lines, { date: '2026-09-20', dueDate: '2026-09-20' }, false);
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    refused(w, 'submit_document', { id: inv }, 'Accounting period 2026-09 is locked.');
    w = run(w, 'update_document', { id: inv, partyId: cust, warehouseId: w.warehouses[0].id, date: T, dueDate: T, lines }).workspace;
    w = run(w, 'submit_document', { id: inv }).workspace;
    expect(w.documents.find(d => d.id === inv)!.status).toBe('submitted');
    expectInvariants(w);
  });

  it('ACC-029 Salesperson cannot set a period', () => {
    refused(freshCompany(), 'set_period', { month: '2026-09', locked: true }, 'Your role does not permit this action.', actor('Salesperson'));
  });

  it('ACC-030 posting the same source twice is refused', () => {
    const w = structuredClone(freshCompany());
    postJournal(w, 'qa-source-1', 'first', [{ account: '5300', debit: '1', credit: '0' }, { account: '1002', debit: '0', credit: '1' }], T);
    expect(() => postJournal(w, 'qa-source-1', 'second', [{ account: '5300', debit: '1', credit: '0' }, { account: '1002', debit: '0', credit: '1' }], T)).toThrow('This source has already been posted.');
    expect(w.journals).toHaveLength(1);
  });

  it('ACC-031 every posting document submit yields exactly one journal for its source', () => {
    const w = buildDemoWorkspace();
    const posting = ['delivery', 'sales_invoice', 'credit_note', 'goods_receipt', 'supplier_invoice', 'supplier_return'];
    for (const d of w.documents.filter(x => x.status === 'submitted')) expect(jFor(w, d.id).length, `${d.number}`).toBe(posting.includes(d.kind) ? 1 : 0);
    for (const r of w.receipts.filter(x => x.status === 'cleared' || x.status === 'bounced')) expect(jFor(w, `${r.id}:cleared`)).toHaveLength(1);
  });

  it('ACC-032 posted journals are immutable: no update command exists', () => {
    const types = commandSchema.shape.type.options as readonly string[];
    expect(types.filter(t => t.includes('journal'))).toEqual(['create_journal', 'reverse_journal']);
    expect(() => execute(freshCompany(), { type: 'update_journal', payload: {}, idempotencyKey: 'qa-update-journal' }, owner)).toThrow(/invalid_value/);
  });

  it('ACC-033 journal numbering is sequential [case-corrected: JV-00001 style, not J-2026-0001]', () => {
    const w = buildDemoWorkspace();
    expect(w.journals.map(j => j.number)).toEqual(w.journals.map((_, i) => `JV-${String(i + 1).padStart(5, '0')}`));
  });

  it('ACC-034 a failed command leaves no gap in journal numbering', () => {
    let w = run(freshCompany(), 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']])).workspace;
    refused(w, 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '2']]), 'Journal debits and credits must balance.');
    w = run(w, 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']])).workspace;
    expect(w.journals.map(j => j.number)).toEqual(['JV-00001', 'JV-00002']);
  });

  it('ACC-035 receivable control equals open customer balances', () => { expect(invariants(buildDemoWorkspace()).receivable).toBe(true); });
  it('ACC-036 payable control equals open supplier balances plus unbilled import charges', () => { expect(invariants(buildDemoWorkspace()).payable).toBe(true); });
  it('ACC-037 inventory control equals stock valuation', () => { expect(invariants(buildDemoWorkspace()).inventory).toBe(true); });

  it('ACC-038 cash/bank control equals the account balances', () => {
    const w = buildDemoWorkspace();
    const tb = trialBalance(w, '2099-12-31');
    const fromTb = sum(tb.rows.filter(r => ['1000', ...w.bankAccounts.map(a => a.code)].includes(r.code)).map(r => D(r.debit || 0).minus(r.credit || 0)));
    expect(money(fromTb)).toBe(money(sum(['1000', ...w.bankAccounts.map(a => a.code)].map(c => bal(w, c)))));
  });

  it('ACC-039 commission payable equals earned − paid', () => { expect(invariants(buildDemoWorkspace()).commission).toBe(true); });

  it('ACC-040 output tax equals invoice tax less credit note tax', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '10', price: '100', taxRate: '18' }]);
    [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '3', price: '33.33', taxRate: '17' }]);
    w = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '4' }] }).workspace;
    const expected = sum(w.documents.filter(d => d.kind === 'sales_invoice').map(d => d.tax)).minus(sum(w.documents.filter(d => d.kind === 'credit_note').map(d => d.tax)));
    expect(money(D(bal(w, '2100')).negated())).toBe(money(expected));
    expect(money(expected)).toBe('124.9983');
  });

  it('ACC-041 input tax equals bill tax less supplier-return tax', () => {
    let { w, item, sup } = base(); let bill: string;
    [w, bill] = withDocument(w, 'supplier_invoice', sup, [{ itemId: item, quantity: '10', price: '50', taxRate: '18' }]);
    w = run(w, 'return_document', { id: bill, date: T, lines: [{ lineId: w.documents.find(d => d.id === bill)!.lines[0].id, quantity: '2' }] }).workspace;
    expect(bal(w, '1300')).toBe('72.0000');
    expect(money(sum(w.documents.filter(d => d.kind === 'supplier_invoice').map(d => d.tax)).minus(sum(w.documents.filter(d => d.kind === 'supplier_return').map(d => d.tax))))).toBe('72.0000');
    expectInvariants(w);
  });

  it('ACC-042 balance sheet: assets − liabilities − equity = 0 exactly', () => {
    const w = buildDemoWorkspace();
    for (const asOf of ['2026-09-15', '2026-09-30', '2099-12-31']) expect(balanceSheet(w, asOf).difference).toBe('0.0000');
  });

  it('ACC-043 P&L net = revenue − COGS − expenses, matching the ledger', () => {
    const w = buildDemoWorkspace();
    const pl = profitAndLoss(w, '0000-01-01', '2099-12-31');
    const ledger = sum(Object.keys(chartOf(w)).filter(c => /^[45]/.test(c)).map(c => D(bal(w, c)).negated()));
    expect(pl.netProfit).toBe(money(ledger));
    expect(pl.netProfit).toBe(money(D(pl.totalRevenue).minus(pl.totalExpenses)));
  });

  it('ACC-044 current-year profit on the balance sheet equals P&L', () => {
    const w = buildDemoWorkspace();
    const bs = balanceSheet(w, '2026-09-30');
    expect(bs.equity.at(-1)).toMatchObject({ name: 'Retained earnings (current)', amount: profitAndLoss(w, '0000-01-01', '2026-09-30').netProfit });
  });

  it('ACC-045 general ledger running balance per account is correct', () => {
    const w = buildDemoWorkspace();
    for (const code of ['1100', '1200', '2000', '4000']) {
      const gl = generalLedger(w, code, '0000-01-01', '2099-12-31');
      let running = D(gl.opening);
      for (const r of gl.rows) { running = running.plus(r.debit || 0).minus(r.credit || 0); expect(r.balance).toBe(money(running)); }
      expect(gl.closing).toBe(bal(w, code));
    }
  });

  it('ACC-046 every account code used in a journal has a name', () => {
    const w = buildDemoWorkspace(); const chart = chartOf(w);
    expect([...new Set(w.journals.flatMap(j => j.lines.map(l => l.account)))].filter(c => !chart[c])).toEqual([]);
  });

  it('ACC-047 manual journal in a locked period is refused', () => {
    const w = run(freshCompany(), 'set_period', { month: '2026-09', locked: true }).workspace;
    refused(w, 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']], 'x', '2026-09-10'), 'Accounting period 2026-09 is locked.');
  });

  it('ACC-048 manual journal to control accounts [documented: allowed; reconciliation then shows a variance]', () => {
    const { w } = base();
    for (const [code, key] of [['1100', 'receivable'], ['2000', 'payable'], ['1200', 'inventory']] as const) {
      const after = run(w, 'create_journal', journal([[code, '10', '0'], ['3000', '0', '10']])).workspace;
      expect(invariants(after)[key]).toBe(false);
    }
  });

  it('ACC-049 Auditor cannot create a journal', () => {
    refused(freshCompany(), 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']]), 'Your role does not permit this action.', actor('Auditor'));
  });

  it('ACC-050 Accountant can create and reverse', () => {
    let w = run(freshCompany(), 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']]), accountant).workspace;
    w = run(w, 'reverse_journal', { id: last(w).id }, accountant).workspace;
    expect(w.journals).toHaveLength(2);
  });

  it('ACC-051 Sales Manager receives no journals [browser: Accounting hidden]', () => {
    expect(scopeWorkspace(buildDemoWorkspace(), actor('Sales Manager')).journals).toEqual([]);
  });

  it('ACC-052 branch-limited Owner receives no journals (company-wide)', () => {
    const w = buildDemoWorkspace();
    expect(scopeWorkspace(w, actor('Owner', { branchIds: ['karachi'] })).journals).toEqual([]);
    expect(scopeWorkspace(w, owner).journals).toHaveLength(w.journals.length);
  });

  it.todo('ACC-053 [browser] journal search by memo or number');
  it.todo('ACC-054 [browser] journal list date-range filter (Accounting view shows the latest 8; Reports → General ledger has a date range)');

  it('ACC-055 journal print/export [documented: not present in the Accounting view; Reports offers General ledger / Trial balance CSV]', () => {
    const accounting = source('src/components/workbench.tsx').split("if(active==='accounting')")[1].split('\n')[0];
    expect(accounting).not.toMatch(/toCsv|Export|print/i);
  });

  it('ACC-056 rounding: three lines of 33.3333 against 100 are refused; allocation balances to 4 dp [documented: manual journals are not auto-allocated]', () => {
    refused(freshCompany(), 'create_journal', journal([['5300', '33.3333', '0'], ['5200', '33.3333', '0'], ['5100', '33.3333', '0'], ['1002', '0', '100']]), 'Journal debits and credits must balance.');
    const parts = allocate('100', ['1', '1', '1']);
    expect(parts).toEqual(['33.3333', '33.3333', '33.3334']);
    const w = run(freshCompany(), 'create_journal', journal([['5300', parts[0], '0'], ['5200', parts[1], '0'], ['5100', parts[2], '0'], ['1002', '0', '100']])).workspace;
    expect(balanced(w)).toBe(true);
  });

  it('ACC-057 FX gain/loss postings balance', () => {
    let { w, item, sup } = base(); let bill: string;
    [w, bill] = withDocument(w, 'supplier_invoice', sup, [{ itemId: item, quantity: '10', price: '10' }], { currency: 'USD', fxRate: '280' });
    expect(bal(w, '2000')).toBe('-28000.0000');
    const r = run(w, 'create_receipt', { partyId: sup, date: T, amount: '28500', method: 'bank', dueDate: T, allocations: [{ invoiceId: bill, amount: '100' }], accountId: 'main-bank' });
    expect(jFor(r.workspace, `${r.recordId}:cleared`)[0].lines).toEqual([{ account: '2000', debit: '28000.0000', credit: '0.0000' }, { account: '1001', debit: '0.0000', credit: '28500.0000' }, { account: '5400', debit: '500.0000', credit: '0.0000' }]);
    expect(bal(r.workspace, '2000')).toBe('0.0000');
    expectInvariants(r.workspace);
  });

  it('ACC-058 landed cost postings balance', () => {
    const w = buildDemoWorkspace();
    const landed = w.journals.filter(j => j.memo.startsWith('Landed costs'));
    expect(landed).toHaveLength(1);
    expect(balanced({ ...w, journals: landed })).toBe(true);
    expect(landed[0].lines.find(l => l.account === '2000')).toEqual({ account: '2000', debit: '0.0000', credit: '480000.0000' });
  });

  it('ACC-059 payroll postings balance', () => {
    const w = buildDemoWorkspace();
    const pr = w.payrolls.find(p => p.status === 'paid')!;
    const posted = w.journals.filter(j => j.sourceId.startsWith(pr.id));
    expect(posted.map(j => j.sourceId)).toEqual([`${pr.id}:approve`, `${pr.id}:paid`]);
    expect(balanced({ ...w, journals: posted })).toBe(true);
  });

  it('ACC-060 bounce reversal mirrors the clearing journal exactly', () => {
    const w = buildDemoWorkspace();
    const bounced = w.receipts.find(r => r.status === 'bounced')!;
    const clear = jFor(w, `${bounced.id}:cleared`)[0], rev = jFor(w, `${bounced.id}:bounce`)[0];
    expect(rev.reversalOf).toBe(clear.id);
    expect(rev.lines).toEqual(clear.lines.map(l => ({ account: l.account, debit: l.credit, credit: l.debit })));
  });

  it('ACC-061 opening stock posts Dr inventory / Cr owner\'s capital (3000)', () => {
    const { w } = base();
    expect(w.journals[0].lines).toEqual([{ account: '1200', debit: '6000.0000', credit: '0.0000' }, { account: '3000', debit: '0.0000', credit: '6000.0000' }]);
  });

  it('ACC-062 count correction posts to 5300', () => {
    let { w, item, wh } = base();
    w = run(w, 'set_stock_quantity', { itemId: item, warehouseId: wh, expectedQuantity: '100', targetQuantity: '95', date: T, reason: 'Cycle count' }).workspace;
    expect(last(w).lines).toEqual([{ account: '5300', debit: '300.0000', credit: '0.0000' }, { account: '1200', debit: '0.0000', credit: '300.0000' }]);
    expectInvariants(w);
  });

  it('ACC-063 stock transfer posts no journal', () => {
    let { w, item, wh } = base();
    w = run(w, 'save_warehouse', { name: 'Port store', branchId: w.branches[0].id }).workspace;
    const before = w.journals.length;
    w = run(w, 'stock_transfer', { itemId: item, from: wh, to: 'port-store', quantity: '10', date: T }).workspace;
    expect(w.journals).toHaveLength(before);
    expectInvariants(w);
  });

  it('ACC-064 a cancelled draft posts no journal', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }], {}, false);
    w = run(w, 'cancel_document', { id: inv }).workspace;
    expect(jFor(w, inv)).toEqual([]);
  });

  it('ACC-065 quotation and sales order submits post no journal', () => {
    let { w, item, cust, sup } = base(); let q: string, so: string, po: string;
    [w, q] = withDocument(w, 'quotation', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    [w, so] = withDocument(w, 'sales_order', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    [w, po] = withDocument(w, 'purchase_order', sup, [{ itemId: item, quantity: '1', price: '100' }]);
    for (const id of [q, so, po]) { expect(w.documents.find(d => d.id === id)!.status).toBe('submitted'); expect(jFor(w, id)).toEqual([]); }
  });

  it('ACC-066 delivery journal is COGS only', () => {
    let { w, item, cust } = base(); let dn: string;
    [w, dn] = withDocument(w, 'delivery', cust, [{ itemId: item, quantity: '5', price: '100' }]);
    expect(jFor(w, dn)[0].lines).toEqual([{ account: '5000', debit: '300.0000', credit: '0.0000' }, { account: '1200', debit: '0.0000', credit: '300.0000' }]);
  });

  it('ACC-067 invoice converted from a delivery posts no COGS', () => {
    let { w, item, cust } = base(); let dn: string;
    [w, dn] = withDocument(w, 'delivery', cust, [{ itemId: item, quantity: '5', price: '100' }]);
    const inv = run(w, 'convert_document', { id: dn, date: T });
    w = run(inv.workspace, 'submit_document', { id: inv.recordId }).workspace;
    expect(jFor(w, inv.recordId)[0].lines.map(l => l.account)).toEqual(['1100', '4000']);
    expect(bal(w, '5000')).toBe('300.0000');
    expectInvariants(w);
  });

  it('ACC-068 direct invoice posts COGS and revenue', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '5', price: '100', taxRate: '18' }]);
    expect(jFor(w, inv)[0].lines).toEqual([
      { account: '5000', debit: '300.0000', credit: '0.0000' }, { account: '1200', debit: '0.0000', credit: '300.0000' },
      { account: '1100', debit: '590.0000', credit: '0.0000' }, { account: '4000', debit: '0.0000', credit: '500.0000' }, { account: '2100', debit: '0.0000', credit: '90.0000' },
    ]);
  });

  it('ACC-069 credit note reverses proportionally', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '5', price: '100', taxRate: '18' }]);
    const r = run(w, 'return_document', { id: inv, date: T, lines: [{ lineId: w.documents.find(d => d.id === inv)!.lines[0].id, quantity: '2' }] });
    expect(jFor(r.workspace, r.recordId)[0].lines).toEqual([
      { account: '4000', debit: '200.0000', credit: '0.0000' }, { account: '2100', debit: '36.0000', credit: '0.0000' }, { account: '1100', debit: '0.0000', credit: '236.0000' },
      { account: '1200', debit: '120.0000', credit: '0.0000' }, { account: '5000', debit: '0.0000', credit: '120.0000' },
    ]);
    expectInvariants(r.workspace);
  });

  it('ACC-070 supplier return reverses the bill', () => {
    let { w, item, sup } = base(); let bill: string;
    [w, bill] = withDocument(w, 'supplier_invoice', sup, [{ itemId: item, quantity: '10', price: '80', taxRate: '18' }]);
    const r = run(w, 'return_document', { id: bill, date: T, lines: [{ lineId: w.documents.find(d => d.id === bill)!.lines[0].id, quantity: '5' }] });
    expect(jFor(r.workspace, r.recordId)[0].lines).toEqual([
      { account: '2000', debit: '472.0000', credit: '0.0000' }, { account: '1300', debit: '0.0000', credit: '72.0000' }, { account: '1200', debit: '0.0000', credit: '400.0000' },
    ]);
    expectInvariants(r.workspace);
  });

  it('ACC-071 expense journal', () => {
    const w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '20', date: T, memo: 'Tea' }).workspace;
    expect(last(w)).toMatchObject({ memo: 'Expense · Tea', lines: [{ account: '5300', debit: '20.0000', credit: '0.0000' }, { account: '1002', debit: '0.0000', credit: '20.0000' }] });
  });

  it('ACC-072 transfer journal', () => {
    const w = run(freshCompany(), 'bank_transfer', { fromId: 'cash', toId: 'main-bank', amount: '20', date: T }).workspace;
    expect(last(w).lines).toEqual([{ account: '1001', debit: '20.0000', credit: '0.0000' }, { account: '1002', debit: '0.0000', credit: '20.0000' }]);
  });

  it('ACC-073 receipt journal: Dr bank / Cr receivable', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    const r = run(w, 'create_receipt', receiptPayload(cust, inv, '100'));
    expect(jFor(r.workspace, `${r.recordId}:cleared`)[0].lines).toEqual([{ account: '1001', debit: '100.0000', credit: '0.0000' }, { account: '1100', debit: '0.0000', credit: '100.0000' }]);
  });

  it('ACC-074 cheque posts only on clearance, dated the clearing date', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    const r = run(w, 'create_receipt', receiptPayload(cust, inv, '100', { method: 'cheque', chequeNo: 'C1', accountId: undefined }));
    w = run(r.workspace, 'update_cheque', { id: r.recordId, status: 'deposited', date: T, accountId: 'main-bank' }).workspace;
    expect(jFor(w, `${r.recordId}:cleared`)).toEqual([]);
    w = run(w, 'update_cheque', { id: r.recordId, status: 'cleared', date: T }).workspace;
    expect(jFor(w, `${r.recordId}:cleared`)[0]).toMatchObject({ date: T, lines: [{ account: '1001', debit: '100.0000', credit: '0.0000' }, { account: '1100', debit: '0.0000', credit: '100.0000' }] });
  });

  it('ACC-075 commission accrual journal', () => {
    let { w, item, cust } = base(); let inv: string;
    w = run(w, 'save_plan', { ...w.plans[0], rate: '2' }).workspace;
    const e = run(w, 'save_employee', { name: 'Hamza', role: 'OB', territory: '', salary: '1', allowance: '0', deduction: '0', attendance: 30, active: true }); w = e.workspace;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '5', price: '100', employeeId: e.recordId }]);
    expect(jFor(w, `${inv}:commission`)[0].lines).toEqual([{ account: '5100', debit: '10.0000', credit: '0.0000' }, { account: '2200', debit: '0.0000', credit: '10.0000' }]);
  });

  it('ACC-076 landed-cost allocation journal', () => {
    let { w, item, sup } = base(); let grn: string;
    [w, grn] = withDocument(w, 'goods_receipt', sup, [{ itemId: item, quantity: '10', price: '50' }]);
    const sh = run(w, 'create_shipment', { documentId: grn, eta: T });
    w = sh.workspace;
    for (const [label, amount, classification] of [['Freight', '100', 'inventory'], ['Sales tax', '30', 'recoverable_tax'], ['Deposit', '20', 'deposit'], ['Agent', '10', 'expense']]) w = run(w, 'add_shipment_cost', { id: sh.recordId, label, amount, classification, basis: 'value' }).workspace;
    w = run(w, 'allocate_shipment', { id: sh.recordId, date: T }).workspace;
    expect(last(w).lines).toEqual([
      { account: '1200', debit: '100.0000', credit: '0.0000' }, { account: '1300', debit: '30.0000', credit: '0.0000' },
      { account: '1400', debit: '20.0000', credit: '0.0000' }, { account: '5300', debit: '10.0000', credit: '0.0000' }, { account: '2000', debit: '0.0000', credit: '160.0000' },
    ]);
    expectInvariants(w);
  });

  it('ACC-077 period list shows locked months', () => {
    let w = run(freshCompany(), 'set_period', { month: '2026-08', locked: true }).workspace;
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    expect(w.periods.filter(p => p.locked).map(p => p.month)).toEqual(['2026-08', '2026-09']);
  });

  it('ACC-078 lock, unlock, lock leaves the period locked once', () => {
    let w = run(freshCompany(), 'set_period', { month: '2026-09', locked: true }).workspace;
    w = run(w, 'set_period', { month: '2026-09', locked: false }).workspace;
    expect(w.periods).toEqual([{ month: '2026-09', locked: false }]);
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    expect(w.periods).toEqual([{ month: '2026-09', locked: true }]);
  });

  it('ACC-079 period changes are audited', () => {
    let w = run(freshCompany(), 'set_period', { month: '2026-09', locked: true }, accountant).workspace;
    w = run(w, 'set_period', { month: '2026-09', locked: false }).workspace;
    expect(w.audit.slice(-2).map(a => [a.action, a.role, a.sourceId, a.detail])).toEqual([['set_period', 'Accountant', '2026-09', 'Period locked.'], ['set_period', 'Owner', '2026-09', 'Period reopened.']]);
  });

  it('ACC-080 invariant sweep after a full trading cycle (demo plus further sales, purchases, collections, returns, payroll)', () => {
    let w = buildDemoWorkspace();
    expectInvariants(w);
    const inv = run(w, 'create_document', { kind: 'sales_invoice', partyId: 'c-1', warehouseId: 'khi-main', date: '2026-10-10', dueDate: '2026-10-31', lines: [{ itemId: 'i-1', quantity: '20', price: '2500', discount: '5', taxRate: '18', employeeId: 'e-4', splits: [] }] });
    w = run(inv.workspace, 'submit_document', { id: inv.recordId }).workspace;
    const total = w.documents.find(d => d.id === inv.recordId)!.total;
    w = run(w, 'create_receipt', { partyId: 'c-1', date: '2026-10-11', amount: total, method: 'bank', dueDate: '2026-10-11', allocations: [{ invoiceId: inv.recordId, amount: total }], accountId: 'main-bank' }).workspace;
    const pdc = w.receipts.find(r => r.status === 'received')!;
    w = run(w, 'update_cheque', { id: pdc.id, status: 'deposited', date: '2026-10-05', accountId: 'main-bank' }).workspace;
    w = run(w, 'update_cheque', { id: pdc.id, status: 'cleared', date: '2026-10-06' }).workspace;
    const bill = w.documents.find(d => d.kind === 'supplier_invoice')!;
    w = run(w, 'create_receipt', { partyId: bill.partyId, date: '2026-10-12', amount: '1290000', method: 'bank', dueDate: '2026-10-12', allocations: [{ invoiceId: bill.id, amount: outstandingOf(bill) }], accountId: 'main-bank' }).workspace;
    const sh = w.shipments[0];
    w = run(w, 'allocate_shipment', { id: sh.id, date: '2026-10-12' }).workspace;
    expectInvariants(w);
    const tb = trialBalance(w, '2099-12-31');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(balanceSheet(w, '2099-12-31').difference).toBe('0.0000');
  });

  it('ACC-081 invariant sweep after 100 random valid commands (fuzz)', () => {
    let { w, item, cust, sup } = base(); const rand = rng(7); let applied = 0;
    const invoices: string[] = []; const bills: string[] = [];
    for (let i = 0; i < 100; i++) {
      const qty = String(1 + Math.floor(rand() * 5)); const price = money(D(Math.floor(rand() * 20000)).div(100).plus(1));
      const op = Math.floor(rand() * 8);
      try {
        if (op === 0) { let id: string; [w, id] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: qty, price, taxRate: rand() < 0.5 ? '18' : '0' }]); invoices.push(id); }
        else if (op === 1) { let id: string; [w, id] = withDocument(w, 'supplier_invoice', sup, [{ itemId: item, quantity: qty, price, taxRate: '18' }]); bills.push(id); }
        else if (op === 2 && invoices.length) { const pick = invoices[Math.floor(rand() * invoices.length)]; const d = w.documents.find(x => x.id === pick)!; const open = D(outstandingOf(d)); const part = open.gte('0.02') ? open.div(2).toDecimalPlaces(2, 1) : open; if (open.gt(0)) w = run(w, 'create_receipt', receiptPayload(cust, d.id, money(part))).workspace; }
        else if (op === 3 && bills.length) { const pick = bills[Math.floor(rand() * bills.length)]; const d = w.documents.find(x => x.id === pick)!; const open = outstandingOf(d); if (D(open).gt(0)) w = run(w, 'create_receipt', receiptPayload(sup, d.id, open)).workspace; }
        else if (op === 4 && invoices.length) { const pick = invoices[Math.floor(rand() * invoices.length)]; const d = w.documents.find(x => x.id === pick)!; const l = d.lines[0]; if (D(l.quantity).minus(l.returned).gte(1)) w = run(w, 'return_document', { id: d.id, date: T, lines: [{ lineId: l.id, quantity: '1' }] }).workspace; }
        else if (op === 5) w = run(w, 'record_expense', { accountId: rand() < 0.5 ? 'cash' : 'main-bank', amount: price, date: T, memo: `Fuzz ${i}` }).workspace;
        else if (op === 6) w = run(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: price, date: T }).workspace;
        else w = run(w, 'create_journal', journal([['5300', price, '0'], ['3000', '0', price]], `Fuzz ${i}`)).workspace;
        applied++;
      } catch (e) { if (!/Insufficient stock|Customer credit limit/.test((e as Error).message)) throw e; }
    }
    expect(applied).toBeGreaterThan(80);
    expectInvariants(w);
    const tb = trialBalance(w, '2099-12-31');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(balanceSheet(w, '2099-12-31').difference).toBe('0.0000');
  });

  it('ACC-082 retries with reused idempotency keys create no duplicate journals', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    const commands: [string, Record<string, unknown>][] = [['create_receipt', receiptPayload(cust, inv, '50')], ['record_expense', { accountId: 'cash', amount: '5', date: T, memo: 'Fuel' }], ['bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '5', date: T }], ['create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']])]];
    commands.forEach(([type, payload], i) => { for (let k = 0; k < 3; k++) w = run(w, type, payload, owner, `qa-retry-key-${i}`).workspace; });
    expect(w.journals).toHaveLength(2 + commands.length);
    expect(new Set(w.journals.map(j => j.sourceId)).size).toBe(w.journals.length);
    expectInvariants(w);
  });

  it('ACC-083 journals dated out of order: trial balance by date is correct', () => {
    let w = run(freshCompany(), 'create_journal', journal([['5300', '10', '0'], ['1002', '0', '10']], 'late', '2026-10-05')).workspace;
    w = run(w, 'create_journal', journal([['5300', '3', '0'], ['1002', '0', '3']], 'early', '2026-09-05')).workspace;
    expect(trialBalance(w, '2026-09-30').totalDebit).toBe('3.0000');
    expect(trialBalance(w, '2026-10-31').totalDebit).toBe('13.0000');
    expect(generalLedger(w, '5300', '2026-01-01', '2026-12-31').rows.map(r => r.memo)).toEqual(['early', 'late']);
  });

  it('ACC-084 year boundary: invoice numbering resets per year; P&L per year', () => {
    let { w, item, cust } = base(); let a: string, b: string;
    [w, a] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }], { date: '2026-12-31', dueDate: '2026-12-31' });
    [w, b] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '200' }], { date: '2027-01-01', dueDate: '2027-01-01' });
    expect([w.documents.find(d => d.id === a)!.number, w.documents.find(d => d.id === b)!.number]).toEqual(['INV-2026-0001', 'INV-2027-0001']);
    expect(profitAndLoss(w, '2026-01-01', '2026-12-31').totalRevenue).toBe('100.0000');
    expect(profitAndLoss(w, '2027-01-01', '2027-12-31').totalRevenue).toBe('200.0000');
  });

  it('ACC-085 database projection: journals table matches the snapshot (count and sums) [local PGlite, project migrations]', async () => {
    const { data, revision } = await snapshot();
    const next = execute(data, { type: 'create_journal', idempotencyKey: 'qa-acc-085', payload: journal([['1000', '500', '0'], ['3000', '0', '500']], 'Owner top-up', '2026-10-05') }, owner).workspace;
    expect(await commit(revision, next)).toBe(revision + 1);
    const p = await projection();
    expect(p.journals).toBe(next.journals.length);
    expect(p.lines).toBe(next.journals.reduce((n, j) => n + j.lines.length, 0));
    expect(p.debit).toBe(money(sum(next.journals.flatMap(j => j.lines.map(l => l.debit)))));
    expect(p.debit).toBe(p.credit);
  }, 60_000);

  it('ACC-086 projection rebuild (p_rebuild=true) is idempotent [local PGlite]', async () => {
    const { data, revision } = await snapshot();
    expect(await commit(revision, { ...data, revision: revision + 1 }, true)).toBe(revision + 1);
    const first = await projection();
    const again = await snapshot();
    expect(await commit(again.revision, { ...again.data, revision: again.revision + 1 }, true)).toBe(again.revision + 1);
    expect(await projection()).toEqual(first);
  }, 60_000);

  it('ACC-087 commit_workspace with an unbalanced journal [documented: the database rejects it ("not balanced") and keeps the old revision]', async () => {
    const db = await database();
    const { data, revision } = await snapshot();
    const broken = structuredClone(data); broken.revision = revision + 1;
    broken.journals.push({ id: 'qa-unbalanced', number: 'JV-99999', sourceId: 'qa-unbalanced', date: '2026-10-05', memo: 'bad', status: 'posted', lines: [{ account: '1000', debit: '10.0000', credit: '0.0000' }, { account: '3000', debit: '0.0000', credit: '9.0000' }] });
    await expect(db.transaction(tx => tx.query('select public.commit_workspace($1, $2, $3::jsonb)', [DEMO_TENANT, revision, JSON.stringify(broken)]))).rejects.toThrow(/not balanced/);
    expect((await snapshot()).revision).toBe(revision);
  }, 60_000);

  it('ACC-088 a stale expected revision is refused without changes [local PGlite]', async () => {
    const { data, revision } = await snapshot();
    const next = execute(data, { type: 'record_expense', idempotencyKey: 'qa-acc-088', payload: { accountId: 'cash', amount: '1', date: '2026-10-05', memo: 'Fuel' } }, owner).workspace;
    expect(await commit(revision, next)).toBe(revision + 1);
    expect(await commit(revision, next)).toBeNull();
    expect((await snapshot()).revision).toBe(revision + 1);
  }, 60_000);

  it('ACC-089 Accounting is always on (not a toggleable module)', () => {
    expect(toggleModules as readonly string[]).not.toContain('accounting');
    const w = run(freshCompany(), 'set_modules', { enabled: ['sales', 'accounting'] }).workspace;
    expect(w.modules).toEqual(['sales']);
    expect(run(w, 'create_journal', journal([['5300', '1', '0'], ['1000', '0', '1']])).workspace.journals).toHaveLength(1);
  });

  it.todo('ACC-090 [browser] journal detail is readable on a phone');
  it.todo('ACC-091 [browser] debit/credit columns aligned with tabular numerals');

  it('ACC-092 trial balance CSV has a balanced totals row', () => {
    const tb = trialBalance(buildDemoWorkspace(), '2099-12-31');
    const heads = ['Code', 'Account', 'Debit', 'Credit'];
    const rows = [...tb.rows.map(r => [r.code, r.name, r.debit, r.credit]), ['', 'Total', tb.totalDebit, tb.totalCredit]].map(r => Object.fromEntries(heads.map((h, i) => [h, r[i]])));
    const csv = toCsv(rows, heads).split('\n');
    expect(csv[0]).toBe('Code,Account,Debit,Credit');
    expect(csv.at(-1)).toBe(`,Total,${tb.totalDebit},${tb.totalCredit}`);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('ACC-093 memo of 2,000 characters is saved; 2,001 refused', () => {
    expect(last(run(freshCompany(), 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']], 'm'.repeat(2000))).workspace).memo).toHaveLength(2000);
    refused(freshCompany(), 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']], 'm'.repeat(2001)), /too_big/);
  });

  it('ACC-094 a journal with 200 lines posts', () => {
    const lines: [string, string, string][] = Array.from({ length: 199 }, (_, i) => [['5100', '5200', '5300'][i % 3], '1.0001', '0']);
    lines.push(['1002', '0', money(D('1.0001').mul(199))]);
    const w = run(freshCompany(), 'create_journal', journal(lines)).workspace;
    expect(last(w).lines).toHaveLength(200);
    expect(bal(w, '1002')).toBe('-199.0199');
  });

  it('ACC-095 100,000 journal lines: trial balance in < 3 s', () => {
    const w = freshCompany();
    for (let i = 0; i < 50000; i++) w.journals.push({ id: `j${i}`, number: `JV-${i}`, sourceId: `s${i}`, date: '2026-09-01', memo: 'bulk', status: 'posted', lines: [{ account: ['5300', '5200', '1001'][i % 3], debit: '1.0000', credit: '0.0000' }, { account: '3000', debit: '0.0000', credit: '1.0000' }] });
    const start = performance.now();
    const tb = trialBalance(w, '2099-12-31');
    expect(performance.now() - start).toBeLessThan(3000);
    expect(tb.totalDebit).toBe('50000.0000');
    expect(tb.totalCredit).toBe('50000.0000');
  });

  it('ACC-096 a reversal is linked to its original [browser: link in the UI]', () => {
    let w = run(freshCompany(), 'create_journal', journal([['5300', '1', '0'], ['1002', '0', '1']])).workspace;
    const original = last(w);
    w = run(w, 'reverse_journal', { id: original.id }).workspace;
    expect(w.journals.find(j => j.reversalOf === original.id)!.number).toBe('JV-00002');
  });

  it('ACC-097 a manual journal on 1100 to "fix" a customer balance is allowed and reconciliation flags the variance', () => {
    let { w, item, cust } = base();
    [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    expect(invariants(w).receivable).toBe(true);
    w = run(w, 'create_journal', journal([['5300', '100', '0'], ['1100', '0', '100']], 'Write off customer')).workspace;
    expect(invariants(w).receivable).toBe(false);
    expect(agedBalances(w, 'customer', T).totals.total).toBe('100.0000');
    expect(bal(w, '1100')).toBe('0.0000');
  });

  it('ACC-098 a cheque cannot be cleared on a date inside a locked period', () => {
    let { w, item, cust } = base(); let inv: string;
    [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: '100' }]);
    const r = run(w, 'create_receipt', receiptPayload(cust, inv, '100', { method: 'cheque', chequeNo: 'C9' }));
    w = run(r.workspace, 'update_cheque', { id: r.recordId, status: 'deposited', date: T }).workspace;
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    refused(w, 'update_cheque', { id: r.recordId, status: 'cleared', date: '2026-09-30' }, 'Accounting period 2026-09 is locked.');
  });

  it('ACC-099 payroll cannot be paid when its date is inside a locked period', () => {
    let w = run(freshCompany(), 'save_settings', { taxRate: '', employerEobi: '5', employeeEobi: '1', eobiBase: '32000', incomeTaxRate: '5', numbering: 'QA', approvalLimit: '0' }).workspace;
    w = run(w, 'save_employee', { name: 'Ayesha', role: 'Accountant', territory: '', salary: '85000', allowance: '0', deduction: '0', attendance: 30, active: true }).workspace;
    const pr = run(w, 'create_payroll', { month: '2026-09' });
    w = run(run(pr.workspace, 'update_payroll', { id: pr.recordId, status: 'reviewed' }).workspace, 'update_payroll', { id: pr.recordId, status: 'approved' }).workspace;
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    refused(w, 'update_payroll', { id: pr.recordId, status: 'paid' }, 'Accounting period 2026-09 is locked.');
  });

  it('ACC-100 end to end: close month, owner reopens for correction, reversal, re-lock; reports consistent', () => {
    let { w, item, cust } = base();
    [w] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '10', price: '100' }], { date: '2026-09-20', dueDate: '2026-09-20' });
    w = run(w, 'create_journal', journal([['5300', '250', '0'], ['1002', '0', '250']], 'Wrong posting', '2026-09-25')).workspace;
    const wrong = last(w);
    w = run(w, 'set_period', { month: '2026-09', locked: true }, accountant).workspace;
    refused(w, 'reverse_journal', { id: wrong.id, date: '2026-09-30' }, 'Accounting period 2026-09 is locked.', accountant);
    w = run(w, 'set_period', { month: '2026-09', locked: false }).workspace;
    w = run(w, 'reverse_journal', { id: wrong.id, date: '2026-09-30' }, accountant).workspace;
    w = run(w, 'set_period', { month: '2026-09', locked: true }, accountant).workspace;
    const pl = profitAndLoss(w, '2026-09-01', '2026-09-30');
    expect(pl.totalRevenue).toBe('1000.0000');
    expect(pl.expenses.map(r => [r.code, r.amount])).toEqual([['5000', '600.0000']]);
    expect(pl.netProfit).toBe('400.0000');
    expect(balanceSheet(w, '2026-09-30').difference).toBe('0.0000');
    const tb = trialBalance(w, '2026-09-30');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(w.periods).toEqual([{ month: '2026-09', locked: true }]);
    expectInvariants(w);
  });
});

function outstandingOf(d: Workspace['documents'][number]) { return money(D(d.total).minus(d.paid).minus(d.returned)); }
