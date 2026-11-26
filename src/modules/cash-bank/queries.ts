import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import type { RuleOnDay } from "./rules";

export function requireCashBank(ctx: TenantContext): void {
  if (!can(ctx.role, "cash_bank.read")) throw new UserError("Your role does not include cash and bank.");
}

const exact = (value: string | null) => new Decimal(value ?? "0");

export type CashBankAccount = {
  id: string;
  code: string;
  name: string;
  kind: "cash" | "bank";
  /** What it holds; null for a member limited to some branches, who does not see every posting to it. */
  balance: Decimal | null;
  archived: boolean; bankName: string | null; accountNumber: string | null; updatedAt: string };

/** The company's cash and bank accounts, those in use first, each with what it holds: everything ever posted to it. */
export async function listCashBankAccounts(ctx: TenantContext): Promise<CashBankAccount[]> {
  requireCashBank(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; code: string; name: string; kind: "cash" | "bank"; balance: string; archived: boolean; bank_name: string | null; account_number: string | null; updated_at: string }>(sql`
      select a.id, a.code, a.name, a.control_type as kind, a.archived_at is not null as archived, a.updated_at::text,
        (select coalesce(sum(l.debit - l.credit), 0) from public.journal_lines l where l.tenant_id = a.tenant_id and l.account_id = a.id)::text as balance,
        d.bank_name, d.account_number
      from public.accounts a
      left join public.cash_bank_accounts d on d.tenant_id = a.tenant_id and d.account_id = a.id
      where a.tenant_id = ${ctx.tenantId} and a.control_type in ('cash', 'bank') and not a.is_group
      order by a.archived_at is not null, a.control_type, a.code`),
  );
  const whole = ctx.branchIds === null;
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind, balance: whole ? exact(r.balance) : null, archived: r.archived, bankName: r.bank_name, accountNumber: r.account_number, updatedAt: r.updated_at }));
}

export type TransferRow = { id: string; number: string; date: string; from: string; to: string; amount: Decimal; status: "posted" | "cancelled"; reference: string | null; memo: string | null };

export async function listTransfers(ctx: TenantContext): Promise<TransferRow[]> {
  requireCashBank(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; number: string; date: string; from_name: string; to_name: string; amount: string; status: "posted" | "cancelled"; reference: string | null; memo: string | null }>(sql`
      select t.id, t.number, t.transfer_date::text as date, f.name as from_name, o.name as to_name, t.amount::text, t.status, t.reference, t.memo
      from public.cash_transfers t
      join public.accounts f on f.tenant_id = t.tenant_id and f.id = t.from_account_id
      join public.accounts o on o.tenant_id = t.tenant_id and o.id = t.to_account_id
      where t.tenant_id = ${ctx.tenantId} order by t.transfer_date desc, t.number desc limit 200`),
  );
  return rows.map((r) => ({ id: r.id, number: r.number, date: r.date, from: r.from_name, to: r.to_name, amount: exact(r.amount), status: r.status, reference: r.reference, memo: r.memo }));
}

export type JournalLine = { account: string; debit: Decimal; credit: Decimal; description: string | null };

async function journalLinesOf(ctx: TenantContext, journalId: string | null): Promise<JournalLine[]> {
  if (!journalId) return [];
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ account: string; debit: string; credit: string; description: string | null }>(sql`
      select a.code || ' ' || a.name as account, l.debit::text, l.credit::text, l.description
      from public.journal_lines l join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ${ctx.tenantId} and l.journal_id = ${journalId} order by l.line_no`),
  );
  return rows.map((r) => ({ account: r.account, debit: exact(r.debit), credit: exact(r.credit), description: r.description }));
}

export type TransferDetail = TransferRow & { cancelReason: string | null; journal: JournalLine[]; reversal: JournalLine[] };

