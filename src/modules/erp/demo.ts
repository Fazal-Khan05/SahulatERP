import { execute } from './engine';
import { D, money, sum } from './money';
import { seedMasters } from './seed';
import type { Actor, Workspace } from './types';

const owner: Actor = { id: 'demo-owner', name: 'Demo Owner', role: 'Owner', branchIds: [] };

export function buildDemoWorkspace(): Workspace {
  let workspace = seedMasters();
  let sequence = 0;
  const run = (type: Parameters<typeof execute>[1] extends infer _ ? string : never, payload: Record<string, unknown>) => {
    const result = execute(workspace, { type, payload, idempotencyKey: `demo-seed-${String(++sequence).padStart(4, '0')}` }, owner);
    workspace = result.workspace;
    return result.recordId;
  };

  const openingStock = [
    ['i-1', 'khi-main', '500', '1450'], ['i-2', 'khi-main', '300', '1900'],
    ['i-3', 'lhe-main', '220', '2750'], ['i-4', 'lhe-main', '150', '4200'],
    ['i-5', 'khi-main', '400', '2100'], ['i-6', 'khi-main', '600', '950'],
  ];
  const inventory = sum(openingStock.map(([, , quantity, cost]) => D(quantity).mul(cost)));
  for (const [itemId, warehouseId, quantity, cost] of openingStock) {
    workspace.stockMoves.push({
      id: crypto.randomUUID(), itemId, warehouseId, date: '2026-09-01', quantity: money(quantity),
      value: money(D(quantity).mul(cost)), sourceId: 'opening-stock', type: 'opening',
    });
  }
  workspace.journals.push({
    id: crypto.randomUUID(), number: 'JV-00001', sourceId: 'opening-balances', date: '2026-09-01',
    memo: 'Opening balances · synthetic demo company', status: 'posted',
    lines: [
      { account: '1000', debit: '3000000.0000', credit: '0.0000' },
      { account: '1200', debit: money(inventory), credit: '0.0000' },
      { account: '3000', debit: '0.0000', credit: money(inventory.plus(3000000)) },
    ],
  });

  const invoice = (partyId: string, warehouseId: string, date: string, lines: Record<string, unknown>[]) => {
    const id = run('create_document', { kind: 'sales_invoice', partyId, warehouseId, date, dueDate: '2026-10-31', currency: 'PKR', fxRate: '1', lines, notes: 'Synthetic demo sale' });
    run('submit_document', { id });
    return id;
  };
  const salesLine = (itemId: string, quantity: string, price: string, employeeId: string, taxRate = '18') => ({ itemId, quantity, price, discount: '0', taxRate, employeeId, splits: [] });

  const inv1 = invoice('c-1', 'khi-main', '2026-09-08', [salesLine('i-1', '100', '2400', 'e-4'), salesLine('i-2', '50', '3200', 'e-4')]);
  const inv2 = invoice('c-2', 'lhe-main', '2026-09-10', [salesLine('i-3', '60', '4500', 'e-3')]);
  const inv3 = invoice('c-3', 'khi-main', '2026-09-12', [salesLine('i-5', '40', '3800', 'e-2')]);
  const inv4 = invoice('c-4', 'khi-main', '2026-09-14', [salesLine('i-6', '30', '1850', 'e-4')]);

  run('create_receipt', { partyId: 'c-1', date: '2026-09-18', amount: '188800', method: 'bank', dueDate: '2026-09-18', allocations: [{ invoiceId: inv1, amount: '188800' }], employeeId: 'e-4', note: '40% collection' });
  run('create_receipt', { partyId: 'c-2', date: '2026-09-20', amount: '318600', method: 'bank', dueDate: '2026-09-20', allocations: [{ invoiceId: inv2, amount: '318600' }], employeeId: 'e-3', note: 'Full collection' });
  run('create_receipt', { partyId: 'c-3', date: '2026-09-22', amount: '179360', method: 'cheque', chequeNo: 'PDC-1048', dueDate: '2026-10-03', allocations: [{ invoiceId: inv3, amount: '179360' }], employeeId: 'e-2', note: 'Post-dated cheque' });
  const bounced = run('create_receipt', { partyId: 'c-4', date: '2026-09-20', amount: '65490', method: 'cheque', chequeNo: 'PDC-0982', dueDate: '2026-09-21', allocations: [{ invoiceId: inv4, amount: '65490' }], employeeId: 'e-4', note: 'Synthetic bounce scenario' });
  run('update_cheque', { id: bounced, status: 'deposited', date: '2026-09-21' });
  run('update_cheque', { id: bounced, status: 'cleared', date: '2026-09-22' });
  run('update_cheque', { id: bounced, status: 'bounced', date: '2026-09-24' });


  const released = workspace.commissions.filter(commission => D(commission.released).gt(commission.paid)).map(commission => commission.id);
  run('approve_commission', { ids: released });
  const septemberPayroll = run('create_payroll', { month: '2026-09', date: '2026-09-28' });
  run('update_payroll', { id: septemberPayroll, status: 'reviewed' });
  run('update_payroll', { id: septemberPayroll, status: 'approved' });
  run('update_payroll', { id: septemberPayroll, status: 'paid' });

  const returnedLine = workspace.documents.find(document => document.id === inv2)!.lines[0];
  run('return_document', { id: inv2, date: '2026-10-02', reason: 'Customer returned damaged cartons', lines: [{ lineId: returnedLine.id, quantity: '10' }] });
  run('create_payroll', { month: '2026-10', date: '2026-10-28' });

  const po = run('create_document', { kind: 'purchase_order', partyId: 's-1', warehouseId: 'khi-port', date: '2026-09-03', dueDate: '2026-11-01', currency: 'USD', fxRate: '280', lines: [salesLine('i-5', '200', '18', '', '0'), salesLine('i-6', '300', '5', '', '0')], notes: 'USD import order' });
  run('submit_document', { id: po });
  const grn = run('convert_document', { id: po, date: '2026-09-16' });
  run('submit_document', { id: grn });
  const bill = run('convert_document', { id: grn, date: '2026-09-17' });
  run('submit_document', { id: bill });
  const shipment = run('create_shipment', { documentId: grn, origin: 'Shenzhen', port: 'Karachi', container: 'TCLU-448201-7', gdNumber: 'KAPE-HC-29184', eta: '2026-09-15' });
  run('add_shipment_cost', { id: shipment, label: 'Ocean freight', amount: '200000', classification: 'inventory', basis: 'weight' });
  run('add_shipment_cost', { id: shipment, label: 'Customs duty', amount: '150000', classification: 'inventory', basis: 'value' });
  run('add_shipment_cost', { id: shipment, label: 'Import sales tax', amount: '80000', classification: 'recoverable_tax', basis: 'value' });
  run('add_shipment_cost', { id: shipment, label: 'Clearing agent', amount: '50000', classification: 'expense', basis: 'quantity' });
  run('allocate_shipment', { id: shipment, date: '2026-09-19' });
  run('add_shipment_cost', { id: shipment, label: 'Late port demurrage', amount: '75000', classification: 'inventory', basis: 'volume' });

  run('bank_import', { lines: [
    { date: '2026-09-18', description: 'IBFT AL-NOOR ELECTRONICS', amount: '188800' },
    { date: '2026-09-20', description: 'ONLINE METRO HOME STORES', amount: '318600' },
    { date: '2026-09-29', description: 'BANK SERVICE CHARGE', amount: '-3200' },
  ] });
  const firstBank = workspace.bankLines[0];
  const firstReceiptJournal = workspace.journals.find(journal => journal.memo.includes('REC-0001'));
  if (firstBank && firstReceiptJournal) run('bank_match', { id: firstBank.id, journalId: firstReceiptJournal.id });
  run('follow_up', { partyId: 'c-1', note: 'Confirm remaining balance payment plan', nextDate: '2026-10-05' });

  return workspace;
}
