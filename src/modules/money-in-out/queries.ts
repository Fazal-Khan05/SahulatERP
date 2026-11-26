import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { requireCashBank, type JournalLine } from "@/modules/cash-bank/queries";
import type { TenantContext } from "@/modules/tenant/rules";
import { otherSideAllowed, type AccountFacts, type Direction } from "./rules";

// Money in and money out (batch A): the lists, one entry with its journal, and the accounts the
// form offers. Read under row-level security: the owner, an accountant and the auditor who work
// in every branch.

const exact = (value: string | null) => new Decimal(value ?? "0");

export type MoneyInOutRow = { id: string; number: string; date: string; account: string; other: string; party: string; amount: Decimal; status: "posted" | "cancelled" };

/** The newest entries of one direction. */
export async function listMoneyInOut(ctx: TenantContext, direction: Direction): Promise<MoneyInOutRow[]> {
  requireCashBank(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; number: string; date: string; account: string; other: string; party: string; amount: string; status: "posted" | "cancelled" }>(sql`
      select m.id, m.number, m.entry_date::text as date, a.name as account, o.code || ' ' || o.name as other, m.party, m.amount::text, m.status
      from public.money_in_out m
      join public.accounts a on a.tenant_id = m.tenant_id and a.id = m.money_account_id
      join public.accounts o on o.tenant_id = m.tenant_id and o.id = m.other_account_id
      where m.tenant_id = ${ctx.tenantId} and m.direction = ${direction}
      order by m.entry_date desc, m.number desc limit 200`),
  );
  return rows.map((r) => ({ ...r, amount: exact(r.amount) }));
}

export type MoneyInOutDetail = MoneyInOutRow & { direction: Direction; reference: string | null; memo: string | null; cancelReason: string | null; journal: JournalLine[]; reversal: JournalLine[] };

async function linesOf(ctx: TenantContext, journalId: string | null): Promise<JournalLine[]> {
  if (!journalId) return [];
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ account: string; debit: string; credit: string; description: string | null }>(sql`
      select a.code || ' ' || a.name as account, l.debit::text, l.credit::text, l.description
      from public.journal_lines l join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = ${ctx.tenantId} and l.journal_id = ${journalId} order by l.line_no`),
  );
  return rows.map((r) => ({ account: r.account, debit: exact(r.debit), credit: exact(r.credit), description: r.description }));
}

export async function getMoneyInOut(ctx: TenantContext, id: string): Promise<MoneyInOutDetail | null> {
  requireCashBank(ctx);
  if (!isUuid(id)) return null;
  const [row] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; direction: Direction; number: string; date: string; account: string; other: string; party: string; amount: string; status: "posted" | "cancelled"; reference: string | null; memo: string | null; cancel_reason: string | null; journal_id: string; reversal_journal_id: string | null }>(sql`
      select m.id, m.direction, m.number, m.entry_date::text as date, a.name as account, o.code || ' ' || o.name as other, m.party, m.amount::text, m.status,
        m.reference, m.memo, m.cancel_reason, m.journal_id, m.reversal_journal_id
      from public.money_in_out m
      join public.accounts a on a.tenant_id = m.tenant_id and a.id = m.money_account_id
      join public.accounts o on o.tenant_id = m.tenant_id and o.id = m.other_account_id
      where m.tenant_id = ${ctx.tenantId} and m.id = ${id}`),
  );
  if (!row) return null;
  const [journal, reversal] = await Promise.all([linesOf(ctx, row.journal_id), linesOf(ctx, row.reversal_journal_id)]);
  return {
    id: row.id,
    direction: row.direction,
    number: row.number,
    date: row.date,
    account: row.account,
    other: row.other,
    party: row.party,
    amount: exact(row.amount),
    status: row.status,
    reference: row.reference,
    memo: row.memo,
    cancelReason: row.cancel_reason,
    journal,
    reversal,
  };
}

export type OtherAccountChoice = { id: string; code: string; name: string; type: AccountFacts["type"] };

/** The accounts the other side of money in or out may be, by the chart's order. */
export async function listOtherAccounts(ctx: TenantContext, direction: Direction): Promise<OtherAccountChoice[]> {
  requireCashBank(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; code: string; name: string; type: AccountFacts["type"]; is_group: boolean; is_control: boolean; control_type: string | null; archived: boolean }>(sql`
      select a.id, a.code, a.name, a.type, a.is_group, a.is_control, a.control_type, a.archived_at is not null as archived
      from public.accounts a where a.tenant_id = ${ctx.tenantId} and not a.is_group and a.archived_at is null
      order by a.code`),
  );
  return rows
    .filter((r) => otherSideAllowed({ type: r.type, isGroup: r.is_group, isControl: r.is_control, controlType: r.control_type, archived: r.archived }, direction))
    .map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type }));
}
