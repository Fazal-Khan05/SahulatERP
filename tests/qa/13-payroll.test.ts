import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandSchema, commissionTotals, payrollConfigured } from '../../src/modules/erp/engine';
import { scopeWorkspace } from '../../src/modules/erp/access';
import { moduleRecordCounts } from '../../src/modules/erp/modules';
import { printableKinds } from '../../src/modules/erp/documents';
import { balanceSheet, profitAndLoss, trialBalance } from '../../src/modules/erp/reports';
import type { Workspace } from '../../src/modules/erp/types';
import { accountBalance, actor, D, execute, expectInvariants, freshCompany, money, owner, refused, run, sum, today, withDocument, withItem, withParty } from './helpers';

const T = today();
const MONTH = T.slice(0, 7);
const nextMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const M2 = nextMonth(MONTH);
const M3 = nextMonth(M2);
const SETTINGS = { taxRate: '', employerEobi: '5', employeeEobi: '1', eobiBase: '32000', incomeTaxRate: '5', numbering: 'QA', approvalLimit: '0' };
const employee = (name: string, extra: Record<string, unknown> = {}) => ({ name, role: 'Officer', territory: 'Karachi', salary: '100000', allowance: '10000', deduction: '0', attendance: 30, active: true, ...extra });
const accountant = actor('Accountant');
const payAdmin = actor('Payroll Administrator');

/** Company with payroll settings and one employee (100,000 + 10,000). */
function setup(settings: Record<string, string> = {}, emp: Record<string, unknown> = {}, modules?: Parameters<typeof freshCompany>[0]) {
  let w = freshCompany(modules);
  w = run(w, 'save_settings', { ...SETTINGS, ...settings }).workspace;
  const e = run(w, 'save_employee', employee('Ayesha Siddiqui', emp));
  return { w: e.workspace, emp: e.recordId };
}
const addEmployee = (w: Workspace, name: string, extra: Record<string, unknown> = {}) => { const r = run(w, 'save_employee', employee(name, extra)); return [r.workspace, r.recordId] as const; };
const lineOf = (w: Workspace, runId: string, emp: string) => w.payrolls.find(p => p.id === runId)!.lines.find(l => l.employeeId === emp)!;
function create(w: Workspace, month = MONTH, extra: Record<string, unknown> = {}, who = owner) { const r = run(w, 'create_payroll', { month, ...extra }, who); return [r.workspace, r.recordId] as const; }
function advance(w: Workspace, id: string, steps: ('reviewed' | 'approved' | 'paid')[], who = owner) { for (const s of steps) w = run(w, 'update_payroll', { id, status: s }, who).workspace; return w; }
const FULL: ('reviewed' | 'approved' | 'paid')[] = ['reviewed', 'approved', 'paid'];

/** Commission scenario: flat 2% plan; invoice 100 × `price` with `emp`; customer pays by cheque cleared. Returns ids. */
function commissionFor(w: Workspace, emp: string, price = '100', method: 'cash' | 'cheque' = 'cheque') {
  if (w.plans[0].rate !== '2') w = run(w, 'save_plan', { ...w.plans[0], rate: '2' }).workspace;
  let item: string, cust: string, inv: string;
  [w, item] = withItem(w, {}, { quantity: '100000', cost: '1' });
  [w, cust] = withParty(w);
  [w, inv] = withDocument(w, 'sales_invoice', cust, [{ itemId: item, quantity: '100', price, employeeId: emp }]);
  const amount = w.documents.find(d => d.id === inv)!.total;
  let receiptId = '';
  if (method === 'cash') w = run(w, 'create_receipt', { partyId: cust, date: T, amount, method: 'cash', dueDate: T, allocations: [{ invoiceId: inv, amount }], accountId: 'cash' }).workspace;
  else {
    const r = run(w, 'create_receipt', { partyId: cust, date: T, amount, method: 'cheque', chequeNo: 'CHQ-9', dueDate: T, allocations: [{ invoiceId: inv, amount }] });
    receiptId = r.recordId;
    w = run(r.workspace, 'update_cheque', { id: receiptId, status: 'deposited', date: T, accountId: 'main-bank' }).workspace;
    w = run(w, 'update_cheque', { id: receiptId, status: 'cleared', date: T }).workspace;
  }
  const commission = w.commissions.find(c => c.invoiceId === inv)!.id;
  return { w, inv, cust, receiptId, commission };
}
const approveIds = (w: Workspace, ids: string[]) => run(w, 'approve_commission', { ids }).workspace;
const bounce = (w: Workspace, receiptId: string) => run(w, 'update_cheque', { id: receiptId, status: 'bounced', date: T }).workspace;
const com = (w: Workspace, id: string) => w.commissions.find(c => c.id === id)!;
const source = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8');

