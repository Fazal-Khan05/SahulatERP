import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandSchema, summary } from '../../src/modules/erp/engine';
import { balanceSheet, chartOf, generalLedger, accountActivity, profitAndLoss, trialBalance } from '../../src/modules/erp/reports';
import { scopeWorkspace } from '../../src/modules/erp/access';
import type { Workspace } from '../../src/modules/erp/types';
import { accountBalance, actor, D, execute, expectInvariants, freshCompany, invariants, money, owner, refused, run, sum, today, withDocument, withItem, withParty } from './helpers';

const T = today();
const MONTH = T.slice(0, 7);
const bal = (w: Workspace, code: string) => accountBalance(w, code);
const last = (w: Workspace) => w.journals[w.journals.length - 1];
const accountant = actor('Accountant');
/** Owner's capital paid into an account via a manual journal. */
const capital = (w: Workspace, code: string, amount: string, date = T) => run(w, 'create_journal', { memo: 'Capital introduced', date, lines: [{ account: code, debit: amount, credit: '0' }, { account: '3000', debit: '0', credit: amount }] }).workspace;
const addAccount = (w: Workspace, name: string, type: 'bank' | 'cash' = 'bank', details = '') => { const r = run(w, 'save_bank_account', { name, type, details }); return [r.workspace, r.recordId] as const; };
const codeOf = (w: Workspace, id: string) => w.bankAccounts.find(a => a.id === id)!.code;
const cashSub = (w: Workspace) => money(sum(['1000', ...w.bankAccounts.map(a => a.code)].map(c => bal(w, c))));
/** A submitted sales invoice of `amount` (no tax) for a new customer; returns [w, customer, invoice]. */
function sale(w: Workspace, amount: string): [Workspace, string, string] {
  let item: string, cust: string, inv: string;
  [w, item] = withItem(w, {}, { quantity: '100000', cost: '1' });
  [w, cust] = withParty(w);
  [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '1', price: amount }]);
  return [w, cust, inv];
}
function receipt(w: Workspace, cust: string, inv: string, amount: string, accountId?: string, method: 'bank' | 'cash' | 'cheque' = 'bank', extra: Record<string, unknown> = {}) {
  return run(w, 'create_receipt', { partyId: cust, date: T, amount, method, chequeNo: method === 'cheque' ? 'CHQ-1' : '', dueDate: T, allocations: [{ invoiceId: inv, amount }], ...(accountId ? { accountId } : {}), ...extra });
}
function bill(w: Workspace, amount: string): [Workspace, string, string] {
  let item: string, sup: string, doc: string;
  [w, item] = withItem(w);
  [w, sup] = withParty(w, 'supplier');
  [w, doc] = withDocument(w, 'supplier_invoice', sup, [{ itemId: item, quantity: '1', price: amount }]);
  return [w, sup, doc];
}
/** Deterministic PRNG for fuzz cases. */
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
const source = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8');

