/**
 * Shared harness for the SQA pack (docs/qa/cases). Every test title starts with its case ID,
 * e.g. it('SAL-012 qty 0.0001 accepted', ...). Cases that cannot run at this layer are
 * recorded with it.todo('SAL-074 [browser] editor on phone') or it.todo('UIX-100 [manual] iPhone hardware').
 */
import { expect } from 'vitest';
import { accountBalance, commissionTotals, execute, outstanding } from '../../src/modules/erp/engine';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { blankWorkspace } from '../../src/modules/erp/seed';
import { D, money, sum } from '../../src/modules/erp/money';
import { landedCostPayable, stockValuation } from '../../src/modules/erp/reports';
import { toggleModules } from '../../src/modules/erp/modules';
import type { Actor, Role, ToggleModule, Workspace } from '../../src/modules/erp/types';

export { D, money, sum, execute, buildDemoWorkspace, blankWorkspace, outstanding, accountBalance };

let counter = 0;
export const key = () => `qa-${Date.now()}-${++counter}`;

export const actor = (role: Role, extra: Partial<Actor> = {}): Actor => ({ id: `qa-${role.toLowerCase().replace(/\s+/g, '-')}`, name: `QA ${role}`, role, branchIds: [], ...extra });
export const owner = actor('Owner');

/** Runs one command; throws the engine's error message on refusal. */
export function run(w: Workspace, type: string, payload: Record<string, unknown> = {}, who: Actor = owner, idempotencyKey = key()) {
  return execute(w, { type, payload, idempotencyKey }, who);
}

/** Asserts a command is refused with a message matching `message`, and that the input workspace is untouched. */
export function refused(w: Workspace, type: string, payload: Record<string, unknown>, message: string | RegExp, who: Actor = owner) {
  const before = JSON.stringify(w);
  let error: unknown;
  try { run(w, type, payload, who); } catch (e) { error = e; }
  expect(error, `${type} should be refused`).toBeInstanceOf(Error);
  const text = (error as Error).message;
  if (typeof message === 'string') expect(text).toContain(message); else expect(text).toMatch(message);
  expect(JSON.stringify(w)).toBe(before);
  return text;
}

/** A brand-new company exactly as the wizard leaves it: company saved, modules chosen, setup completed (provisioned). */
export function freshCompany(modules: ToggleModule[] = [...toggleModules], company: Record<string, unknown> = {}): Workspace {
  let w = blankWorkspace(false);
  w = { ...w, tenantId: 'qa-tenant' };
  w = run(w, 'save_company', { name: 'QA Trading Co', address: '12 Jodia Bazar, Karachi', phone: '+92 300 1234567', email: 'office@qa.example', taxId: '', ...company }).workspace;
  w = run(w, 'set_modules', { enabled: modules }).workspace;
  w = run(w, 'complete_setup', {}).workspace;
  return w;
}

export const today = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10); // Asia/Karachi
export const firstWarehouse = (w: Workspace) => w.warehouses[0].id;

/** Adds a product and (optionally) opening stock; returns [workspace, itemId]. */
export function withItem(w: Workspace, fields: Record<string, unknown> = {}, opening?: { quantity: string; cost: string; warehouseId?: string }): [Workspace, string] {
  const r = run(w, 'save_item', { sku: `SKU-${++counter}`, name: `Item ${counter}`, category: 'General', hsCode: '', unit: 'pcs', price: '100', cost: '60', weight: '1', volume: '1', reorderLevel: 0, ...fields });
  let next = r.workspace;
  if (opening) next = run(next, 'bulk_stock_increase', { warehouseId: opening.warehouseId ?? firstWarehouse(next), date: today(), purpose: 'opening_stock', reason: 'QA opening', lines: [{ itemId: r.recordId, quantity: opening.quantity, cost: opening.cost }] }).workspace;
  return [next, r.recordId];
}

/** Adds a customer or supplier; returns [workspace, partyId]. */
export function withParty(w: Workspace, type: 'customer' | 'supplier' = 'customer', fields: Record<string, unknown> = {}): [Workspace, string] {
  const r = run(w, 'save_party', { name: `${type} ${++counter}`, type, city: 'Karachi', email: '', taxId: '', registered: false, creditLimit: '0', terms: 30, customerClass: type === 'customer' ? 'Retailer' : 'Importer', ...fields });
  return [r.workspace, r.recordId];
}

/** Creates (and by default submits) a document; returns [workspace, documentId]. */
export function withDocument(w: Workspace, kind: string, partyId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, submit = true, who: Actor = owner): [Workspace, string] {
  const d = today();
  const created = run(w, 'create_document', { kind, partyId, warehouseId: firstWarehouse(w), date: d, dueDate: d, lines: lines.map(l => ({ discount: '0', taxRate: '0', employeeId: '', splits: [], ...l })), ...extra }, who);
  if (!submit) return [created.workspace, created.recordId];
  return [run(created.workspace, 'submit_document', { id: created.recordId }, who).workspace, created.recordId];
}

/** Control reconciliation (mirrors Reports → Control reconciliation) plus trial balance and stock/commission invariants. */
export function invariants(w: Workspace) {
  const receivable = money(sum(w.documents.filter(d => d.kind === 'sales_invoice' && d.status === 'submitted').map(outstanding)));
  const payable = money(sum(w.documents.filter(d => d.kind === 'supplier_invoice' && d.status === 'submitted').map(d => D(outstanding(d)).mul(d.currency === 'PKR' ? 1 : D(d.fxRate)))).plus(landedCostPayable(w)));
  const ct = commissionTotals(w);
  return {
    trialBalanced: w.journals.filter(j => j.status === 'posted').every(j => sum(j.lines.map(l => l.debit)).eq(sum(j.lines.map(l => l.credit)))),
    sourcesUnique: new Set(w.journals.map(j => j.sourceId)).size === w.journals.length,
    receivable: D(receivable).minus(accountBalance(w, '1100')).abs().lt('0.01'),
    payable: D(payable).minus(D(accountBalance(w, '2000')).negated()).abs().lt('0.01'),
    inventory: D(stockValuation(w).total).minus(accountBalance(w, '1200')).abs().lt('0.01'),
    commission: D(ct.earned).minus(ct.paid).minus(D(accountBalance(w, '2200')).negated()).abs().lt('0.01'),
    stockNonNegative: Object.values(w.stockMoves.reduce<Record<string, ReturnType<typeof D>>>((acc, m) => { const k = `${m.itemId}|${m.warehouseId}`; acc[k] = (acc[k] ?? D(0)).plus(m.quantity); return acc; }, {})).every(q => q.gte(0)),
    commissionOrder: w.commissions.every(c => D(c.earned).gte(c.released) && D(c.released).gte(0)),
  };
}

export function expectInvariants(w: Workspace) {
  const r = invariants(w);
  expect(r, 'invariants').toEqual({ trialBalanced: true, sourcesUnique: true, receivable: true, payable: true, inventory: true, commission: true, stockNonNegative: true, commissionOrder: true });
}
