import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { totalsOf, type MovementType, type Totals } from "./rules";

// Read models for commission that has been earned. Row-level security decides whose rows come
// back: the owner, an accountant and the auditor read everyone's, anyone else their own.

export function requireEarnedAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "commission_earned.read")) throw new UserError("Your role does not include what the sales team has earned in commission.");
}

const d = (value: string | null) => new Decimal(value ?? "0");

export type Accrual = {
  id: string;
  invoiceId: string;
  /** Null when the reader may not read the invoice itself (a manager's share of a sale they do not see). */
  invoiceNumber: string | null;
  invoiceDate: string;
  customerName: string | null;
  itemCode: string | null;
  userId: string;
  kind: "own" | "team";
  level: number;
  sellerUserId: string;
  sharePercent: Decimal;
  base: Decimal;
  teamRate: Decimal | null;
  accrued: Decimal;
  earned: Decimal;
  released: Decimal;
  paid: Decimal;
  approved: boolean;
};

type AccrualRow = {
  id: string;
  invoice_id: string;
  invoice_number: string | null;
  invoice_date: string;
  customer_name: string | null;
  item_code: string | null;
  user_id: string;
  kind: "own" | "team";
  level: number;
  seller_user_id: string;
  share_percent: string;
  base: string;
  team_rate: string | null;
  accrued: string;
  earned: string;
  released: string;
  paid: string;
  approved: boolean;
};

export const ACCRUAL_LIST_LIMIT = 500;

/** Accruals the reader may see, newest invoice first; one person's when named, one invoice's when named. */
export async function selectAccruals(tx: Tx, tenantId: string, filter: { userId?: string | null; invoiceId?: string | null } = {}): Promise<Accrual[]> {
  const rows = await tx.execute<AccrualRow>(sql`
    select a.id, a.invoice_id, d.number as invoice_number, a.invoice_date::text, d.buyer_name as customer_name, i.code as item_code,
           a.user_id, a.kind, a.level, a.seller_user_id, a.share_percent::text, a.base::text, a.team_rate::text,
           a.accrued::text, a.earned::text, a.released::text, a.paid::text, a.approved_at is not null as approved
    from commission_accruals a
    left join sales_documents d on d.tenant_id = a.tenant_id and d.id = a.invoice_id
    left join sales_lines l on l.tenant_id = a.tenant_id and l.id = a.line_id
    left join items i on i.tenant_id = l.tenant_id and i.id = l.item_id
    where a.tenant_id = ${tenantId}::uuid
      and (${filter.userId ?? null}::uuid is null or a.user_id = ${filter.userId ?? null}::uuid)
      and (${filter.invoiceId ?? null}::uuid is null or a.invoice_id = ${filter.invoiceId ?? null}::uuid)
    order by a.invoice_date desc, d.number desc nulls last, l.line_no, a.kind, a.level, a.id
    limit ${ACCRUAL_LIST_LIMIT + 1}`);
  return rows.map((row) => ({
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    customerName: row.customer_name,
    itemCode: row.item_code,
    userId: row.user_id,
    kind: row.kind,
    level: row.level,
    sellerUserId: row.seller_user_id,
    sharePercent: d(row.share_percent),
    base: d(row.base),
    teamRate: row.team_rate === null ? null : d(row.team_rate),
    accrued: d(row.accrued),
    earned: d(row.earned),
    released: d(row.released),
    paid: d(row.paid),
    approved: row.approved,
  }));
}

export type Person = { userId: string; name: string };

/** The names of the active sales team. Everyone who reads commission may ask for them. */
async function selectPeople(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx.execute<{ user_id: string; email: string }>(sql`select user_id, email from app.sales_people()`);
  return new Map(rows.map((row) => [row.user_id, row.email]));
}

export type PersonTotals = Person & { totals: Totals; accruals: number };

export type EarnedOverview = { people: PersonTotals[]; accruals: Accrual[]; more: boolean; names: Record<string, string> };

/**
 * What the sales team has earned: each person's totals and the accruals behind them. The
 * owner, an accountant and the auditor see everyone; anyone else what is theirs. `userId`
 * narrows the accruals to one person.
 */