export async function getTransfer(ctx: TenantContext, id: string): Promise<TransferDetail | null> {
  requireCashBank(ctx);
  if (!isUuid(id)) return null;
  const [row] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; number: string; date: string; from_name: string; to_name: string; amount: string; status: "posted" | "cancelled"; reference: string | null; memo: string | null; cancel_reason: string | null; journal_id: string; reversal_journal_id: string | null }>(sql`
      select t.id, t.number, t.transfer_date::text as date, f.name as from_name, o.name as to_name, t.amount::text, t.status, t.reference, t.memo, t.cancel_reason, t.journal_id, t.reversal_journal_id
      from public.cash_transfers t
      join public.accounts f on f.tenant_id = t.tenant_id and f.id = t.from_account_id
      join public.accounts o on o.tenant_id = t.tenant_id and o.id = t.to_account_id
      where t.tenant_id = ${ctx.tenantId} and t.id = ${id}`),
  );
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    from: row.from_name,
    to: row.to_name,
    amount: exact(row.amount),
    status: row.status,
    reference: row.reference,
    memo: row.memo,
    cancelReason: row.cancel_reason,
    journal: await journalLinesOf(ctx, row.journal_id),
    reversal: await journalLinesOf(ctx, row.reversal_journal_id),
  };
}

/** `paidTo` is null for an expense that names nobody (a small daily expense). */
export type ExpenseRow = { id: string; number: string; date: string; paidTo: string | null; from: string; total: Decimal; withheld: Decimal; paid: Decimal; status: "posted" | "cancelled" };

export async function listExpenses(ctx: TenantContext): Promise<ExpenseRow[]> {
  requireCashBank(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; number: string; date: string; paid_to: string | null; from_name: string; total: string; withheld: string; paid: string; status: "posted" | "cancelled" }>(sql`
      select e.id, e.number, e.expense_date::text as date, coalesce(s.name, e.payee) as paid_to, a.name as from_name, e.total::text, e.withheld::text, e.paid::text, e.status
      from public.expenses e
      join public.accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
      left join public.suppliers s on s.tenant_id = e.tenant_id and s.id = e.supplier_id
      where e.tenant_id = ${ctx.tenantId} order by e.expense_date desc, e.number desc limit 200`),
  );
  return rows.map((r) => ({ id: r.id, number: r.number, date: r.date, paidTo: r.paid_to, from: r.from_name, total: exact(r.total), withheld: exact(r.withheld), paid: exact(r.paid), status: r.status }));
}

export type ExpenseDetail = ExpenseRow & {
  reference: string | null;
  memo: string | null;
  branch: string | null;
  amount: Decimal;
  provincialTax: Decimal;
  cancelReason: string | null;
  lines: { account: string; description: string; amount: Decimal; provincialShare: Decimal }[];
  withholdings: { kind: string; code: string; legalReference: string; base: Decimal; rate: Decimal; amount: Decimal; onActiveList: boolean }[];
  journal: JournalLine[];
  reversal: JournalLine[];
};

export async function getExpense(ctx: TenantContext, id: string): Promise<ExpenseDetail | null> {
  requireCashBank(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [e] = await tx.execute<{
      id: string; number: string; date: string; paid_to: string | null; from_name: string; total: string; withheld: string; paid: string; status: "posted" | "cancelled";
      reference: string | null; memo: string | null; branch: string | null; amount: string; provincial_tax: string; cancel_reason: string | null; journal_id: string; reversal_journal_id: string | null;
    }>(sql`
      select e.id, e.number, e.expense_date::text as date, coalesce(s.name, e.payee) as paid_to, a.name as from_name, e.total::text, e.withheld::text, e.paid::text, e.status,
        e.reference, e.memo, b.name as branch, e.amount::text, e.provincial_tax::text, e.cancel_reason, e.journal_id, e.reversal_journal_id
      from public.expenses e
      join public.accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
      left join public.suppliers s on s.tenant_id = e.tenant_id and s.id = e.supplier_id
      left join public.branches b on b.tenant_id = e.tenant_id and b.id = e.branch_id
      where e.tenant_id = ${ctx.tenantId} and e.id = ${id}`);
    if (!e) return null;
    const lines = await tx.execute<{ account: string; description: string; amount: string; provincial_share: string }>(sql`
      select a.code || ' ' || a.name as account, l.description, l.amount::text, l.provincial_share::text
      from public.expense_lines l join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ${ctx.tenantId} and l.expense_id = ${id} order by l.line_no`);
    const withholdings = await tx.execute<{ kind: string; code: string; legal_reference: string; base_amount: string; rate: string; amount: string; on_active_list: boolean }>(sql`
      select kind, code, legal_reference, base_amount::text, rate::text, amount::text, on_active_list from public.expense_withholdings
      where tenant_id = ${ctx.tenantId} and expense_id = ${id} order by kind desc`);
    return {
      id: e.id,
      number: e.number,
      date: e.date,
      paidTo: e.paid_to,
      from: e.from_name,
      total: exact(e.total),
      withheld: exact(e.withheld),
      paid: exact(e.paid),
      status: e.status,
      reference: e.reference,
      memo: e.memo,
      branch: e.branch,
      amount: exact(e.amount),
      provincialTax: exact(e.provincial_tax),
      cancelReason: e.cancel_reason,
      lines: lines.map((l) => ({ account: l.account, description: l.description, amount: exact(l.amount), provincialShare: exact(l.provincial_share) })),
      withholdings: withholdings.map((w) => ({ kind: w.kind, code: w.code, legalReference: w.legal_reference, base: exact(w.base_amount), rate: exact(w.rate), amount: exact(w.amount), onActiveList: w.on_active_list })),
      journal: await journalLinesOf(ctx, e.journal_id),
      reversal: await journalLinesOf(ctx, e.reversal_journal_id),
    };
  });
}

