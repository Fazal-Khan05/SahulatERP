import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { requireCashBank } from "@/modules/cash-bank/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import type { NamedAccount } from "./rules";

// What the daily expenses screens read. Whoever reads cash and bank reads these (the owner, an
// accountant, the auditor); a member limited to some branches sees the expenses of those.

const exact = (value: string | null) => new Decimal(value ?? "0");

export type DailyChoices = {
  /** The company's expense accounts that take postings, by name. */
  expenseAccounts: NamedAccount[];
  /** Its cash and bank accounts in use. */
  moneyAccounts: (NamedAccount & { kind: "cash" | "bank" })[];
  branches: { id: string; name: string }[];
  /** The account this person's last expense was paid from, when it is still in use. */
  lastPaidFromId: string | null;
};

/** What the quick form and a sheet choose from. */
export async function getDailyChoices(ctx: TenantContext): Promise<DailyChoices> {
  requireCashBank(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const spend = await tx.execute<{ id: string; code: string; name: string }>(sql`
      select id, code, name from public.accounts
      where tenant_id = ${ctx.tenantId} and not is_group and archived_at is null and type = 'expense' and (control_type is null or control_type = 'bank_charges')
      order by lower(name), code`);
    const money = await tx.execute<{ id: string; code: string; name: string; kind: "cash" | "bank" }>(sql`
      select id, code, name, control_type as kind from public.accounts
      where tenant_id = ${ctx.tenantId} and control_type in ('cash', 'bank') and not is_group and archived_at is null
      order by control_type desc, code`);
    const branches = await tx.execute<{ id: string; name: string }>(sql`select id, name from public.branches where tenant_id = ${ctx.tenantId} order by name`);
    const [last] = await tx.execute<{ account_id: string }>(sql`
      select account_id from public.expenses where tenant_id = ${ctx.tenantId} and created_by = ${ctx.userId} order by created_at desc limit 1`);
    return {
      expenseAccounts: spend.map((r) => ({ id: r.id, code: r.code, name: r.name })),
      moneyAccounts: money.map((r) => ({ id: r.id, code: r.code, name: r.name, kind: r.kind })),
      branches: branches.map((r) => ({ id: r.id, name: r.name })),
      lastPaidFromId: last && money.some((m) => m.id === last.account_id) ? last.account_id : null,
    };
  });
}

export type DailyRow = {
  id: string;
  number: string;
  date: string;
  status: "posted" | "cancelled";
  /** The account the first line is charged to, and how many more lines there are. */
  whatFor: string;
  moreLines: number;
  /** What the first line says it was for. */
  description: string;
  paidTo: string | null;
  from: string;
  total: Decimal;
  withheld: Decimal;
  receipts: number;
};

/** The most rows the list shows; a range that holds more says so, and shows whole days only. */
export const MAX_DAILY_ROWS = 500;

/** The expenses of the days asked for, the newest day first and the newest entry first within it. */
export async function listDailyExpenses(ctx: TenantContext, from: string, to: string): Promise<{ rows: DailyRow[]; more: boolean }> {
  requireCashBank(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{
      id: string; number: string; date: string; status: "posted" | "cancelled"; what_for: string; lines: number; description: string;
      paid_to: string | null; from_name: string; total: string; withheld: string; receipts: number;
    }>(sql`
      select e.id, e.number, e.expense_date::text as date, e.status, w.name as what_for, n.lines, l.description,
        coalesce(s.name, e.payee) as paid_to, a.name as from_name, e.total::text, e.withheld::text,
        (select count(*)::int from public.expense_receipts r where r.tenant_id = e.tenant_id and r.expense_id = e.id) as receipts
      from public.expenses e
      join public.accounts a on a.tenant_id = e.tenant_id and a.id = e.account_id
      join public.expense_lines l on l.tenant_id = e.tenant_id and l.expense_id = e.id and l.line_no = 1
      join public.accounts w on w.tenant_id = l.tenant_id and w.id = l.account_id
      cross join lateral (select count(*)::int as lines from public.expense_lines x where x.tenant_id = e.tenant_id and x.expense_id = e.id) n
      left join public.suppliers s on s.tenant_id = e.tenant_id and s.id = e.supplier_id
      where e.tenant_id = ${ctx.tenantId} and e.expense_date between ${from}::date and ${to}::date
      order by e.expense_date desc, e.number desc limit ${MAX_DAILY_ROWS + 1}`),
  );
  const more = rows.length > MAX_DAILY_ROWS;
  let shown = rows.slice(0, MAX_DAILY_ROWS);
  // A day cut short by the limit would show a total that is not the day's: it is left out, unless it is the only day.
  if (more) {
    const cut = shown.at(-1)!.date;
    if (shown[0].date !== cut) shown = shown.filter((r) => r.date !== cut);
  }
  return {
    more,
    rows: shown.map((r) => ({
      id: r.id,
      number: r.number,
      date: r.date,
      status: r.status,
      whatFor: r.what_for,
      moreLines: r.lines - 1,
      description: r.description,
      paidTo: r.paid_to,
      from: r.from_name,
      total: exact(r.total),
      withheld: exact(r.withheld),
      receipts: r.receipts,
    })),
  };
}

export type Receipt = { id: string; name: string; contentType: string; sizeBytes: number; addedAt: Date; addedBy: string | null };

/** The receipts kept with an expense, the first added first. Nothing for an expense this person may not see. */
export async function listReceipts(ctx: TenantContext, expenseId: string): Promise<Receipt[]> {
  requireCashBank(ctx);
  if (!isUuid(expenseId)) return [];
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; name: string; content_type: string; size_bytes: number; created_at: Date; added_by: string | null }>(sql`
      select r.id, f.name, f.content_type, f.size_bytes, r.created_at, m.email as added_by
      from public.expense_receipts r
      join public.files f on f.tenant_id = r.tenant_id and f.id = r.file_id and f.status = 'stored'
      left join public.memberships m on m.tenant_id = r.tenant_id and m.user_id = r.created_by
      where r.tenant_id = ${ctx.tenantId} and r.expense_id = ${expenseId}
      order by r.created_at, r.id`),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, contentType: r.content_type, sizeBytes: r.size_bytes, addedAt: new Date(r.created_at), addedBy: r.added_by }));
}

/** Where a receipt's bytes are, for whoever may see its expense; null otherwise. */
export async function getReceiptFile(ctx: TenantContext, receiptId: string): Promise<{ storageKey: string; name: string } | null> {
  requireCashBank(ctx);
  if (!isUuid(receiptId)) return null;
  const [row] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ storage_key: string; name: string }>(sql`
      select f.storage_key, f.name
      from public.expense_receipts r
      join public.files f on f.tenant_id = r.tenant_id and f.id = r.file_id and f.status = 'stored'
      where r.tenant_id = ${ctx.tenantId} and r.id = ${receiptId}`),
  );
  return row ? { storageKey: row.storage_key, name: row.name } : null;
}
