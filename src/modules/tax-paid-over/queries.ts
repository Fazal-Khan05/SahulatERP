import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { requirePaymentAccess } from "@/modules/supplier-payments/queries";
import type { WithholdingKind } from "@/modules/tax/rules";
import type { TenantContext } from "@/modules/tenant/rules";

// What a challan can pay beside the tax withheld on supplier bills (which
// src/modules/supplier-payments lists): tax withheld on expenses that stand, and the income tax
// approved payroll runs deducted from pay. Read by whoever reads challans.

const d = (value: string | null | undefined) => new Decimal(value ?? "0");

export type ExpenseTaxUnpaid = { entryId: string; kind: WithholdingKind; date: string; supplierName: string; expenseNumber: string; label: string; amount: Decimal };
export type SalaryTaxUnpaid = { runId: string; date: string; month: string; runNumber: string; amount: Decimal };

/**
 * Tax withheld on expenses, and salary tax, that no challan has paid yet: oldest first. Nothing
 * for someone limited to some branches: a challan is recorded by someone who works in every
 * branch, and payroll is the whole company's.
 */
export async function listOtherTaxUnpaid(ctx: TenantContext): Promise<{ expenses: ExpenseTaxUnpaid[]; salaries: SalaryTaxUnpaid[] }> {
  requirePaymentAccess(ctx);
  // Expenses of a branch and payroll are read whole only by someone who works in every branch, as challans are recorded.
  if (ctx.branchIds !== null) return { expenses: [], salaries: [] };
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [expenses, salaries] = await Promise.all([
      tx.execute<{ entry_id: string; kind: WithholdingKind; entry_date: string; supplier_name: string; number: string; label: string; amount: string }>(sql`
        select x.id as entry_id, x.kind, x.entry_date::text, s.name as supplier_name, e.number, w.label, x.amount::text
        from public.expense_withholdings x
        join public.expenses e on e.tenant_id = x.tenant_id and e.id = x.expense_id
        join public.suppliers s on s.tenant_id = x.tenant_id and s.id = x.supplier_id
        join public.withholding_rules w on w.tenant_id = x.tenant_id and w.id = x.rule_id
        where x.tenant_id = ${ctx.tenantId} and e.status = 'posted'
          and not exists (select 1 from public.challan_expense_entries c where c.tenant_id = x.tenant_id and c.entry_id = x.id)
        order by x.entry_date, e.number, x.kind
        limit 1000`),
      tx.execute<{ run_id: string; journal_date: string; month: string; number: string; tax: string }>(sql`
        select r.id as run_id, r.journal_date::text, r.month::text, r.number, r.tax::text
        from public.payroll_runs r
        where r.tenant_id = ${ctx.tenantId} and r.status in ('approved', 'paid') and r.tax > 0
          and not exists (select 1 from public.challan_payroll_runs c where c.tenant_id = r.tenant_id and c.run_id = r.id)
        order by r.journal_date, r.number
        limit 200`),
    ]);
    return {
      expenses: expenses.map((row) => ({ entryId: row.entry_id, kind: row.kind, date: row.entry_date, supplierName: row.supplier_name, expenseNumber: row.number, label: row.label, amount: d(row.amount) })),
      salaries: salaries.map((row) => ({ runId: row.run_id, date: row.journal_date, month: row.month, runNumber: row.number, amount: d(row.tax) })),
    };
  });
}
