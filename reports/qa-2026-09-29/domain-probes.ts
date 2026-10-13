import { writeFileSync } from 'node:fs';
import { buildDemoWorkspace } from '../../src/modules/erp/demo';
import { execute, stock } from '../../src/modules/erp/engine';
import type { Actor } from '../../src/modules/erp/types';

const owner: Actor = { id: 'qa-owner', name: 'QA Owner', role: 'Owner', branchIds: [] };
const base = buildDemoWorkspace();
const source = stock(base, 'i-5', 'khi-port');
const fullTransfer = execute(base, { type: 'stock_transfer', idempotencyKey: 'qa-full-transfer-i5', payload: { itemId: 'i-5', from: 'khi-port', to: 'lhe-main', quantity: source.quantity, date: '2026-10-03' } }, owner);
const transferRemainder = stock(fullTransfer.workspace, 'i-5', 'khi-port');

const future = execute(buildDemoWorkspace(), { type: 'create_document', idempotencyKey: 'qa-future-invoice', payload: { kind: 'sales_invoice', partyId: 'c-1', warehouseId: 'khi-main', date: '2027-01-05', dueDate: '2027-02-05', currency: 'PKR', fxRate: '1', lines: [{ itemId: 'i-1', quantity: '1', price: '2400', discount: '0', taxRate: '18', employeeId: 'e-4', splits: [] }] } }, owner);
const futureInvoice = future.workspace.documents.find(document => document.id === future.recordId);

let negativeStock = '';
try { execute(buildDemoWorkspace(), { type: 'stock_transfer', idempotencyKey: 'qa-negative-stock', payload: { itemId: 'i-1', from: 'khi-main', to: 'lhe-main', quantity: '999999', date: '2026-10-03' } }, owner); }
catch (error) { negativeStock = (error as Error).message; }

let lockedPeriod = '';
const locked = execute(buildDemoWorkspace(), { type: 'set_period', idempotencyKey: 'qa-lock-period', payload: { month: '2026-10', locked: true } }, owner);
try { execute(locked.workspace, { type: 'create_document', idempotencyKey: 'qa-locked-invoice', payload: { kind: 'sales_invoice', partyId: 'c-1', warehouseId: 'khi-main', date: '2026-10-03', dueDate: '2026-10-31', currency: 'PKR', fxRate: '1', lines: [{ itemId: 'i-1', quantity: '1', price: '2400', discount: '0', taxRate: '18', employeeId: 'e-4', splits: [] }] } }, owner); }
catch (error) { lockedPeriod = (error as Error).message; }

let roleRejected = '';
try { execute(buildDemoWorkspace(), { type: 'create_journal', idempotencyKey: 'qa-salesperson-journal', payload: { date: '2026-10-03', memo: 'QA only', lines: [{ account: '1000', debit: '1', credit: '0' }, { account: '3000', debit: '0', credit: '1' }] } }, { ...owner, role: 'Salesperson', employeeId: 'e-3' }); }
catch (error) { roleRejected = (error as Error).message; }

const duplicate = execute(future.workspace, { type: 'create_document', idempotencyKey: 'qa-future-invoice', payload: {} }, owner);
const observations = { transferSource: source, fullTransferRemainder: transferRemainder, futureInvoiceNumber: futureInvoice?.number, futureInvoiceDate: futureInvoice?.date, negativeStock, lockedPeriod, roleRejected, duplicateOperationMessage: duplicate.message, duplicateOperationRevision: duplicate.workspace.revision, originalRevision: future.workspace.revision };
writeFileSync('reports/qa-2026-09-29/evidence/domain-probes.json', JSON.stringify(observations, null, 2));
console.log(JSON.stringify(observations, null, 2));