export async function getEarned(ctx: TenantContext, userId: string | null = null): Promise<EarnedOverview> {
  if (!can(ctx.role, "commission_earned.read") && !can(ctx.role, "commission_earned.own")) throw new UserError("Your role does not include commission.");
  const only = userId !== null && isUuid(userId) ? userId : null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [known, sums, accruals] = await Promise.all([
      selectPeople(tx),
      tx.execute<{ user_id: string; accruals: number; earned: string; released: string; paid: string; waiting: string; payable: string; approved: string; owed_back: string }>(sql`
        select a.user_id, count(*)::int as accruals, sum(a.earned)::text as earned, sum(a.released)::text as released, sum(a.paid)::text as paid,
               sum(greatest(a.earned - a.released, 0))::text as waiting, sum(greatest(a.released - a.paid, 0))::text as payable,
               sum(case when a.approved_at is not null then greatest(a.released - a.paid, 0) else 0 end)::text as approved,
               sum(greatest(a.paid - a.released, 0))::text as owed_back
        from commission_accruals a where a.tenant_id = ${ctx.tenantId}::uuid group by a.user_id`),
      selectAccruals(tx, ctx.tenantId, { userId: only }),
    ]);
    const nameOf = (id: string) => known.get(id) ?? (id === ctx.userId ? ctx.email : "A former member");
    const people = sums
      .map((row) => ({
        userId: row.user_id,
        name: nameOf(row.user_id),
        accruals: row.accruals,
        totals: { earned: d(row.earned), released: d(row.released), paid: d(row.paid), waiting: d(row.waiting), payable: d(row.payable), approved: d(row.approved), owedBack: d(row.owed_back) },
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const names: Record<string, string> = {};
    for (const row of accruals) {
      names[row.userId] = nameOf(row.userId);
      names[row.sellerUserId] = nameOf(row.sellerUserId);
    }
    return { people, accruals: accruals.slice(0, ACCRUAL_LIST_LIMIT), more: accruals.length > ACCRUAL_LIST_LIMIT, names };
  });
}

/** The commission on one invoice, for its own page: who earned what on it, and where each stands. */
export async function getInvoiceCommission(ctx: TenantContext, invoiceId: string): Promise<{ accruals: Accrual[]; totals: Totals; names: Record<string, string> } | null> {
  if (!can(ctx.role, "commission_earned.read") || !isUuid(invoiceId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const accruals = await selectAccruals(tx, ctx.tenantId, { invoiceId });
    if (accruals.length === 0) return null;
    const known = await selectPeople(tx);
    const names: Record<string, string> = {};
    for (const row of accruals) {
      names[row.userId] = known.get(row.userId) ?? "A former member";
      names[row.sellerUserId] = known.get(row.sellerUserId) ?? "A former member";
    }
    return { accruals, totals: totalsOf(accruals), names };
  });
}

export type Movement = { id: string; accrualId: string; type: MovementType; amount: Decimal; date: string; sourceType: string; sourceId: string };

/** Everything that has happened to the accruals named, oldest first. */
export async function listMovements(ctx: TenantContext, accrualIds: readonly string[]): Promise<Movement[]> {
  const ids = accrualIds.filter(isUuid);
  if (ids.length === 0) return [];
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string; accrual_id: string; type: MovementType; amount: string; movement_date: string; source_type: string; source_id: string }>(sql`
      select m.id, m.accrual_id, m.type, m.amount::text, m.movement_date::text, m.source_type, m.source_id
      from commission_movements m
      where m.tenant_id = ${ctx.tenantId}::uuid and m.accrual_id in (select x::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) as x)
      order by m.seq`);
    return rows.map((row) => ({ id: row.id, accrualId: row.accrual_id, type: row.type, amount: d(row.amount), date: row.movement_date, sourceType: row.source_type, sourceId: row.source_id }));
  });
}

export type Payment = { id: string; number: string; userId: string; name: string; date: string; accountName: string | null; gross: Decimal; recovered: Decimal; amount: Decimal; note: string | null };

/** Commission payments the reader may see, newest first. */
export async function listPayments(ctx: TenantContext): Promise<Payment[]> {
  if (!can(ctx.role, "commission_earned.read") && !can(ctx.role, "commission_earned.own")) throw new UserError("Your role does not include commission.");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string; number: string; user_id: string; payment_date: string; account_name: string | null; gross: string; recovered: string; amount: string; note: string | null }>(sql`
      select p.id, p.number, p.user_id, p.payment_date::text, a.name as account_name, p.gross::text, p.recovered::text, p.amount::text, p.note
      from commission_payments p
      left join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id
      where p.tenant_id = ${ctx.tenantId}::uuid
      order by p.payment_date desc, p.number desc
      limit 200`);
    const known = await selectPeople(tx);
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      userId: row.user_id,
      name: known.get(row.user_id) ?? (row.user_id === ctx.userId ? ctx.email : "A former member"),
      date: row.payment_date,
      accountName: row.account_name,
      gross: d(row.gross),
      recovered: d(row.recovered),
      amount: d(row.amount),
      note: row.note,
    }));
  });
}
