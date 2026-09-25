import { loadEnvConfig } from '@next/env';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { buildDemoWorkspace } from '../src/modules/erp/demo';
import { blankWorkspace } from '../src/modules/erp/seed';
import type { Workspace } from '../src/modules/erp/types';

loadEnvConfig(process.cwd());

const json = (value: unknown) => JSON.stringify(value);

async function insertProjection(tx: postgres.TransactionSql, workspace: Workspace) {
  const tenant = workspace.tenantId;
  await tx`insert into public.companies ${tx([{ tenant_id: tenant, name: workspace.company.name, tax_id: workspace.company.taxId, address: workspace.company.address, base_currency: workspace.company.currency, settings: json(workspace.settings) }])}`;
  if (workspace.branches.length) await tx`insert into public.branches ${tx(workspace.branches.map(branch => ({ tenant_id: tenant, ...branch })), 'tenant_id', 'id', 'name')}`;
  if (workspace.warehouses.length) await tx`insert into public.warehouses ${tx(workspace.warehouses.map(warehouse => ({ tenant_id: tenant, id: warehouse.id, branch_id: warehouse.branchId, name: warehouse.name })))}`;
  if (workspace.periods.length) await tx`insert into public.fiscal_periods ${tx(workspace.periods.map(period => ({ tenant_id: tenant, month: period.month, locked: period.locked })))}`;
  await tx`insert into public.workspace_snapshots (tenant_id,revision,schema_version,data) values (${tenant},${workspace.revision},${workspace.schemaVersion},${tx.json(workspace)})`;
  if (workspace.parties.length) await tx`insert into public.parties ${tx(workspace.parties.map(party => ({ tenant_id: tenant, id: party.id, party_type: party.type, name: party.name, tax_id: party.taxId, credit_limit: party.creditLimit, data: json(party) })))}`;
  if (workspace.items.length) await tx`insert into public.items ${tx(workspace.items.map(item => ({ tenant_id: tenant, id: item.id, sku: item.sku, name: item.name, category: item.category, data: json(item) })))}`;
  if (workspace.employees.length) await tx`insert into public.employees ${tx(workspace.employees.map(employee => ({ tenant_id: tenant, id: employee.id, name: employee.name, role_name: employee.role, active: employee.active, data: json(employee) })))}`;
  if (workspace.documents.length) await tx`insert into public.documents ${tx(workspace.documents.map(document => ({ tenant_id: tenant, id: document.id, number: document.number, kind: document.kind, status: document.status, party_id: document.partyId, warehouse_id: document.warehouseId, document_date: document.date, currency: document.currency, total: document.total, paid: document.paid, returned: document.returned, data: json(document) })))}`;
  if (workspace.journals.length) await tx`insert into public.journals ${tx(workspace.journals.map(journal => ({ tenant_id: tenant, id: journal.id, number: journal.number, source_id: journal.sourceId, journal_date: journal.date, memo: journal.memo, status: journal.status, reversal_of: journal.reversalOf ?? null, data: json(journal) })))}`;
  const journalLines = workspace.journals.flatMap(journal => journal.lines.map((line, index) => ({ tenant_id: tenant, journal_id: journal.id, line_no: index + 1, account_code: line.account, debit: line.debit, credit: line.credit })));
  if (journalLines.length) await tx`insert into public.journal_lines ${tx(journalLines)}`;
  if (workspace.stockMoves.length) await tx`insert into public.stock_movements ${tx(workspace.stockMoves.map(move => ({ tenant_id: tenant, id: move.id, item_id: move.itemId, warehouse_id: move.warehouseId, movement_date: move.date, quantity: move.quantity, value: move.value, source_id: move.sourceId, movement_type: move.type })))}`;
  if (workspace.receipts.length) await tx`insert into public.receipts ${tx(workspace.receipts.map(receipt => ({ tenant_id: tenant, id: receipt.id, number: receipt.number, party_id: receipt.partyId, receipt_date: receipt.date, amount: receipt.amount, method: receipt.method, status: receipt.status, data: json(receipt) })))}`;
  if (workspace.plans.length) await tx`insert into public.commission_plans ${tx(workspace.plans.map(plan => ({ tenant_id: tenant, id: plan.id, name: plan.name, effective_from: plan.effectiveFrom, effective_to: plan.effectiveTo, data: json(plan) })))}`;
  if (workspace.commissions.length) await tx`insert into public.commissions ${tx(workspace.commissions.map(commission => ({ tenant_id: tenant, id: commission.id, invoice_id: commission.invoiceId, employee_id: commission.employeeId, earned: commission.earned, released: commission.released, paid: commission.paid, approved: commission.approved, data: json(commission) })))}`;
  if (workspace.commissionMovements.length) await tx`insert into public.commission_movements ${tx(workspace.commissionMovements.map(move => ({ tenant_id: tenant, id: move.id, commission_id: move.commissionId, source_id: move.sourceId, movement_date: move.date, movement_type: move.type, amount: move.amount, data: json(move) })))}`;
  if (workspace.shipments.length) await tx`insert into public.shipments ${tx(workspace.shipments.map(shipment => ({ tenant_id: tenant, id: shipment.id, number: shipment.number, status: shipment.status, supplier_id: shipment.supplierId, eta: shipment.eta, data: json(shipment) })))}`;
  if (workspace.payrolls.length) await tx`insert into public.payroll_runs ${tx(workspace.payrolls.map(payroll => ({ tenant_id: tenant, id: payroll.id, number: payroll.number, payroll_month: payroll.month, status: payroll.status, total: payroll.total, data: json(payroll) })))}`;
  if (workspace.fbr.length) await tx`insert into public.fbr_simulations ${tx(workspace.fbr.map(fbr => ({ tenant_id: tenant, id: fbr.id, invoice_id: fbr.invoiceId, status: fbr.status, attempts: fbr.attempts, reference: fbr.reference, data: json(fbr) })))}`;
  if (workspace.bankLines.length) await tx`insert into public.bank_statement_lines ${tx(workspace.bankLines.map(line => ({ tenant_id: tenant, id: line.id, statement_date: line.date, description: line.description, amount: line.amount, matched_journal_id: line.matchedJournalId, data: json(line) })))}`;
  if (workspace.audit.length) await tx`insert into public.audit_events ${tx(workspace.audit.map(event => ({ tenant_id: tenant, id: event.id, occurred_at: event.date, actor: event.actor, role_name: event.role, action: event.action, source_id: event.sourceId, detail: event.detail })))}`;
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  let ownerId = process.env.BOOTSTRAP_OWNER_ID;
  if (!ownerId && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.BOOTSTRAP_OWNER_EMAIL) {
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw error;
    ownerId = data.users.find(user => user.email?.toLowerCase() === process.env.BOOTSTRAP_OWNER_EMAIL?.toLowerCase())?.id;
  }
  if (!url || !ownerId) throw new Error('Database URL and a bootstrapped owner account are required.');
  const demo = buildDemoWorkspace();
  const partner = blankWorkspace(false);
  const sql = postgres(url, { ssl: 'require', prepare: false, max: 1, connect_timeout: 20 });
  try {
    await sql.begin(async tx => {
      await tx`select set_config('app.demo_reset', 'on', true)`;
      await tx`delete from public.tenants where id=${demo.tenantId}`;
      await tx`insert into public.tenants (id,name,is_demo) values (${demo.tenantId},${demo.company.name},true)`;
      await tx`insert into public.memberships (tenant_id,user_id,role,branch_ids) values (${demo.tenantId},${ownerId},'Owner','{}')`;
      await insertProjection(tx, demo);

      await tx`insert into public.tenants (id,name,is_demo) values (${partner.tenantId},${partner.company.name},false) on conflict (id) do nothing`;
      await tx`insert into public.memberships (tenant_id,user_id,role,branch_ids) values (${partner.tenantId},${ownerId},'Owner','{}') on conflict (tenant_id,user_id) do update set role='Owner', active=true`;
      const [partnerExists] = await tx`select exists(select 1 from public.workspace_snapshots where tenant_id=${partner.tenantId}) as present`;
      if (!partnerExists.present) await insertProjection(tx, partner);
    });
    console.log(JSON.stringify({ seeded: true, demoRevision: demo.revision, documents: demo.documents.length, journals: demo.journals.length, partnerPreserved: true }));
  } finally { await sql.end({ timeout: 3 }); }
}

main().catch(error => {
  console.error(JSON.stringify({ seeded: false, code: error.code || 'SEED_FAILED', message: error.message }));
  process.exitCode = 1;
});