describe('11 Cash and bank (CSH)', () => {
  it('CSH-001 per-account balances and an all-accounts total are available [browser: card layout]', () => {
    let w = freshCompany();
    w = capital(w, '1001', '5000');
    w = capital(w, '1002', '700');
    expect(bal(w, '1001')).toBe('5000.0000');
    expect(bal(w, '1002')).toBe('700.0000');
    expect(summary(w).cash).toBe('5700.0000');
  });

  it('CSH-002 fresh company provisions Main bank account and Cash in hand at zero', () => {
    const w = freshCompany();
    expect(w.bankAccounts).toEqual([
      { id: 'main-bank', code: '1001', name: 'Main bank account', type: 'bank', details: '' },
      { id: 'cash', code: '1002', name: 'Cash in hand', type: 'cash', details: '' },
    ]);
    expect(bal(w, '1001')).toBe('0.0000');
    expect(bal(w, '1002')).toBe('0.0000');
  });

  it('CSH-003 add bank account HBL Current gets the next ledger code', () => {
    const w = freshCompany();
    const r = run(w, 'save_bank_account', { name: 'HBL Current', type: 'bank', details: 'HBL · Saddar · 0012-3456789' });
    expect(r.message).toBe('HBL Current saved.');
    expect(r.recordId).toBe('hbl-current');
    expect(r.workspace.bankAccounts[2]).toEqual({ id: 'hbl-current', code: '1003', name: 'HBL Current', type: 'bank', details: 'HBL · Saddar · 0012-3456789' });
    expect(chartOf(r.workspace)['1003']).toBe('HBL Current');
  });

  it('CSH-004 duplicate account name (case-insensitive) is refused', () => {
    const [w] = addAccount(freshCompany(), 'HBL Current');
    refused(w, 'save_bank_account', { name: 'HBL Current', type: 'bank' }, 'An account named HBL Current already exists.');
    refused(w, 'save_bank_account', { name: 'hbl current', type: 'cash' }, 'An account named hbl current already exists.');
  });

  it('CSH-005 one-character name is refused (min 2)', () => {
    refused(freshCompany(), 'save_bank_account', { name: 'H', type: 'bank' }, /too_small/);
  });

  it('CSH-006 name of 80 characters accepted; 81 refused', () => {
    const w = freshCompany();
    expect(run(w, 'save_bank_account', { name: 'N'.repeat(80), type: 'bank' }).workspace.bankAccounts[2].name).toHaveLength(80);
    refused(w, 'save_bank_account', { name: 'N'.repeat(81), type: 'bank' }, /too_big/);
  });

  it('CSH-007 details of 200 characters accepted; 201 refused', () => {
    const w = freshCompany();
    expect(run(w, 'save_bank_account', { name: 'Meezan', type: 'bank', details: 'd'.repeat(200) }).workspace.bankAccounts[2].details).toHaveLength(200);
    refused(w, 'save_bank_account', { name: 'Meezan', type: 'bank', details: 'd'.repeat(201) }, /too_big/);
  });

  it('CSH-008 account type wallet via API fails validation', () => {
    refused(freshCompany(), 'save_bank_account', { name: 'JazzCash', type: 'wallet' }, /invalid_value/);
  });

  it('CSH-009 accounts can be added up to code 1099; the next is refused with "Too many bank accounts." [documented: cap is 99 accounts, codes 1001–1099]', () => {
    let w = freshCompany();
    for (let i = 3; i <= 99; i++) w = run(w, 'save_bank_account', { name: `Account ${i}`, type: 'bank' }).workspace;
    expect(w.bankAccounts).toHaveLength(99);
    expect(w.bankAccounts[98].code).toBe('1099');
    refused(w, 'save_bank_account', { name: 'Account 100', type: 'bank' }, 'Too many bank accounts.');
  });

  it('CSH-010 transfer 10,000 bank to cash moves balances and posts "Transfer A → B"', () => {
    let w = capital(freshCompany(), '1001', '50000');
    const r = run(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '10000', date: T });
    w = r.workspace;
    expect(bal(w, '1001')).toBe('40000.0000');
    expect(bal(w, '1002')).toBe('10000.0000');
    expect(last(w).memo).toBe('Transfer Main bank account → Cash in hand');
    expectInvariants(w);
  });

  it('CSH-011 transfer to the same account is refused', () => {
    refused(freshCompany(), 'bank_transfer', { fromId: 'cash', toId: 'cash', amount: '10', date: T }, 'Choose two different accounts.');
  });

  it('CSH-012 transfer of 0 is refused', () => {
    refused(freshCompany(), 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '0', date: T }, 'Amount must be greater than zero.');
  });

  it('CSH-013 transfer more than the balance is allowed (overdraft) [documented: no balance check; source goes negative]', () => {
    const w = run(freshCompany(), 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '10000', date: T }).workspace;
    expect(bal(w, '1001')).toBe('-10000.0000');
    expect(summary(w).cash).toBe('0.0000');
  });

  it('CSH-014 transfer dated in a locked period is refused', () => {
    const w = run(freshCompany(), 'set_period', { month: '2026-09', locked: true }).workspace;
    refused(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '10', date: '2026-09-15' }, 'Accounting period 2026-09 is locked.');
  });

  it('CSH-015 transfer memo of 200 characters accepted; 201 refused', () => {
    const w = freshCompany();
    const ok = run(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '1', date: T, memo: 'm'.repeat(200) }).workspace;
    expect(last(ok).memo).toBe(`Transfer Main bank account → Cash in hand · ${'m'.repeat(200)}`);
    refused(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '1', date: T, memo: 'm'.repeat(201) }, /too_big/);
  });

  it('CSH-016 transfer to an archived account is refused with "{name} is archived."', () => {
    const w = run(freshCompany(), 'save_bank_account', { id: 'cash', name: 'Cash in hand', type: 'cash', archived: true }).workspace;
    refused(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '10', date: T }, 'Cash in hand is archived.');
  });

  it('CSH-017 record expense "Fuel" 2,000 from cash posts to 5300 by default', () => {
    const r = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '2000', date: T, memo: 'Fuel' });
    expect(r.message).toBe('Expense of 2000.00 recorded.');
    expect(bal(r.workspace, '1002')).toBe('-2000.0000');
    expect(bal(r.workspace, '5300')).toBe('2000.0000');
    expect(last(r.workspace).memo).toBe('Expense · Fuel');
  });

  it('CSH-018 expense account choice 5100/5200/5300 posts to the chosen account', () => {
    for (const code of ['5100', '5200', '5300']) {
      const w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '50', date: T, memo: 'Choice', expenseAccount: code }).workspace;
      expect(last(w).lines).toEqual([{ account: code, debit: '50.0000', credit: '0.0000' }, { account: '1002', debit: '0.0000', credit: '50.0000' }]);
    }
  });

  it('CSH-019 expense memo of 1 character is refused', () => {
    refused(freshCompany(), 'record_expense', { accountId: 'cash', amount: '10', date: T, memo: 'F' }, /too_small/);
  });

  it('CSH-020 expense amount 0 is refused', () => {
    refused(freshCompany(), 'record_expense', { accountId: 'cash', amount: '0', date: T, memo: 'Fuel' }, 'Amount must be greater than zero.');
  });

  it('CSH-021 expense account 9999 via API fails validation', () => {
    refused(freshCompany(), 'record_expense', { accountId: 'cash', amount: '10', date: T, memo: 'Fuel', expenseAccount: '9999' }, /invalid_value/);
  });

  it('CSH-022 expense dated in a locked period is refused', () => {
    const w = run(freshCompany(), 'set_period', { month: '2026-09', locked: true }).workspace;
    refused(w, 'record_expense', { accountId: 'cash', amount: '10', date: '2026-09-02', memo: 'Fuel' }, 'Accounting period 2026-09 is locked.');
  });

  it('CSH-023 account activity gives date, memo, in/out and running balance, newest first [browser: table rendering]', () => {
    let w = capital(freshCompany(), '1002', '1000');
    w = run(w, 'record_expense', { accountId: 'cash', amount: '200', date: T, memo: 'Tea' }).workspace;
    const a = accountActivity(w, '1002');
    expect(a.balance).toBe('800.0000');
    expect(a.rows.map(r => [r.date, r.memo, r.debit, r.credit, r.balance])).toEqual([
      [T, 'Expense · Tea', '', '200.0000', '800.0000'],
      [T, 'Capital introduced', '1000.0000', '', '1000.0000'],
    ]);
  });

  it('CSH-024 running balance is correct after receipts, supplier payments, transfers and expenses', () => {
    let w = freshCompany(); let cust: string, inv: string, sup: string, doc: string;
    [w, cust, inv] = sale(w, '30000');
    w = receipt(w, cust, inv, '30000', 'main-bank').workspace;
    [w, sup, doc] = bill(w, '8000');
    w = run(w, 'create_receipt', { partyId: sup, date: T, amount: '8000', method: 'bank', dueDate: T, allocations: [{ invoiceId: doc, amount: '8000' }], accountId: 'main-bank' }).workspace;
    w = run(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '5000', date: T }).workspace;
    w = run(w, 'record_expense', { accountId: 'main-bank', amount: '1500', date: T, memo: 'Bank charges' }).workspace;
    const a = accountActivity(w, '1001');
    expect(a.rows.map(r => r.balance).reverse()).toEqual(['30000.0000', '22000.0000', '17000.0000', '15500.0000']);
    expect(a.balance).toBe(bal(w, '1001'));
    expectInvariants(w);
  });

  it('CSH-025 activity filtered by date [documented: Cash & bank activity has no date filter; Reports → General ledger filters an account by date]', () => {
    let w = capital(freshCompany(), '1002', '1000', '2026-09-10');
    w = run(w, 'record_expense', { accountId: 'cash', amount: '100', date: '2026-10-01', memo: 'October' }).workspace;
    const gl = generalLedger(w, '1002', '2026-10-01', '2026-10-31');
    expect(gl.opening).toBe('1000.0000');
    expect(gl.rows.map(r => r.memo)).toEqual(['Expense · October']);
    expect(gl.closing).toBe('900.0000');
    expect(source('src/components/cash-bank-view.tsx')).not.toMatch(/type="date"[^>]*aria-label="(From|Activity)/);
  });

  it('CSH-026 archive an empty account; it is flagged archived and refused for new postings [browser: hidden from selects]', () => {
    const [w0, id] = addAccount(freshCompany(), 'Old Account');
    const r = run(w0, 'save_bank_account', { id, name: 'Old Account', type: 'bank', archived: true });
    expect(r.workspace.bankAccounts.find(a => a.id === id)!.archived).toBe(true);
    expect(chartOf(r.workspace)['1003']).toBe('Old Account (archived)');
    refused(r.workspace, 'record_expense', { accountId: id, amount: '1', date: T, memo: 'Fuel' }, 'Old Account is archived.');
  });

  it('CSH-027 archiving an account with a balance is refused', () => {
    const w = capital(freshCompany(), '1001', '1');
    refused(w, 'save_bank_account', { id: 'main-bank', name: 'Main bank account', type: 'bank', archived: true }, 'Main bank account still has a balance. Transfer it out before archiving.');
  });

  it('CSH-028 restore an archived account', () => {
    let w = run(freshCompany(), 'save_bank_account', { id: 'cash', name: 'Cash in hand', type: 'cash', archived: true }).workspace;
    w = run(w, 'save_bank_account', { id: 'cash', name: 'Cash in hand', type: 'cash', archived: false }).workspace;
    expect(w.bankAccounts.find(a => a.id === 'cash')).toEqual({ id: 'cash', code: '1002', name: 'Cash in hand', type: 'cash', details: '' });
    expect(run(w, 'record_expense', { accountId: 'cash', amount: '1', date: T, memo: 'Fuel' }).workspace.journals).toHaveLength(1);
  });

  it('CSH-029 rename keeps balances and code; old journal memos stay frozen', () => {
    let w = capital(freshCompany(), '1001', '100');
    w = run(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '40', date: T }).workspace;
    w = run(w, 'save_bank_account', { id: 'main-bank', name: 'HBL Main', type: 'bank' }).workspace;
    expect(bal(w, '1001')).toBe('60.0000');
    expect(w.bankAccounts[0].code).toBe('1001');
    expect(chartOf(w)['1001']).toBe('HBL Main');
    expect(last(w).memo).toBe('Transfer Main bank account → Cash in hand');
  });

  it('CSH-030 change account type bank → cash keeps the code', () => {
    const w = run(freshCompany(), 'save_bank_account', { id: 'main-bank', name: 'Main bank account', type: 'cash' }).workspace;
    expect(w.bankAccounts[0]).toMatchObject({ code: '1001', type: 'cash' });
  });

  it('CSH-031 cheque register: a recorded cheque is "received" with no posting until cleared [browser: register tab and actions]', () => {
    let w = freshCompany(); let cust: string, inv: string;
    [w, cust, inv] = sale(w, '1000');
    const r = receipt(w, cust, inv, '1000', undefined, 'cheque');
    expect(r.message).toBe('Cheque recorded. Commission releases only on clearance.');
    const chq = r.workspace.receipts.find(x => x.id === r.recordId)!;
    expect(chq.status).toBe('received');
    expect(r.workspace.journals.some(j => j.sourceId.startsWith(chq.id))).toBe(false);
    expect(r.workspace.receipts.filter(x => x.method === 'cheque' && ['received', 'deposited'].includes(x.status))).toHaveLength(1);
  });

  it('CSH-032 deposit from the register into an account, then clear posts to that account', () => {
    let w = freshCompany(); let cust: string, inv: string;
    [w, cust, inv] = sale(w, '1000');
    const r = receipt(w, cust, inv, '1000', undefined, 'cheque');
    w = run(r.workspace, 'update_cheque', { id: r.recordId, status: 'deposited', date: T, accountId: 'main-bank' }).workspace;
    expect(w.receipts[0]).toMatchObject({ status: 'deposited', accountId: 'main-bank' });
    expect(bal(w, '1001')).toBe('0.0000');
    w = run(w, 'update_cheque', { id: r.recordId, status: 'cleared', date: T }).workspace;
    expect(bal(w, '1001')).toBe('1000.0000');
    expectInvariants(w);
  });

  it('CSH-033 account balance equals the journal balance of its code', () => {
    let w = capital(freshCompany(), '1001', '999.5');
    w = run(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '0.5', date: T }).workspace;
    for (const a of w.bankAccounts) expect(accountActivity(w, a.code).balance).toBe(bal(w, a.code));
    expect(bal(w, '1001')).toBe('999.0000');
  });

  it('CSH-034 cash/bank control row is reconciled [documented: the reconciliation row compares the account total with itself, so it can never show a variance]', () => {
    let w = capital(freshCompany(), '1001', '100');
    w = run(w, 'record_expense', { accountId: 'main-bank', amount: '30', date: T, memo: 'Fuel' }).workspace;
    const sub = cashSub(w);
    expect(sub).toBe('70.0000');
    expect(D(sub).minus(cashSub(w)).abs().lt('0.01')).toBe(true);
    expect(source('src/components/reports-view.tsx')).toContain("['Bank & cash accounts', cashSub, cashSub]");
  });

  it('CSH-035 transfer journal is balanced with exactly two lines', () => {
    const w = run(freshCompany(), 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '123.45', date: T }).workspace;
    expect(last(w).lines).toEqual([{ account: '1002', debit: '123.4500', credit: '0.0000' }, { account: '1001', debit: '0.0000', credit: '123.4500' }]);
  });

  it('CSH-036 expense journal is Dr expense / Cr cash', () => {
    const w = run(freshCompany(), 'record_expense', { accountId: 'main-bank', amount: '75', date: T, memo: 'Courier' }).workspace;
    expect(last(w).lines).toEqual([{ account: '5300', debit: '75.0000', credit: '0.0000' }, { account: '1001', debit: '0.0000', credit: '75.0000' }]);
  });

  it('CSH-037 retrying a transfer with the same idempotency key posts one journal [case-corrected: a replay returns the original recordId and message (D-17)]', () => {
    const w0 = freshCompany();
    const first = run(w0, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '10', date: T }, owner, 'retry-transfer-1');
    const second = run(first.workspace, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '10', date: T }, owner, 'retry-transfer-1');
    expect([second.recordId, second.message]).toEqual([first.recordId, first.message]);
    expect(second.workspace.journals).toHaveLength(1);
  });

  it('CSH-038 Salesperson cannot transfer or record expenses via API [browser: Cash & bank hidden from nav]', () => {
    const w = freshCompany(); const sp = actor('Salesperson');
    refused(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '10', date: T }, 'Your role does not permit this action.', sp);
    refused(w, 'record_expense', { accountId: 'cash', amount: '10', date: T, memo: 'Fuel' }, 'Your role does not permit this action.', sp);
    refused(w, 'save_bank_account', { name: 'Mine', type: 'cash' }, 'Your role does not permit this action.', sp);
  });

  it('CSH-039 Recovery Officer cannot record an expense', () => {
    refused(freshCompany(), 'record_expense', { accountId: 'cash', amount: '10', date: T, memo: 'Fuel' }, 'Your role does not permit this action.', actor('Recovery Officer'));
  });

  it('CSH-040 Accountant can archive an empty account', () => {
    const w = run(freshCompany(), 'save_bank_account', { id: 'cash', name: 'Cash in hand', type: 'cash', archived: true }, accountant).workspace;
    expect(w.bankAccounts[1].archived).toBe(true);
  });

  it('CSH-041 Auditor reads balances and journals but every cash & bank command is refused', () => {
    const w = capital(freshCompany(), '1001', '10'); const auditor = actor('Auditor');
    for (const [type, payload] of [['save_bank_account', { name: 'X1', type: 'bank' }], ['bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '1', date: T }], ['record_expense', { accountId: 'cash', amount: '1', date: T, memo: 'Fuel' }]] as const)
      refused(w, type, payload, 'Your role does not permit this action.', auditor);
    const view = scopeWorkspace(w, auditor);
    expect(view.journals).toHaveLength(1);
    expect(view.bankAccounts).toHaveLength(2);
  });

  it('CSH-042 with Cash & bank hidden, receipts still post to a chosen account and bankAccounts are still sent', () => {
    let w = freshCompany(); let cust: string, inv: string;
    w = run(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'cashbank') }).workspace;
    expect(w.modules).not.toContain('cashbank');
    [w, cust, inv] = sale(w, '500');
    w = receipt(w, cust, inv, '500', 'cash', 'cash').workspace;
    expect(bal(w, '1002')).toBe('500.0000');
    expect(scopeWorkspace(w, actor('Recovery Officer')).bankAccounts.map(a => a.id)).toEqual(['main-bank', 'cash']);
    refused(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '1', date: T }, 'Cash & bank is turned off for this company. Turn it on in Settings → Features.');
  });

  it('CSH-043 receipts can use any account created here, including a new one [browser: dialog account list]', () => {
    let w = freshCompany(); let cust: string, inv: string, hbl: string;
    [w, hbl] = addAccount(w, 'HBL Current');
    [w, cust, inv] = sale(w, '250');
    w = receipt(w, cust, inv, '250', hbl).workspace;
    expect(bal(w, codeOf(w, hbl))).toBe('250.0000');
  });

  it('CSH-044 supplier payment from the new HBL account credits its code', () => {
    let w = freshCompany(); let sup: string, doc: string, hbl: string;
    [w, hbl] = addAccount(w, 'HBL Current');
    [w, sup, doc] = bill(w, '4000');
    w = run(w, 'create_receipt', { partyId: sup, date: T, amount: '4000', method: 'bank', dueDate: T, allocations: [{ invoiceId: doc, amount: '4000' }], accountId: hbl }).workspace;
    expect(bal(w, '1003')).toBe('-4000.0000');
    expect(bal(w, '2000')).toBe('0.0000');
    expectInvariants(w);
  });

  it('CSH-045 amount 0.0001 is accepted', () => {
    const w = run(freshCompany(), 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '0.0001', date: T }).workspace;
    expect(bal(w, '1002')).toBe('0.0001');
  });

  it('CSH-046 amount 999,999,999,999 [case-corrected: accepted (limit is below one trillion); 1,000,000,000,000 is refused]', () => {
    const w = freshCompany();
    expect(bal(run(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '999999999999', date: T }).workspace, '1002')).toBe('999999999999.0000');
    refused(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '1000000000000', date: T }, 'Enter a valid number below one trillion.');
  });

  it('CSH-047 memo with emoji is saved', () => {
    const w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '1', date: T, memo: 'Chai ☕ for staff 🙂' }).workspace;
    expect(last(w).memo).toBe('Expense · Chai ☕ for staff 🙂');
  });

  it('CSH-048 memo with newline [case-corrected: surrounding whitespace is trimmed; an inner newline is kept as typed]', () => {
    const w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '1', date: T, memo: '  Fuel\nand tolls \n' }).workspace;
    expect(last(w).memo).toBe('Expense · Fuel\nand tolls');
  });

  it.todo('CSH-049 [browser] account cards show a bank or cash type icon');
  it.todo('CSH-050 [browser] negative balance is styled red');
  it.todo('CSH-051 [browser] cash & bank dialogs open as bottom sheets on a phone');
  it.todo('CSH-052 [browser] transfer dialog closes on success');
  it.todo('CSH-053 [browser] expense dialog closes on success');

  it('CSH-054 success notice shows the amount with 2 dp and both account names', () => {
    expect(run(freshCompany(), 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '10000', date: T }).message).toBe('Transferred 10000.00 from Main bank account to Cash in hand.');
  });

  it('CSH-055 engine requires an explicit date; the dialog defaults it to today in Asia/Karachi [browser: default value] [documented: no engine default]', () => {
    refused(freshCompany(), 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '1' }, /invalid_format|invalid_type/);
    expect(source('src/components/cash-bank-view.tsx')).toContain('const today = businessToday();');
  });

  it('CSH-056 date 2026-02-29 (not a leap year) fails validation', () => {
    refused(freshCompany(), 'record_expense', { accountId: 'cash', amount: '1', date: '2026-02-29', memo: 'Fuel' }, /invalid_format/);
  });

  it('CSH-057 transfer between two bank accounts', () => {
    let [w, hbl] = addAccount(freshCompany(), 'HBL Current');
    w = run(w, 'bank_transfer', { fromId: 'main-bank', toId: hbl, amount: '300', date: T }).workspace;
    expect([bal(w, '1001'), bal(w, '1003')]).toEqual(['-300.0000', '300.0000']);
  });

  it('CSH-058 transfer between two cash accounts', () => {
    let [w, petty] = addAccount(freshCompany(), 'Petty cash', 'cash');
    w = run(w, 'bank_transfer', { fromId: 'cash', toId: petty, amount: '50', date: T }).workspace;
    expect([bal(w, '1002'), bal(w, '1003')]).toEqual(['-50.0000', '50.0000']);
  });

  it('CSH-059 three transfers leave the sum across accounts at zero', () => {
    let [w, hbl] = addAccount(freshCompany(), 'HBL Current');
    w = run(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '100', date: T }).workspace;
    w = run(w, 'bank_transfer', { fromId: 'cash', toId: hbl, amount: '30.25', date: T }).workspace;
    w = run(w, 'bank_transfer', { fromId: hbl, toId: 'main-bank', amount: '7.5', date: T }).workspace;
    expect(summary(w).cash).toBe('0.0000');
    expect([bal(w, '1001'), bal(w, '1002'), bal(w, '1003')]).toEqual(['-92.5000', '69.7500', '22.7500']);
  });

  it('CSH-060 expense with a 4-decimal amount is stored at 4 dp', () => {
    const w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '123.4567', date: T, memo: 'Stamps' }).workspace;
    expect(last(w).lines[0].debit).toBe('123.4567');
  });

  it('CSH-061 a negative cash balance does not break the overview summary', () => {
    const w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '10', date: T, memo: 'Fuel' }).workspace;
    expect(summary(w).cash).toBe('-10.0000');
  });

  it('CSH-062 total balance equals the sum of account balances (including legacy 1000)', () => {
    let w = capital(freshCompany(), '1001', '100');
    w = capital(w, '1000', '25');
    w = run(w, 'record_expense', { accountId: 'cash', amount: '5', date: T, memo: 'Fuel' }).workspace;
    expect(summary(w).cash).toBe('120.0000');
    expect(summary(w).cash).toBe(cashSub(w));
  });

  it('CSH-063 account with 10,000 lines: activity returns the latest 50 quickly [documented: no pagination; card shows latest 50 movements]', () => {
    const w = freshCompany();
    for (let i = 0; i < 10000; i++) w.journals.push({ id: `j${i}`, number: `JV-${i}`, sourceId: `s${i}`, date: T, memo: `Line ${i}`, status: 'posted', lines: [{ account: '1001', debit: '1.0000', credit: '0.0000' }, { account: '3000', debit: '0.0000', credit: '1.0000' }] });
    const start = performance.now();
    const a = accountActivity(w, '1001');
    expect(performance.now() - start).toBeLessThan(2000);
    expect(a.rows).toHaveLength(50);
    expect(a.balance).toBe('10000.0000');
  });

  it('CSH-064 export activity CSV [documented: not present in Cash & bank; use Reports → General ledger export]', () => {
    const view = source('src/components/cash-bank-view.tsx');
    expect(view).not.toContain('toCsv');
    expect(view).not.toContain('Export');
  });

  it('CSH-065 global search finds an account by name [documented: not present; search covers documents, parties and items only]', () => {
    const search = source('src/components/workbench.tsx').split('function SearchDialog')[1].split('\nfunction ')[0];
    expect(search).not.toContain('bankAccounts');
  });

  it.todo('CSH-066 [browser] account details text shows on the card');

  it('CSH-067 save_bank_account with archived=true on an account with a balance is refused via API', () => {
    const w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '1', date: T, memo: 'Fuel' }).workspace;
    refused(w, 'save_bank_account', { id: 'cash', name: 'Cash in hand', type: 'cash', archived: true }, 'Cash in hand still has a balance. Transfer it out before archiving.');
  });

  it("CSH-068 bank_transfer with another tenant's account id is not found", () => {
    const other = freshCompany();
    const [, foreign] = addAccount(other, 'Foreign Bank');
    refused(freshCompany(), 'bank_transfer', { fromId: 'main-bank', toId: foreign, amount: '1', date: T }, 'Bank account not found.');
  });

  it('CSH-069 there is no command that deletes an account', () => {
    expect(commandSchema.shape.type.options.filter(t => /delete|remove/.test(t))).toEqual([]);
    expect(() => execute(freshCompany(), { type: 'delete_bank_account', payload: { id: 'cash' }, idempotencyKey: 'qa-delete-1' }, owner)).toThrow(/invalid_value/);
  });

  it('CSH-070 ledger codes are distinct across accounts', () => {
    let w = freshCompany();
    for (let i = 0; i < 5; i++) w = run(w, 'save_bank_account', { name: `Bank ${i}`, type: i % 2 ? 'cash' : 'bank' }).workspace;
    const codes = w.bankAccounts.map(a => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(['1001', '1002', '1003', '1004', '1005', '1006', '1007']);
  });

  it('CSH-071 code survives a rename', () => {
    const [w0, id] = addAccount(freshCompany(), 'Meezan');
    const w = run(w0, 'save_bank_account', { id, name: 'Meezan Bank Ltd', type: 'bank' }).workspace;
    expect(w.bankAccounts.find(a => a.id === id)!.code).toBe('1003');
  });

  it('CSH-072 turning Cash & bank off and on does not duplicate provisioned accounts', () => {
    let w = freshCompany();
    const all = [...w.modules];
    w = run(w, 'set_modules', { enabled: all.filter(m => m !== 'cashbank') }).workspace;
    w = run(w, 'set_modules', { enabled: all }).workspace;
    expect(w.bankAccounts.map(a => a.code)).toEqual(['1001', '1002']);
  });

  it('CSH-073 cash receipt then expense of the same amount returns cash to 0', () => {
    let w = freshCompany(); let cust: string, inv: string;
    [w, cust, inv] = sale(w, '1200');
    w = receipt(w, cust, inv, '1200', 'cash', 'cash').workspace;
    w = run(w, 'record_expense', { accountId: 'cash', amount: '1200', date: T, memo: 'Rent' }).workspace;
    expect(bal(w, '1002')).toBe('0.0000');
    expectInvariants(w);
  });

  it('CSH-074 receipt, transfer, then supplier payment chain leaves correct balances', () => {
    let w = freshCompany(); let cust: string, inv: string, sup: string, doc: string;
    [w, cust, inv] = sale(w, '10000');
    w = receipt(w, cust, inv, '10000', 'cash', 'cash').workspace;
    w = run(w, 'bank_transfer', { fromId: 'cash', toId: 'main-bank', amount: '9000', date: T }).workspace;
    [w, sup, doc] = bill(w, '6000');
    w = run(w, 'create_receipt', { partyId: sup, date: T, amount: '6000', method: 'bank', dueDate: T, allocations: [{ invoiceId: doc, amount: '6000' }], accountId: 'main-bank' }).workspace;
    expect([bal(w, '1001'), bal(w, '1002')]).toEqual(['3000.0000', '1000.0000']);
    expectInvariants(w);
  });

  it('CSH-075 cheque cleared into HBL shows in HBL activity', () => {
    let w = freshCompany(); let cust: string, inv: string, hbl: string;
    [w, hbl] = addAccount(w, 'HBL Current');
    [w, cust, inv] = sale(w, '700');
    const r = receipt(w, cust, inv, '700', undefined, 'cheque');
    w = run(r.workspace, 'update_cheque', { id: r.recordId, status: 'deposited', date: T, accountId: hbl }).workspace;
    w = run(w, 'update_cheque', { id: r.recordId, status: 'cleared', date: T }).workspace;
    const a = accountActivity(w, '1003');
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ debit: '700.0000', balance: '700.0000' });
    expect(a.rows[0].memo).toMatch(/^Customer receipt · REC-/);
  });

  it('CSH-076 bounce after clear adds a reversal line to the account activity', () => {
    let w = freshCompany(); let cust: string, inv: string, hbl: string;
    [w, hbl] = addAccount(w, 'HBL Current');
    [w, cust, inv] = sale(w, '700');
    const r = receipt(w, cust, inv, '700', undefined, 'cheque');
    w = run(r.workspace, 'update_cheque', { id: r.recordId, status: 'deposited', date: T, accountId: hbl }).workspace;
    w = run(w, 'update_cheque', { id: r.recordId, status: 'cleared', date: T }).workspace;
    w = run(w, 'update_cheque', { id: r.recordId, status: 'bounced', date: T }).workspace;
    const a = accountActivity(w, '1003');
    expect(a.rows.map(x => [x.memo, x.debit, x.credit, x.balance])).toEqual([['Cheque dishonoured', '', '700.0000', '0.0000'], [expect.stringMatching(/^Customer receipt/), '700.0000', '', '700.0000']]);
    expectInvariants(w);
  });

  it.todo('CSH-077 [browser] activity table shows In / Out columns with a running balance (engine rows verified in CSH-023)');
  it.todo('CSH-078 [browser] long memo truncates with a tooltip and stays readable');

  it('CSH-079 viewing activity is allowed while the period is locked', () => {
    let w = capital(freshCompany(), '1002', '10', '2026-09-05');
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    expect(accountActivity(w, '1002').balance).toBe('10.0000');
  });

  it('CSH-080 Owner reopens the period, then an expense dated there is allowed; Accountant cannot reopen', () => {
    let w = run(freshCompany(), 'set_period', { month: '2026-09', locked: true }).workspace;
    refused(w, 'set_period', { month: '2026-09', locked: false }, 'Only the owner can reopen an accounting period.', accountant);
    w = run(w, 'set_period', { month: '2026-09', locked: false }).workspace;
    w = run(w, 'record_expense', { accountId: 'cash', amount: '5', date: '2026-09-30', memo: 'Fuel' }).workspace;
    expect(last(w).date).toBe('2026-09-30');
  });

  it('CSH-081 two "Fuel" expenses on the same day post two journals (no dedupe)', () => {
    let w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '100', date: T, memo: 'Fuel' }).workspace;
    w = run(w, 'record_expense', { accountId: 'cash', amount: '100', date: T, memo: 'Fuel' }).workspace;
    expect(w.journals.filter(j => j.memo === 'Expense · Fuel')).toHaveLength(2);
    expect(bal(w, '1002')).toBe('-200.0000');
  });

  it('CSH-082 transfer 10,000.5 is stored exactly', () => {
    const w = run(freshCompany(), 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '10000.5', date: T }).workspace;
    expect(bal(w, '1002')).toBe('10000.5000');
  });

  it.todo('CSH-083 [browser] Enter submits the transfer form');
  it.todo('CSH-084 [browser] Escape closes cash & bank dialogs');
  it.todo('CSH-085 [browser] account select order is consistent (engine keeps creation order: bankAccounts array)');
  it.todo('CSH-086 [manual] balances after company reset are 0 — reset runs the hosted company:reset script; fresh-company zero state is covered by CSH-002');

  it('CSH-087 account name in Urdu is saved [documented: id falls back to "record" slug; code assigned normally]', () => {
    const r = run(freshCompany(), 'save_bank_account', { name: 'حبیب بینک', type: 'bank' });
    expect(r.workspace.bankAccounts[2]).toMatchObject({ id: 'record', code: '1003', name: 'حبیب بینک' });
    const r2 = run(r.workspace, 'save_bank_account', { name: 'میزان بینک', type: 'bank' });
    expect(r2.recordId).toBe('record-2');
  });

  it('CSH-088 expense dated in a previous open month posts there and shows in that month\'s P&L', () => {
    const w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '400', date: '2026-09-15', memo: 'September fuel' }).workspace;
    expect(profitAndLoss(w, '2026-09-01', '2026-09-30').expenses).toEqual([{ code: '5300', name: 'Operating expense', amount: '400.0000' }]);
    expect(profitAndLoss(w, '2026-10-01', '2026-10-31').expenses).toEqual([]);
  });

  it('CSH-089 P&L shows the expense', () => {
    const w = run(freshCompany(), 'record_expense', { accountId: 'cash', amount: '250', date: T, memo: 'Repairs', expenseAccount: '5300' }).workspace;
    const pl = profitAndLoss(w, `${MONTH}-01`, `${MONTH}-31`);
    expect(pl.totalExpenses).toBe('250.0000');
    expect(pl.netProfit).toBe('-250.0000');
  });

  it('CSH-090 balance sheet cash equals the sum of account balances', () => {
    let w = capital(freshCompany(), '1001', '1000');
    w = run(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '400', date: T }).workspace;
    w = run(w, 'record_expense', { accountId: 'cash', amount: '100', date: T, memo: 'Fuel' }).workspace;
    const bs = balanceSheet(w, T);
    const cash = sum(bs.assets.filter(r => r.code.startsWith('10')).map(r => r.amount));
    expect(money(cash)).toBe(summary(w).cash);
    expect(bs.difference).toBe('0.0000');
  });

  it('CSH-091 trial balance includes each account code with a balance', () => {
    let [w, hbl] = addAccount(capital(freshCompany(), '1001', '100'), 'HBL Current');
    w = run(w, 'bank_transfer', { fromId: 'main-bank', toId: hbl, amount: '30', date: T }).workspace;
    w = run(w, 'bank_transfer', { fromId: 'main-bank', toId: 'cash', amount: '20', date: T }).workspace;
    const tb = trialBalance(w, T);
    expect(tb.rows.filter(r => r.code.startsWith('100')).map(r => [r.code, r.name, r.debit])).toEqual([['1001', 'Main bank account', '50.0000'], ['1002', 'Cash in hand', '20.0000'], ['1003', 'HBL Current', '30.0000']]);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('CSH-092 50 accounts can be created with distinct codes [browser: cards grid layout]', () => {
    let w = freshCompany();
    for (let i = 0; i < 48; i++) w = run(w, 'save_bank_account', { name: `Branch account ${i}`, type: 'bank' }).workspace;
    expect(w.bankAccounts).toHaveLength(50);
    expect(new Set(w.bankAccounts.map(a => a.code)).size).toBe(50);
  });

  it('CSH-093 with Cash & bank hidden, a receipt can still use a previously added account', () => {
    let [w, hbl] = addAccount(freshCompany(), 'HBL Current'); let cust: string, inv: string;
    w = run(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'cashbank') }).workspace;
    [w, cust, inv] = sale(w, '90');
    w = receipt(w, cust, inv, '90', hbl).workspace;
    expect(bal(w, '1003')).toBe('90.0000');
  });

  it.todo('CSH-094 [browser] tapping an account card on mobile opens its activity');
  it.todo('CSH-095 [browser] card hover lift only with a mouse (no sticky hover on touch)');

  it('CSH-096 transfer confirmation copy names both accounts', () => {
    let [w, hbl] = addAccount(freshCompany(), 'HBL Current');
    const r = run(w, 'bank_transfer', { fromId: hbl, toId: 'cash', amount: '1', date: T, memo: 'float' });
    expect(r.message).toBe('Transferred 1.00 from HBL Current to Cash in hand.');
    expect(last(r.workspace).memo).toBe('Transfer HBL Current → Cash in hand · float');
  });

  it('CSH-097 activity for an archived account stays viewable', () => {
    let [w, old] = addAccount(freshCompany(), 'Old Account');
    w = run(w, 'bank_transfer', { fromId: 'main-bank', toId: old, amount: '60', date: T }).workspace;
    w = run(w, 'bank_transfer', { fromId: old, toId: 'main-bank', amount: '60', date: T }).workspace;
    w = run(w, 'save_bank_account', { id: old, name: 'Old Account', type: 'bank', archived: true }).workspace;
    const a = accountActivity(w, '1003');
    expect(a.rows).toHaveLength(2);
    expect(a.balance).toBe('0.0000');
  });

  it('CSH-098 a payment from an archived account is refused', () => {
    let [w, old] = addAccount(freshCompany(), 'Old Account'); let sup: string, doc: string;
    w = run(w, 'save_bank_account', { id: old, name: 'Old Account', type: 'bank', archived: true }).workspace;
    [w, sup, doc] = bill(w, '100');
    refused(w, 'create_receipt', { partyId: sup, date: T, amount: '100', method: 'bank', dueDate: T, allocations: [{ invoiceId: doc, amount: '100' }], accountId: old }, 'Old Account is archived.');
  });

  it('CSH-099 reconciliation still holds after 100 random cash & bank operations (fuzz)', () => {
    let w = freshCompany(); let hbl: string;
    [w, hbl] = addAccount(w, 'HBL Current');
    const ids = ['main-bank', 'cash', hbl];
    const rand = rng(42); let expectedTotal = D(0);
    for (let i = 0; i < 100; i++) {
      const pick = () => ids[Math.floor(rand() * ids.length)];
      const amount = money(D(Math.floor(rand() * 1000000)).div(100).plus('0.01'));
      const op = rand();
      if (op < 0.4) { const from = pick(); let to = pick(); if (to === from) to = ids[(ids.indexOf(from) + 1) % 3]; w = run(w, 'bank_transfer', { fromId: from, toId: to, amount, date: T }).workspace; }
      else if (op < 0.7) { w = run(w, 'record_expense', { accountId: pick(), amount, date: T, memo: `Fuzz ${i}`, expenseAccount: ['5100', '5200', '5300'][i % 3] }).workspace; expectedTotal = expectedTotal.minus(amount); }
      else { const code = codeOf(w, pick()); w = capital(w, code, amount); expectedTotal = expectedTotal.plus(amount); }
    }
    expect(summary(w).cash).toBe(money(expectedTotal));
    expect(invariants(w).trialBalanced).toBe(true);
    const tb = trialBalance(w, T);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expectInvariants(w);
  });

  it('CSH-100 end to end: add account → receipts → transfer → expense → archive empty account; balances and reports agree', () => {
    let w = freshCompany(); let hbl: string, petty: string, cust: string, inv: string;
    [w, hbl] = addAccount(w, 'HBL Current', 'bank', 'HBL · Saddar');
    [w, petty] = addAccount(w, 'Petty cash', 'cash');
    [w, cust, inv] = sale(w, '20000');
    w = receipt(w, cust, inv, '12000', hbl).workspace;
    w = receipt(w, cust, inv, '8000', 'cash', 'cash').workspace;
    w = run(w, 'bank_transfer', { fromId: 'cash', toId: petty, amount: '500', date: T }).workspace;
    w = run(w, 'record_expense', { accountId: petty, amount: '500', date: T, memo: 'Petty expenses' }).workspace;
    w = run(w, 'save_bank_account', { id: petty, name: 'Petty cash', type: 'cash', archived: true }).workspace;
    expect([bal(w, '1001'), bal(w, '1002'), bal(w, '1003'), bal(w, '1004')]).toEqual(['0.0000', '7500.0000', '12000.0000', '0.0000']);
    expect(summary(w).cash).toBe('19500.0000');
    const bs = balanceSheet(w, T);
    expect(bs.difference).toBe('0.0000');
    expect(profitAndLoss(w, `${MONTH}-01`, `${MONTH}-31`).expenses.find(r => r.code === '5300')!.amount).toBe('500.0000');
    expect(trialBalance(w, T).rows.some(r => r.code === '1004')).toBe(false);
    expectInvariants(w);
  });
});