export type ExpenseChoices = {
  moneyAccounts: { id: string; label: string }[];
  expenseAccounts: { id: string; label: string }[];
  suppliers: { id: string; label: string; onActiveList: boolean }[];
  branches: { id: string; name: string }[];
  withholds: boolean;
  incomeTaxLines: { code: string; label: string; rule: RuleOnDay }[];
  provincialLines: { code: string; label: string; rate: Decimal }[];
};

/** What the expense form chooses from, on a day: the accounts, the suppliers, and the withholding lines in force. */
export async function getExpenseChoices(ctx: TenantContext, on: string): Promise<ExpenseChoices> {
  requireCashBank(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const money = await tx.execute<{ id: string; label: string }>(sql`
      select id, code || ' ' || name as label from public.accounts
      where tenant_id = ${ctx.tenantId} and control_type in ('cash', 'bank') and not is_group and archived_at is null order by code`);
    const spend = await tx.execute<{ id: string; label: string }>(sql`
      select id, code || ' ' || name as label from public.accounts
      where tenant_id = ${ctx.tenantId} and not is_group and archived_at is null and type in ('expense', 'asset') and (control_type is null or control_type = 'bank_charges')
      order by type desc, code`);
    const suppliers = await tx.execute<{ id: string; label: string; active: boolean }>(sql`
      select id, coalesce(code || ' ', '') || name as label, atl_status = 'active' as active from public.suppliers
      where tenant_id = ${ctx.tenantId} and archived_at is null order by lower(name) limit 1000`);
    const branches = await tx.execute<{ id: string; name: string }>(sql`select id, name from public.branches where tenant_id = ${ctx.tenantId} order by name`);
    const [settings] = await tx.execute<{ withholding_on: boolean }>(sql`select withholding_on from public.purchase_settings where tenant_id = ${ctx.tenantId}`);
    const rules = await tx.execute<{ kind: string; code: string; label: string; rate: string; rate_non_atl: string | null; base: string }>(sql`
      select distinct on (code) kind::text, code, label, rate::text, rate_non_atl::text, base::text from public.withholding_rules
      where tenant_id = ${ctx.tenantId} and kind::text in ('income_tax', 'provincial_sales_tax') and effective_from <= ${on}::date
      order by code, effective_from desc`);
    return {
      moneyAccounts: money.map((r) => ({ id: r.id, label: r.label })),
      expenseAccounts: spend.map((r) => ({ id: r.id, label: r.label })),
      suppliers: suppliers.map((r) => ({ id: r.id, label: r.label, onActiveList: r.active })),
      branches: branches.map((r) => ({ id: r.id, name: r.name })),
      withholds: settings?.withholding_on ?? false,
      incomeTaxLines: rules
        .filter((r) => r.kind === "income_tax" && r.base !== "sales_tax")
        .map((r) => ({ code: r.code, label: r.label, rule: { rate: exact(r.rate), rateNonAtl: r.rate_non_atl === null ? null : exact(r.rate_non_atl), base: r.base as RuleOnDay["base"] } })),
      provincialLines: rules.filter((r) => r.kind === "provincial_sales_tax").map((r) => ({ code: r.code, label: r.label, rate: exact(r.rate) })),
    };
  });
}