describe('13 Payroll (PAY)', () => {
  it('PAY-001 creating payroll with no statutory settings is refused', () => {
    let w = freshCompany();
    [w] = addEmployee(w, 'Ayesha');
    expect(payrollConfigured(w)).toBe(false);
    refused(w, 'create_payroll', { month: MONTH }, 'Enter EOBI and income-tax settings in Settings → Payroll before running payroll.');
  });

  it('PAY-002 save settings: employer EOBI 5, employee EOBI 1, base 32,000, tax 5', () => {
    const r = run(freshCompany(), 'save_settings', SETTINGS);
    expect(r.workspace.settings).toEqual(SETTINGS);
    expect(payrollConfigured(r.workspace)).toBe(true);
  });

  it('PAY-003 creating payroll with no active employees is refused', () => {
    let w = run(freshCompany(), 'save_settings', SETTINGS).workspace;
    refused(w, 'create_payroll', { month: MONTH }, 'Add active employees before creating payroll.');
    [w] = addEmployee(w, 'Inactive', { active: false });
    refused(w, 'create_payroll', { month: MONTH }, 'Add active employees before creating payroll.');
  });

  it('PAY-004 create payroll: draft run with one line per active employee [case-corrected: the message is "Payroll calculated." (D-57)]', () => {
    let { w, emp } = setup(); let e2: string;
    [w, e2] = addEmployee(w, 'Bilal', { salary: '50000', allowance: '0' });
    const r = run(w, 'create_payroll', { month: MONTH });
    expect(r.message).toBe('Payroll calculated.');
    const pr = r.workspace.payrolls[0];
    expect(pr).toMatchObject({ month: MONTH, status: 'draft', date: `${MONTH}-28` });
    expect(lineOf(r.workspace, pr.id, emp)).toEqual({ employeeId: emp, basic: '100000.0000', allowance: '10000', commission: '0.0000', deduction: '0', employeeEobi: '320.0000', employerEobi: '1600.0000', incomeTax: '5500.0000', net: '104180.0000', commissionIds: [], commissionAmounts: {}, recovery: '0.0000', recoveryAmounts: {} });
    expect(lineOf(r.workspace, pr.id, e2).net).toBe('47180.0000');
  });

  it('PAY-005 a second run for the same month is refused', () => {
    const [w] = create(setup().w);
    refused(w, 'create_payroll', { month: MONTH }, 'A payroll run already exists for this month.');
  });

  it('PAY-006 month 2026-13 fails validation', () => {
    refused(setup().w, 'create_payroll', { month: '2026-13' }, /invalid_format/);
  });

  it('PAY-007 month 10-2026 fails validation', () => {
    refused(setup().w, 'create_payroll', { month: '10-2026' }, /invalid_format/);
  });

  it('PAY-008 default run date is the 28th of the month', () => {
    const [w, id] = create(setup().w, '2026-09');
    expect(w.payrolls.find(p => p.id === id)!.date).toBe('2026-09-28');
  });

  it('PAY-009 run dated in a locked period is refused', () => {
    const w = run(setup().w, 'set_period', { month: '2026-09', locked: true }).workspace;
    refused(w, 'create_payroll', { month: '2026-09' }, 'Accounting period 2026-09 is locked.');
  });

  it('PAY-010 gross with attendance 30 vs 15 [documented: basic = salary × attendance ÷ 30; allowance is not prorated]', () => {
    let { w, emp } = setup(); let half: string, id: string;
    [w, half] = addEmployee(w, 'Half month', { attendance: 15 });
    [w, id] = create(w);
    expect([lineOf(w, id, emp).basic, lineOf(w, id, emp).allowance]).toEqual(['100000.0000', '10000']);
    expect([lineOf(w, id, half).basic, lineOf(w, id, half).allowance]).toEqual(['50000.0000', '10000']);
  });

  it('PAY-011 attendance 0 [documented: basic 0, allowance still paid; with no allowance the employee EOBI makes deductions exceed earnings and the whole run is refused]', () => {
    const a = setup({}, { attendance: 0 });
    const [w, id] = create(a.w);
    expect(lineOf(w, id, a.emp)).toMatchObject({ basic: '0.0000', net: '9180.0000' });
    expect(D(lineOf(w, id, a.emp).net).gte(0)).toBe(true);
    const b = setup({}, { attendance: 0, allowance: '0' });
    refused(b.w, 'create_payroll', { month: MONTH }, 'Deductions exceed earnings for Ayesha Siddiqui.');
  });

  it('PAY-012 employee EOBI = base × 1% = 320', () => {
    const { w: w0, emp } = setup();
    const [w, id] = create(w0);
    expect(lineOf(w, id, emp).employeeEobi).toBe('320.0000');
  });

  it('PAY-013 employer EOBI = base × 5% = 1,600, an expense not deducted from net', () => {
    const { w: w0, emp } = setup();
    let [w, id] = create(w0);
    expect(lineOf(w, id, emp).employerEobi).toBe('1600.0000');
    expect(lineOf(w, id, emp).net).toBe('104180.0000');
    w = advance(w, id, ['reviewed', 'approved']);
    expect(accountBalance(w, '5200')).toBe('111600.0000');
  });

  it('PAY-014 income tax = 5% of earnings including commission', () => {
    let { w, emp } = setup(); let commission: string;
    ({ w, commission } = commissionFor(w, emp, '1000'));
    w = approveIds(w, [commission]);
    const [w2, id] = create(w);
    expect(lineOf(w2, id, emp)).toMatchObject({ commission: '2000.0000', incomeTax: '5600.0000', net: '106080.0000' });
  });

  it('PAY-015 deductions exceeding earnings are refused', () => {
    const { w } = setup({}, { deduction: '200000' });
    refused(w, 'create_payroll', { month: MONTH }, 'Deductions exceed earnings for Ayesha Siddiqui.');
  });

  it('PAY-016 approved released commission is included with its id recorded', () => {
    let { w, emp } = setup(); let commission: string;
    ({ w, commission } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    const [w2, id] = create(w);
    expect(lineOf(w2, id, emp)).toMatchObject({ commission: '200.0000', commissionIds: [commission], commissionAmounts: { [commission]: '200.0000' } });
  });

  it('PAY-017 unapproved commission is excluded', () => {
    let { w, emp } = setup();
    ({ w } = commissionFor(w, emp));
    const [w2, id] = create(w);
    expect(lineOf(w2, id, emp)).toMatchObject({ commission: '0.0000', commissionIds: [] });
  });

  it('PAY-018 released but unapproved is not paid; once approved it is picked up by the next run', () => {
    let { w, emp } = setup(); let commission: string, id: string;
    ({ w, commission } = commissionFor(w, emp));
    [w, id] = create(w);
    w = advance(w, id, FULL);
    expect(com(w, commission).paid).toBe('0.0000');
    w = approveIds(w, [commission]);
    let id2: string;
    [w, id2] = create(w, M2);
    expect(lineOf(w, id2, emp).commissionIds).toEqual([commission]);
    w = advance(w, id2, FULL);
    expect(com(w, commission).paid).toBe('200.0000');
  });

  it('PAY-019 a commission held by an unpaid run is not included in another run', () => {
    let { w, emp } = setup(); let commission: string, id: string, id2: string;
    ({ w, commission } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    [w, id2] = create(w, M2);
    expect(lineOf(w, id, emp).commissionIds).toEqual([commission]);
    expect(lineOf(w, id2, emp).commissionIds).toEqual([]);
  });

  it('PAY-020 review → approve → pay transitions in order', () => {
    let [w, id] = create(setup().w);
    for (const s of FULL) {
      const r = run(w, 'update_payroll', { id, status: s });
      expect(r.message).toBe(`Payroll ${s}. Bank transmission is simulated.`);
      w = r.workspace;
      expect(w.payrolls[0].status).toBe(s);
    }
  });

  it('PAY-021 skipping draft → approved is refused', () => {
    const [w, id] = create(setup().w);
    refused(w, 'update_payroll', { id, status: 'approved' }, 'Invalid payroll transition.');
  });

  it('PAY-022 a paid run cannot move to any status', () => {
    let [w, id] = create(setup().w);
    w = advance(w, id, FULL);
    for (const s of ['reviewed', 'approved', 'paid']) refused(w, 'update_payroll', { id, status: s }, 'Invalid payroll transition.');
    refused(w, 'update_payroll', { id, status: 'draft' }, /invalid_value/);
  });

  it('PAY-023 approval refused when the commission changed (bounce) after calculation', () => {
    let { w, emp } = setup(); let commission: string, receiptId: string, id: string;
    ({ w, commission, receiptId } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    w = advance(w, id, ['reviewed']);
    w = bounce(w, receiptId);
    refused(w, 'update_payroll', { id, status: 'approved' }, 'Commission changed since this payroll was calculated. Reconcile the run before approval.');
  });

  it('PAY-024 approval refused when the recovery changed after calculation', () => {
    let { w, emp } = setup(); let commission: string, receiptId: string, inv: string, cust: string, id: string;
    ({ w, commission, receiptId, inv, cust } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    w = bounce(w, receiptId);
    let id2: string;
    [w, id2] = create(w, M2);
    expect(lineOf(w, id2, emp).recovery).toBe('200.0000');
    w = run(w, 'create_receipt', { partyId: cust, date: T, amount: '10000', method: 'cash', dueDate: T, allocations: [{ invoiceId: inv, amount: '10000' }], accountId: 'cash' }).workspace;
    refused(w, 'update_payroll', { id: id2, status: 'reviewed' }, 'Commission recovery changed since this payroll was calculated. Reconcile the run before approval.');
  });

  it('PAY-025 reconcile by recreating the run (cancel draft and create again) works', () => {
    let { w, emp } = setup(); let commission: string, receiptId: string, id: string;
    ({ w, commission, receiptId } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    w = bounce(w, receiptId);
    refused(w, 'update_payroll', { id, status: 'reviewed' }, 'Commission changed since this payroll was calculated.');
    // The documented path: cancel the stale draft, then create the month again.
    const types = commandSchema.shape.type.options as readonly string[];
    expect(types.some(t => /payroll/.test(t) && /cancel|delete|recalc/.test(t))).toBe(true);
    w = run(w, 'cancel_payroll', { id }).workspace;
    let again: string; [w, again] = create(w);
    expect(again).toBe(id);
    expect(w.payrolls.filter(p => p.month === MONTH)).toHaveLength(1);
    expect(lineOf(w, again, emp).commissionIds).toEqual([]);
    w = advance(w, again, FULL);
    expect(w.payrolls[0].status).toBe('paid');
    expectInvariants(w);
  });

  it('PAY-026 postings: approval Dr salary (incl. employer EOBI) / Dr commission payable / Cr payroll payable / Cr statutory; pay settles payroll payable — commission not expensed twice [documented: expense posts at approval, payment credits legacy 1000]', () => {
    let { w, emp } = setup(); let commission: string, id: string;
    ({ w, commission } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    const commissionExpense = accountBalance(w, '5100');
    [w, id] = create(w);
    w = advance(w, id, FULL);
    const approve = w.journals.find(j => j.sourceId === `${id}:approve`)!;
    expect(approve.lines).toEqual([
      { account: '5200', debit: '111600.0000', credit: '0.0000' },
      { account: '2200', debit: '200.0000', credit: '0.0000' },
      { account: '2300', debit: '0.0000', credit: '104370.0000' },
      { account: '2400', debit: '0.0000', credit: '7430.0000' },
    ]);
    expect(w.journals.find(j => j.sourceId === `${id}:paid`)!.lines).toEqual([{ account: '2300', debit: '104370.0000', credit: '0.0000' }, { account: '1000', debit: '0.0000', credit: '104370.0000' }]);
    expect(accountBalance(w, '5100')).toBe(commissionExpense);
    expect(accountBalance(w, '2200')).toBe('0.0000');
    expectInvariants(w);
  });

  it('PAY-027 paying the run updates entitlement paid and adds a paid movement', () => {
    let { w, emp } = setup(); let commission: string, id: string;
    ({ w, commission } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    expect(com(w, commission).paid).toBe('200.0000');
    expect(w.commissionMovements.filter(m => m.commissionId === commission && m.type === 'paid')).toEqual([expect.objectContaining({ sourceId: id, amount: '200.0000', note: 'Simulated payroll payment; no bank transmission' })]);
  });

  it('PAY-028 bounce recovery: paid 200, bounce → 200 recovered in the next run', () => {
    let { w, emp } = setup(); let commission: string, receiptId: string, id: string;
    ({ w, commission, receiptId } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    w = bounce(w, receiptId);
    let id2: string;
    [w, id2] = create(w, M2);
    expect(lineOf(w, id2, emp)).toMatchObject({ recovery: '200.0000', incomeTax: '5490.0000', net: '103990.0000' });
    w = advance(w, id2, FULL);
    expect(com(w, commission).paid).toBe('0.0000');
    expectInvariants(w);
  });

  it('PAY-029 recovery larger than available net is partial; the remainder stays recoverable', () => {
    let { w, emp } = setup({}, { salary: '1000', allowance: '0' }); let commission: string, receiptId: string, id: string;
    ({ w, commission, receiptId } = commissionFor(w, emp, '1000'));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    w = bounce(w, receiptId);
    let id2: string;
    [w, id2] = create(w, M2);
    expect(lineOf(w, id2, emp)).toMatchObject({ recovery: '630.0000', incomeTax: '18.5000', net: '31.5000' });
    w = advance(w, id2, FULL);
    expect(commissionTotals(w).recoverable).toBe('1370.0000');
    expectInvariants(w);
  });

  it('PAY-030 attendance CSV import updates attendance', () => {
    let { w, emp } = setup(); let e2: string;
    [w, e2] = addEmployee(w, 'Bilal Ahmed');
    const r = run(w, 'import_records', { kind: 'attendance', rows: [{ name: 'Ayesha Siddiqui', attendance: '26' }, { employeeId: e2, attendance: '28.5' }] });
    expect(r.message).toBe('Imported 2 attendance: 0 created, 2 updated.');
    expect(r.workspace.employees.map(e => [e.id, e.attendance])).toEqual([[emp, 26], [e2, 28.5]]);
  });

  it('PAY-031 attendance import with an unknown employee is refused', () => {
    refused(setup().w, 'import_records', { kind: 'attendance', rows: [{ name: 'Nobody', attendance: '20' }] }, 'Row 2: employee Nobody not found');
  });

  it('PAY-032 attendance 31 in the file is a row error', () => {
    const { w } = setup();
    // The import and save_employee share one 0–30 rule (basic pay = salary × attendance ÷ 30).
    refused(w, 'import_records', { kind: 'attendance', rows: [{ name: 'Ayesha Siddiqui', attendance: '31' }] }, 'Row 2: Attendance cannot exceed 30 days.');
  });

  it('PAY-033 payroll print / payslip [documented: not present; printable kinds are sales, purchase and receipt documents only]', () => {
    expect((printableKinds as readonly string[]).some(k => /pay/.test(k))).toBe(false);
  });

  it('PAY-034 runs carry status and total for the list [browser: list rendering]', () => {
    let [w, id] = create(setup().w);
    w = advance(w, id, ['reviewed']);
    expect(w.payrolls.map(p => [p.number, p.month, p.status, p.total, p.lines.length])).toEqual([[`PAY-${MONTH}`, MONTH, 'reviewed', '104180.0000', 1]]);
  });

  it('PAY-035 Payroll Administrator creates a run', () => {
    const [w] = create(setup().w, MONTH, {}, payAdmin);
    expect(w.payrolls).toHaveLength(1);
  });

  it('PAY-036 Sales Manager: no payroll data, salaries zeroed, create refused [browser: Payroll hidden]', () => {
    const [w] = create(setup().w);
    const view = scopeWorkspace(w, actor('Sales Manager'));
    expect(view.payrolls).toEqual([]);
    expect(view.employees.map(e => e.salary)).toEqual(['0']);
    refused(w, 'create_payroll', { month: M2 }, 'Your role does not permit this action.', actor('Sales Manager'));
  });

  it('PAY-037 Salesperson create_payroll via API is refused', () => {
    refused(setup().w, 'create_payroll', { month: MONTH }, 'Your role does not permit this action.', actor('Salesperson'));
  });

  it('PAY-038 Auditor sees full payroll but cannot change it', () => {
    const [w, id] = create(setup().w);
    const view = scopeWorkspace(w, actor('Auditor'));
    expect(view.payrolls).toEqual(w.payrolls);
    expect(view.employees[0].salary).toBe('100000');
    refused(w, 'update_payroll', { id, status: 'reviewed' }, 'Your role does not permit this action.', actor('Auditor'));
  });

  it('PAY-039 branch-limited Accountant receives no payroll runs', () => {
    const [w] = create(setup().w);
    expect(scopeWorkspace(w, actor('Accountant', { branchIds: ['main'] })).payrolls).toEqual([]);
  });

  it('PAY-040 Payroll off: API refused with the module-off message [browser: sidebar entry absent]', () => {
    const { w } = setup({}, {}, ['sales', 'purchasing', 'inventory', 'collections', 'cashbank', 'commissions', 'reports']);
    refused(w, 'create_payroll', { month: MONTH }, 'Payroll is turned off for this company. Turn it on in Settings → Features.');
  });

  it('PAY-041 turning Payroll on later: fixed accounts exist, statutory settings are still required [documented: no account provisioning needed; chart is fixed]', () => {
    let w = freshCompany(['sales', 'inventory', 'reports']);
    w = run(w, 'set_modules', { enabled: [...w.modules, 'payroll'] }).workspace;
    expect(w.modules).toContain('payroll');
    [w] = addEmployee(w, 'Ayesha');
    refused(w, 'create_payroll', { month: MONTH }, 'Enter EOBI and income-tax settings in Settings → Payroll before running payroll.');
  });

  it('PAY-042 salary 0 employee: line with 0 gross; commission still paid', () => {
    let { w, emp } = setup({}, { salary: '0', allowance: '0' }); let commission: string, id: string;
    ({ w, commission } = commissionFor(w, emp, '1000'));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    expect(lineOf(w, id, emp)).toMatchObject({ basic: '0.0000', commission: '2000.0000', employeeEobi: '320.0000', incomeTax: '100.0000', net: '1580.0000' });
    w = advance(w, id, FULL);
    expect(com(w, commission).paid).toBe('2000.0000');
  });

  it('PAY-043 commission-only employee [case-corrected: net = commission − income tax − employee EOBI]', () => {
    let { w, emp } = setup({}, { salary: '0', allowance: '0' }); let commission: string, id: string;
    ({ w, commission } = commissionFor(w, emp, '5000'));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    const l = lineOf(w, id, emp);
    expect(l.commission).toBe('10000.0000');
    expect(l.net).toBe(money(D(l.commission).minus(l.incomeTax).minus(l.employeeEobi)));
    expect(l.net).toBe('9180.0000');
  });

  it('PAY-044 500 employees: run computes in < 5 s', () => {
    const { w } = setup();
    for (let i = 0; i < 499; i++) w.employees.push({ id: `bulk-${i}`, ...employee(`Bulk ${i}`, { salary: String(30000 + i) }) });
    const start = performance.now();
    const [w2, id] = create(w);
    expect(performance.now() - start).toBeLessThan(5000);
    const pr = w2.payrolls.find(p => p.id === id)!;
    expect(pr.lines).toHaveLength(500);
    expect(pr.total).toBe(money(sum(pr.lines.map(l => l.net))));
  });

  it('PAY-045 settings EOBI 100% is allowed', () => {
    expect(run(freshCompany(), 'save_settings', { ...SETTINGS, employerEobi: '100', employeeEobi: '100' }).workspace.settings.employeeEobi).toBe('100');
  });

  it('PAY-046 settings income tax 101 is refused', () => {
    refused(freshCompany(), 'save_settings', { ...SETTINGS, incomeTaxRate: '101' }, 'Percentage cannot exceed 100.');
  });

  it('PAY-047 blank statutory settings save, but payroll is refused', () => {
    let w = run(freshCompany(), 'save_settings', { ...SETTINGS, employerEobi: '', employeeEobi: '', eobiBase: '', incomeTaxRate: '' }).workspace;
    [w] = addEmployee(w, 'Ayesha');
    refused(w, 'create_payroll', { month: MONTH }, 'Enter EOBI and income-tax settings in Settings → Payroll before running payroll.');
  });

  it('PAY-048 run numbering [case-corrected: PAY-YYYY-MM (one run per month), not PAY-2026-0001]', () => {
    let [w] = create(setup().w, '2026-09');
    [w] = create(w, MONTH);
    expect(w.payrolls.map(p => p.number)).toEqual(['PAY-2026-09', `PAY-${MONTH}`]);
  });

  it('PAY-049 run for a past open month is allowed', () => {
    const [w, id] = create(setup().w, '2026-08');
    expect(w.payrolls.find(p => p.id === id)!.date).toBe('2026-08-28');
  });

  it('PAY-050 run for a future month [documented: allowed]', () => {
    const [w, id] = create(setup().w, '2027-03');
    expect(w.payrolls.find(p => p.id === id)!).toMatchObject({ month: '2027-03', date: '2027-03-28', status: 'draft' });
  });

  it('PAY-051 two runs in different months: the second excludes already paid commission', () => {
    let { w, emp } = setup(); let commission: string, id: string, id2: string;
    ({ w, commission } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    [w, id2] = create(w, M2);
    expect(lineOf(w, id2, emp)).toMatchObject({ commission: '0.0000', commissionIds: [] });
  });

  it('PAY-052 run total equals the sum of line nets', () => {
    let { w } = setup();
    [w] = addEmployee(w, 'Bano', { salary: '33333.33', attendance: 29 });
    [w] = addEmployee(w, 'Chand', { salary: '77777.77', deduction: '1234.56' });
    const [w2, id] = create(w);
    const pr = w2.payrolls.find(p => p.id === id)!;
    expect(pr.total).toBe(money(sum(pr.lines.map(l => l.net))));
  });

  it('PAY-053 payroll payable 2300 is −total after approval and 0 after payment [documented: no payroll row in the Control reconciliation]', () => {
    let [w, id] = create(setup().w);
    w = advance(w, id, ['reviewed', 'approved']);
    expect(accountBalance(w, '2300')).toBe('-104180.0000');
    w = advance(w, id, ['paid']);
    expect(accountBalance(w, '2300')).toBe('0.0000');
    expect(readFileSync(resolve(__dirname, '../../src/components/reports-view.tsx'), 'utf8')).not.toContain("'Payroll payable'");
  });

  it('PAY-054 cancel / delete a draft run [case-corrected: cancel_payroll cancels a draft or reviewed run; approved and paid runs are refused (D-10)]', () => {
    const [w, id] = create(setup().w);
    expect((commandSchema.shape.type.options as readonly string[]).filter(t => t.includes('payroll'))).toEqual(['create_payroll', 'update_payroll', 'cancel_payroll']);
    const cancelled = execute(w, { type: 'cancel_payroll', payload: { id }, idempotencyKey: 'qa-cancel-payroll' }, owner).workspace;
    expect(cancelled.payrolls.find(p => p.id === id)!.status).toBe('cancelled');
    expect(cancelled.journals.filter(j => j.sourceId.startsWith(id))).toEqual([]);
    const approved = advance(w, id, ['reviewed', 'approved']);
    refused(approved, 'cancel_payroll', { id }, 'Only draft or reviewed payroll runs can be cancelled.');
  });

  it('PAY-055 employee deactivated after the run was created: the line stays and is paid', () => {
    let { w, emp } = setup(); let id: string;
    [w, id] = create(w);
    w = run(w, 'save_employee', { ...w.employees[0], active: false }).workspace;
    w = advance(w, id, FULL);
    expect(lineOf(w, id, emp).net).toBe('104180.0000');
    expect(accountBalance(w, '2300')).toBe('0.0000');
  });

  it('PAY-056 employee deactivated before the run is excluded', () => {
    let { w, emp } = setup(); let e2: string, id: string;
    [w, e2] = addEmployee(w, 'Leaver');
    w = run(w, 'save_employee', { ...w.employees.find(e => e.id === e2), active: false }).workspace;
    [w, id] = create(w);
    expect(w.payrolls.find(p => p.id === id)!.lines.map(l => l.employeeId)).toEqual([emp]);
  });

  it('PAY-057 employee deduction is deducted and credited to statutory/deductions payable', () => {
    let { w, emp } = setup({}, { deduction: '5000' }); let id: string;
    [w, id] = create(w);
    expect(lineOf(w, id, emp).net).toBe('99180.0000');
    w = advance(w, id, ['reviewed', 'approved']);
    expect(accountBalance(w, '2400')).toBe('-12420.0000');
  });

  it('PAY-058 deduction equal to remaining earnings gives net 0 (allowed)', () => {
    const { w: w0, emp } = setup({}, { deduction: '104180' });
    const [w, id] = create(w0);
    expect(lineOf(w, id, emp).net).toBe('0.0000');
  });

  it('PAY-059 deduction greater than earnings is refused with the message', () => {
    refused(setup({}, { deduction: '104180.0001' }).w, 'create_payroll', { month: MONTH }, 'Deductions exceed earnings for Ayesha Siddiqui.');
  });

  it('PAY-060 review as Accountant, approve as Owner, pay as Accountant', () => {
    let [w, id] = create(setup().w, MONTH, {}, accountant);
    w = advance(w, id, ['reviewed'], accountant);
    w = advance(w, id, ['approved'], owner);
    w = advance(w, id, ['paid'], accountant);
    expect(w.payrolls[0].status).toBe('paid');
    expect(w.audit.filter(a => a.action === 'update_payroll').map(a => a.role)).toEqual(['Accountant', 'Owner', 'Accountant']);
  });

  it('PAY-061 Payroll Administrator can pay', () => {
    let [w, id] = create(setup().w, MONTH, {}, payAdmin);
    w = advance(w, id, FULL, payAdmin);
    expect(w.payrolls[0].status).toBe('paid');
  });

  it.todo('PAY-062 [browser] Settings → Payroll section visible only while Payroll is on');
  it.todo('PAY-063 [browser] payroll lines table scrolls horizontally and stays readable on a phone');
  it.todo('PAY-064 [browser] payroll status badges use distinct colours');

  it('PAY-065 each transition writes an audit entry [case-corrected: the create message is "Payroll calculated." (D-57)]', () => {
    let [w, id] = create(setup().w);
    w = advance(w, id, FULL);
    expect(w.audit.slice(-4).map(a => [a.action, a.sourceId, a.detail])).toEqual([
      ['create_payroll', id, 'Payroll calculated.'],
      ['update_payroll', id, 'Payroll reviewed. Bank transmission is simulated.'],
      ['update_payroll', id, 'Payroll approved. Bank transmission is simulated.'],
      ['update_payroll', id, 'Payroll paid. Bank transmission is simulated.'],
    ]);
  });

  it('PAY-066 pay retried with the same idempotency key posts one payment journal [case-corrected: a replay returns the original recordId and message (D-17)]', () => {
    let [w, id] = create(setup().w);
    w = advance(w, id, ['reviewed', 'approved']);
    const first = run(w, 'update_payroll', { id, status: 'paid' }, owner, 'qa-pay-retry-1');
    const second = run(first.workspace, 'update_payroll', { id, status: 'paid' }, owner, 'qa-pay-retry-1');
    expect([second.recordId, second.message]).toEqual([first.recordId, first.message]);
    expect(second.workspace.journals.filter(j => j.sourceId === `${id}:paid`)).toHaveLength(1);
  });

  it('PAY-067 pay in a locked period is refused', () => {
    let [w, id] = create(setup().w, '2026-09');
    w = advance(w, id, ['reviewed', 'approved']);
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    refused(w, 'update_payroll', { id, status: 'paid' }, 'Accounting period 2026-09 is locked.');
  });

  it('PAY-068 locking the period after pay is allowed and the run is unchanged', () => {
    let [w, id] = create(setup().w, '2026-09');
    w = advance(w, id, FULL);
    const before = JSON.stringify(w.payrolls);
    w = run(w, 'set_period', { month: '2026-09', locked: true }).workspace;
    expect(JSON.stringify(w.payrolls)).toBe(before);
  });

  it('PAY-069 commission from walk-in customer invoices is included', () => {
    let { w, emp } = setup(); let walkIn: string, item: string, inv: string, id: string;
    w = run(w, 'save_plan', { ...w.plans[0], rate: '2' }).workspace;
    [w, walkIn] = withParty(w, 'customer', { name: 'Walk-in customer' });
    [w, item] = withItem(w, {}, { quantity: '100', cost: '1' });
    [w, inv] = withDocument(w, 'sales_invoice', walkIn, [{ itemId: item, quantity: '10', price: '500', employeeId: emp }], { partyName: 'Counter sale' });
    w = run(w, 'create_receipt', { partyId: walkIn, date: T, amount: '5000', method: 'cash', dueDate: T, allocations: [{ invoiceId: inv, amount: '5000' }], accountId: 'cash' }).workspace;
    w = approveIds(w, [w.commissions[0].id]);
    [w, id] = create(w);
    expect(lineOf(w, id, emp).commission).toBe('100.0000');
  });

  it('PAY-070 after pay, entitlement paid ≤ released', () => {
    let { w, emp } = setup(); let commission: string, id: string;
    ({ w, commission } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    for (const c of w.commissions) expect(D(c.paid).lte(c.released)).toBe(true);
  });

  it('PAY-071 paid movement amount per entitlement', () => {
    let { w, emp } = setup(); let id: string;
    const a = commissionFor(w, emp); w = a.w;
    const b = commissionFor(w, emp, '250', 'cash'); w = b.w;
    w = approveIds(w, [a.commission, b.commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    expect(w.commissionMovements.filter(m => m.type === 'paid').map(m => [m.commissionId, m.amount])).toEqual([[a.commission, '200.0000'], [b.commission, '500.0000']]);
  });

  it('PAY-072 salary change after the draft run: the run keeps calculated values', () => {
    let { w, emp } = setup(); let id: string;
    [w, id] = create(w);
    w = run(w, 'save_employee', { ...w.employees[0], salary: '200000' }).workspace;
    expect(lineOf(w, id, emp).basic).toBe('100000.0000');
    w = advance(w, id, ['reviewed', 'approved']);
    expect(accountBalance(w, '5200')).toBe('111600.0000');
  });

  it('PAY-073 settings change after the draft run: the run keeps its values', () => {
    let { w, emp } = setup(); let id: string;
    [w, id] = create(w);
    w = run(w, 'save_settings', { ...SETTINGS, incomeTaxRate: '20', eobiBase: '50000' }).workspace;
    expect(lineOf(w, id, emp)).toMatchObject({ incomeTax: '5500.0000', employeeEobi: '320.0000' });
  });

  it('PAY-074 EOBI base 0 gives EOBI 0', () => {
    const { w: w0, emp } = setup({ eobiBase: '0' });
    const [w, id] = create(w0);
    expect(lineOf(w, id, emp)).toMatchObject({ employeeEobi: '0.0000', employerEobi: '0.0000' });
  });

  it('PAY-075 income tax 0 gives no tax', () => {
    const { w: w0, emp } = setup({ incomeTaxRate: '0' });
    const [w, id] = create(w0);
    expect(lineOf(w, id, emp)).toMatchObject({ incomeTax: '0.0000', net: '109680.0000' });
  });

  it('PAY-076 payroll CSV export [documented: not present in the Payroll view]', () => {
    const payrollView = source('src/components/workbench.tsx').split("if(active==='payroll')")[1].split('\n')[0];
    expect(payrollView).not.toMatch(/toCsv|Export/);
  });

  it('PAY-077 global search finds a payroll run [documented: not present; search covers documents, parties and items only]', () => {
    const search = source('src/components/workbench.tsx').split('function SearchDialog')[1].split('\nfunction ')[0];
    expect(search).not.toContain('payrolls');
  });

  it('PAY-078 non-pay roles receive no payroll numbers in their projection [browser: overview tiles]', () => {
    const [w] = create(setup().w);
    for (const role of ['Sales Manager', 'Salesperson', 'Recovery Officer', 'Warehouse Manager'] as const) {
      const view = scopeWorkspace(w, actor(role));
      expect(view.payrolls).toEqual([]);
      expect(view.journals).toEqual([]);
    }
  });

  it('PAY-079 trial balance is balanced after pay', () => {
    let { w, emp } = setup(); let commission: string, id: string;
    ({ w, commission } = commissionFor(w, emp));
    w = approveIds(w, [commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    const tb = trialBalance(w, '2099-12-31');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expectInvariants(w);
  });

  it('PAY-080 P&L shows salary expense including employer EOBI [documented: employer EOBI is inside 5200 Salary expense, no separate line]', () => {
    let [w, id] = create(setup().w);
    w = advance(w, id, ['reviewed', 'approved']);
    expect(profitAndLoss(w, `${MONTH}-01`, `${MONTH}-31`).expenses).toEqual([{ code: '5200', name: 'Salary expense', amount: '111600.0000' }]);
  });

  it('PAY-081 balance sheet shows payroll and statutory payables until settled [documented: 2400 is never settled in-app]', () => {
    let [w, id] = create(setup().w);
    w = advance(w, id, ['reviewed', 'approved']);
    const asOf = '2099-12-31';
    expect(balanceSheet(w, asOf).liabilities.map(r => [r.code, r.amount])).toEqual([['2300', '104180.0000'], ['2400', '7420.0000']]);
    w = advance(w, id, ['paid']);
    expect(balanceSheet(w, asOf).liabilities.map(r => [r.code, r.amount])).toEqual([['2400', '7420.0000']]);
    expect(balanceSheet(w, asOf).difference).toBe('0.0000');
  });

  it('PAY-082 settling statutory payable [documented: payroll pay settles 2300 automatically; 2400 needs a manual journal because record_expense only allows 5100/5200/5300]', () => {
    let [w, id] = create(setup().w);
    w = advance(w, id, FULL);
    refused(w, 'record_expense', { accountId: 'main-bank', amount: '7420', date: T, memo: 'EOBI and tax', expenseAccount: '2400' }, /invalid_value/);
    w = run(w, 'create_journal', { memo: 'Pay EOBI and withholding', date: T, lines: [{ account: '2400', debit: '7420', credit: '0' }, { account: '1001', debit: '0', credit: '7420' }] }).workspace;
    expect(accountBalance(w, '2400')).toBe('0.0000');
  });

  it('PAY-083 attendance default 30 [documented: import and the form default to 30; the API requires attendance]', () => {
    const imported = run(run(freshCompany(), 'save_settings', SETTINGS).workspace, 'import_records', { kind: 'employees', rows: [{ name: 'Default Days', salary: '1000' }] }).workspace;
    expect(imported.employees[0].attendance).toBe(30);
    const { attendance: _a, ...noAttendance } = employee('No days');
    refused(freshCompany(), 'save_employee', noAttendance, /invalid_type|expected number/);
  });

  it('PAY-084 attendance 29.5 is allowed and prorates', () => {
    const { w: w0, emp } = setup({}, { attendance: 29.5 });
    const [w, id] = create(w0);
    expect(lineOf(w, id, emp).basic).toBe('98333.3333');
  });

  it('PAY-085 payroll summary report [documented: not present; payroll appears only through P&L / ledger accounts]', () => {
    const view = source('src/components/reports-view.tsx');
    expect(view).not.toMatch(/key: 'payroll/);
  });

  it("PAY-086 update_payroll with another tenant's id is not found", () => {
    const [, foreign] = create(setup().w);
    refused(setup().w, 'update_payroll', { id: foreign, status: 'reviewed' }, 'Payroll not found.');
  });

  it('PAY-087 hiding Payroll keeps existing runs', () => {
    let [w] = create(setup().w);
    expect(moduleRecordCounts(w, 'payroll')).toEqual([{ label: 'payroll runs', count: 1 }, { label: 'employees', count: 1 }]);
    w = run(w, 'set_modules', { enabled: w.modules.filter(m => m !== 'payroll') }).workspace;
    expect(w.payrolls).toHaveLength(1);
  });

  it.todo('PAY-088 [browser] transition button is disabled while a command is busy');
  it.todo('PAY-089 [browser] line commission tooltip listing invoices (not present in the runs table)');

  it('PAY-090 recoveries across several employees are independent', () => {
    let { w, emp } = setup(); let e2: string, id: string;
    [w, e2] = addEmployee(w, 'Bilal');
    const a = commissionFor(w, emp); w = a.w;
    const b = commissionFor(w, e2, '250'); w = b.w;
    w = approveIds(w, [a.commission, b.commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    w = bounce(w, b.receiptId);
    let id2: string;
    [w, id2] = create(w, M2);
    expect([lineOf(w, id2, emp).recovery, lineOf(w, id2, e2).recovery]).toEqual(['0.0000', '500.0000']);
    expect(com(w, a.commission).paid).toBe('200.0000');
  });

  it('PAY-091 recovery never exceeds paid − released', () => {
    let { w, emp } = setup(); let id: string;
    const a = commissionFor(w, emp); w = a.w;
    w = approveIds(w, [a.commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    w = bounce(w, a.receiptId);
    let id2: string;
    [w, id2] = create(w, M2);
    for (const [key, amount] of Object.entries(lineOf(w, id2, emp).recoveryAmounts ?? {})) expect(D(amount).lte(D(com(w, key).paid).minus(com(w, key).released))).toBe(true);
  });

  it('PAY-092 after recovery the entitlement paid is reduced', () => {
    let { w, emp } = setup(); let id: string, id2: string;
    const a = commissionFor(w, emp); w = a.w;
    w = approveIds(w, [a.commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    w = bounce(w, a.receiptId);
    [w, id2] = create(w, M2);
    expect(com(w, a.commission).paid).toBe('200.0000');
    w = advance(w, id2, FULL);
    expect(com(w, a.commission).paid).toBe('0.0000');
  });

  it('PAY-093 run with 0 total is allowed; zero postings are skipped', () => {
    let [w, id] = create(setup({ eobiBase: '0' }, { salary: '0', allowance: '0' }).w);
    expect(w.payrolls[0].total).toBe('0.0000');
    w = advance(w, id, FULL);
    expect(w.payrolls[0].status).toBe('paid');
    expect(w.journals.filter(j => j.sourceId.startsWith(id))).toEqual([]);
  });

  it('PAY-094 create_payroll success message has no "prototype" wording', () => {
    const r = run(setup().w, 'create_payroll', { month: MONTH });
    expect(r.message).not.toMatch(/prototype/i);
  });

  it('PAY-095 twelve runs in a year can be created (one per month)', () => {
    let { w } = setup();
    for (let m = 1; m <= 12; m++) [w] = create(w, `2027-${String(m).padStart(2, '0')}`);
    expect(w.payrolls.map(p => p.number)).toHaveLength(12);
    expect(new Set(w.payrolls.map(p => p.number)).size).toBe(12);
  });

  it.todo('PAY-096 [browser] keyboard: payroll transition buttons are focusable and operable');

  it('PAY-097 Payroll Administrator sees sales invoices only in documents', () => {
    let { w, emp } = setup(); let sup: string, item: string;
    ({ w } = commissionFor(w, emp));
    [w, item] = withItem(w);
    [w, sup] = withParty(w, 'supplier');
    [w] = withDocument(w, 'supplier_invoice', sup, [{ itemId: item, quantity: '1', price: '10' }]);
    const view = scopeWorkspace(w, payAdmin);
    expect(view.documents.map(d => d.kind)).toEqual(['sales_invoice']);
    expect(view.journals).toEqual([]);
  });

  it('PAY-098 payroll for a month with no invoices has commission 0', () => {
    const { w: w0, emp } = setup();
    const [w, id] = create(w0, '2026-08');
    expect(lineOf(w, id, emp).commission).toBe('0.0000');
  });

  it('PAY-099 net + deduction + tax + employee EOBI + recovery = basic + allowance + commission, exactly', () => {
    let { w, emp } = setup({}, { deduction: '1234.5678', attendance: 27 }); let e2: string, id: string, id2: string;
    [w, e2] = addEmployee(w, 'Bilal', { salary: '33333.33', attendance: 29.5 });
    const a = commissionFor(w, emp, '333.33'); w = a.w;
    const b = commissionFor(w, e2, '77.77', 'cash'); w = b.w;
    w = approveIds(w, [a.commission, b.commission]);
    [w, id] = create(w);
    w = advance(w, id, FULL);
    w = bounce(w, a.receiptId);
    [w, id2] = create(w, M2);
    for (const pr of w.payrolls) for (const l of pr.lines)
      expect(money(D(l.net).plus(l.deduction).plus(l.incomeTax).plus(l.employeeEobi).plus(l.recovery ?? 0))).toBe(money(D(l.basic).plus(l.allowance).plus(l.commission)));
    expect(lineOf(w, id2, emp).recovery).not.toBe('0.0000');
  });

  it('PAY-100 end to end: settings → employees → invoices/receipts → approve → run → review → approve → pay → bounce → next run recovers', () => {
    let w = freshCompany(); let id: string, id2: string;
    w = run(w, 'save_settings', SETTINGS).workspace;
    const e1 = run(w, 'save_employee', employee('Hamza', { salary: '45000', allowance: '5000' })); w = e1.workspace;
    const e2 = run(w, 'save_employee', employee('Sara', { salary: '95000', allowance: '12000' })); w = e2.workspace;
    const a = commissionFor(w, e1.recordId, '500'); w = a.w;
    const b = commissionFor(w, e2.recordId, '300', 'cash'); w = b.w;
    w = approveIds(w, [a.commission, b.commission]);
    [w, id] = create(w);
    expect([lineOf(w, id, e1.recordId).commission, lineOf(w, id, e2.recordId).commission]).toEqual(['1000.0000', '600.0000']);
    w = advance(w, id, FULL);
    expectInvariants(w);
    w = bounce(w, a.receiptId);
    expect(commissionTotals(w).recoverable).toBe('1000.0000');
    expectInvariants(w);
    [w, id2] = create(w, M2);
    expect(lineOf(w, id2, e1.recordId).recovery).toBe('1000.0000');
    w = advance(w, id2, FULL);
    expect(commissionTotals(w).recoverable).toBe('0.0000');
    expect(accountBalance(w, '2300')).toBe('0.0000');
    const tb = trialBalance(w, '2099-12-31');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expectInvariants(w);
    // A third month runs clean with no further recovery.
    let id3: string;
    [w, id3] = create(w, M3);
    expect(lineOf(w, id3, e1.recordId).recovery).toBe('0.0000');
  });
});
