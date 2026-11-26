import "server-only";
import Decimal from "decimal.js";
import { sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import type { ReportTable } from "@/modules/reports/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { SALES_REPORTS, SALES_REPORT_PERMISSION, monthLabel, salesBreakdownTable, salesRegisterTable, type RegisterRow, type SalesFilter, type SalesGroup, type SalesReportKey, type SalesRow } from "./rules";

// The sales analysis, read from posted invoices and credit notes, through the signed-in
// member's own access: row-level security decides which documents the reader sees, and a member
// limited to some branches sees those branches' only. What goods cost is read only for those who
// may see it (stock.cost.read), and the books' Sales account only for those who read the books.

const d = (value: string | null | undefined) => new Decimal(value ?? "0");

/** Refuses a member who may not read the sales analysis. */
export function requireSalesReport(ctx: TenantContext): void {
  if (!can(ctx.role, SALES_REPORT_PERMISSION)) throw new UserError("Only an owner, an accountant, an auditor or the sales manager can see the sales reports.");
}

/** Every line of a posted invoice or credit note of the period, signed: a credit note takes back. */
function linesOf(ctx: TenantContext, filter: SalesFilter): SQL {
  return sql`
    lines as (
      select s.id as doc_id, s.kind, s.document_date, s.customer_id, s.salesperson_id as doc_person, l.id as line_id, l.source_line_id, l.item_id,
             case when s.kind = 'credit_note' then -1 else 1 end as sign,
             (case when s.kind = 'credit_note' then -1 else 1 end) * l.base_quantity as quantity,
             (case when s.kind = 'credit_note' then -1 else 1 end) * l.value * s.exchange_rate as amount
      from public.sales_documents s
      join public.sales_lines l on l.tenant_id = s.tenant_id and l.document_id = s.id
      where s.tenant_id = ${ctx.tenantId} and s.kind in ('invoice', 'credit_note') and s.status = 'submitted'
        and s.document_date between ${filter.from}::date and ${filter.to}::date
        and (${filter.branchId}::uuid is null or s.branch_id = ${filter.branchId}::uuid)
    )`;
}

/**
 * What each line's goods cost, signed like the line: what an invoice's goods left stock at (its
 * own, or its delivery note's), less what a credit note's goods that came back onto the shelf
 * cost; goods written off as damaged stay a cost. The same reading as Item profit.
 */
function costsOf(ctx: TenantContext): SQL {
  return sql`
    left_at as (
      select m.source_type, m.source_line_id, -sum(m.value) as cost
      from public.stock_moves m
      where m.tenant_id = ${ctx.tenantId} and m.source_type in ('sales_invoice', 'delivery_note') and m.source_line_id in (
        select x.line_id from lines x where x.kind = 'invoice' union select x.source_line_id from lines x where x.kind = 'invoice' and x.source_line_id is not null)
      group by m.source_type, m.source_line_id
    ),
    costs as (
      select x.line_id, case when x.kind = 'invoice' then coalesce(own.cost, 0) + coalesce(noted.cost, 0) else -coalesce(cc.cost - cc.written_off, 0) end as cost
      from lines x
      left join left_at own on x.kind = 'invoice' and own.source_type = 'sales_invoice' and own.source_line_id = x.line_id
      left join left_at noted on x.kind = 'invoice' and noted.source_type = 'delivery_note' and noted.source_line_id = x.source_line_id
      left join public.credit_note_line_costs cc on x.kind = 'credit_note' and cc.tenant_id = ${ctx.tenantId} and cc.line_id = x.line_id
    )`;
}

type Grouped = { label: string; detail: string | null; unit: string | null; quantity: string | null; amount: string; cost: string | null };

/** The sales of the period added up by customer, item, salesperson, city or month. */
async function grouped(tx: Tx, ctx: TenantContext, filter: SalesFilter, group: SalesGroup, withCost: boolean): Promise<SalesRow[]> {
  const costs = withCost ? sql`, ${costsOf(ctx)}` : sql``;
  const cost = (share: SQL) => (withCost ? sql`round(sum(c.cost * ${share}), 4)::text` : sql`null::text`);
  const costJoin = withCost ? sql`left join costs c on c.line_id = x.line_id` : sql``;
  let rows: Grouped[];
  switch (group) {
    case "customer":
      rows = [...(await tx.execute<Grouped>(sql`
        with ${linesOf(ctx, filter)}${costs}
        select max(cu.name) || coalesce(' (' || max(cu.code) || ')', '') as label, null::text as detail, null::text as unit, null::text as quantity, round(sum(x.amount), 4)::text as amount, ${cost(sql`1`)} as cost
        from lines x ${costJoin}
        join public.customers cu on cu.tenant_id = ${ctx.tenantId} and cu.id = x.customer_id
        group by x.customer_id`))];
      break;
    case "item":
      rows = [...(await tx.execute<Grouped>(sql`
        with ${linesOf(ctx, filter)}${costs}
        select max(i.code) as label, max(i.name) as detail, max(u.code) as unit, sum(x.quantity)::text as quantity, round(sum(x.amount), 4)::text as amount, ${cost(sql`1`)} as cost
        from lines x ${costJoin}
        join public.items i on i.tenant_id = ${ctx.tenantId} and i.id = x.item_id
        join public.units u on u.tenant_id = i.tenant_id and u.id = i.base_unit_id
        group by x.item_id`))];
      break;
    case "city":
      rows = [...(await tx.execute<Grouped>(sql`
        with ${linesOf(ctx, filter)}${costs}
        select coalesce(city.city, 'No city recorded') as label, null::text as detail, null::text as unit, null::text as quantity, round(sum(x.amount), 4)::text as amount, ${cost(sql`1`)} as cost
        from lines x ${costJoin}
        left join lateral (
          select nullif(btrim(a.city), '') as city from public.party_addresses a
          where a.tenant_id = ${ctx.tenantId} and a.customer_id = x.customer_id order by a.is_primary desc, a.created_at limit 1) city on true
        group by coalesce(city.city, 'No city recorded')`))];
      break;
    case "month":
      rows = [...(await tx.execute<Grouped>(sql`
        with ${linesOf(ctx, filter)}${costs}
        select to_char(x.document_date, 'YYYY-MM') as label, null::text as detail, null::text as unit, null::text as quantity, round(sum(x.amount), 4)::text as amount, ${cost(sql`1`)} as cost
        from lines x ${costJoin}
        group by to_char(x.document_date, 'YYYY-MM')`))].map((row) => ({ ...row, label: monthLabel(row.label) }));
      break;
    case "salesperson":
      // Each line's shares: its own, or its invoice line's for a credit note, or the document's one salesperson in full.
      rows = [...(await tx.execute<Grouped>(sql`
        with ${linesOf(ctx, filter)}${costs},
        shares as (
          select x.line_id, p.user_id, p.share
          from lines x
          cross join lateral (
            select s.user_id, s.share_percent / 100 as share from public.sales_line_salespeople s where s.tenant_id = ${ctx.tenantId} and s.line_id = x.line_id
            union all
            select s.user_id, s.share_percent / 100 from public.sales_line_salespeople s
            where s.tenant_id = ${ctx.tenantId} and s.line_id = x.source_line_id
              and not exists (select 1 from public.sales_line_salespeople o where o.tenant_id = ${ctx.tenantId} and o.line_id = x.line_id)
            union all
            select x.doc_person, 1::numeric
            where not exists (select 1 from public.sales_line_salespeople o where o.tenant_id = ${ctx.tenantId} and o.line_id in (x.line_id, x.source_line_id))
          ) p
        )
        select coalesce(max(sp.email), case when h.user_id is null then 'No salesperson' else 'A member who has left' end) as label,
               null::text as detail, null::text as unit, null::text as quantity,
               round(sum(x.amount * h.share), 4)::text as amount, ${cost(sql`h.share`)} as cost
        from lines x
        join shares h on h.line_id = x.line_id ${costJoin}
        left join app.sales_people() sp on sp.user_id = h.user_id
        group by h.user_id`))];
      break;
  }
  return rows.map((row) => ({ label: row.label, detail: row.detail, quantity: row.quantity === null ? null : d(row.quantity), unit: row.unit, amount: d(row.amount), cost: row.cost === null ? null : d(row.cost) }));
}

/** The Sales account in the books for the period (credits less debits), for the branch; null for a reader who cannot read the books. */
async function booksSales(tx: Tx, ctx: TenantContext, filter: SalesFilter): Promise<Decimal | null> {
  if (!can(ctx.role, "report.read")) return null;
  const [row] = await tx.execute<{ net: string }>(sql`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as net
    from public.journal_lines jl
    join public.journals j on j.tenant_id = jl.tenant_id and j.id = jl.journal_id
    join public.accounts a on a.tenant_id = jl.tenant_id and a.id = jl.account_id
    where jl.tenant_id = ${ctx.tenantId} and a.is_control and a.control_type = 'sales'
      and j.journal_date between ${filter.from}::date and ${filter.to}::date
      and (${filter.branchId}::uuid is null or j.branch_id = ${filter.branchId}::uuid)`);
  return d(row?.net);
}

async function register(tx: Tx, ctx: TenantContext, filter: SalesFilter): Promise<RegisterRow[]> {
  const rows = await tx.execute<{ document_date: string; kind: "invoice" | "credit_note"; number: string; customer: string; salesperson: string; amount: string; tax: string; total: string }>(sql`
    select s.document_date::text, s.kind, s.number, s.buyer_name as customer,
      coalesce((
        select string_agg(distinct sp.email, ', ' order by sp.email)
        from (
          select o.user_id from public.sales_line_salespeople o where o.tenant_id = s.tenant_id and o.document_id = s.id
          union select s.salesperson_id where s.salesperson_id is not null
          union select src.user_id from public.sales_line_salespeople src
                where s.kind = 'credit_note' and src.tenant_id = s.tenant_id and src.document_id = s.source_document_id
        ) w
        join app.sales_people() sp on sp.user_id = w.user_id), '') as salesperson,
      ((case when s.kind = 'credit_note' then -1 else 1 end) * s.value_total * s.exchange_rate)::text as amount,
      ((case when s.kind = 'credit_note' then -1 else 1 end) * (s.total - s.value_total) * s.exchange_rate)::text as tax,
      ((case when s.kind = 'credit_note' then -1 else 1 end) * s.total * s.exchange_rate)::text as total
    from public.sales_documents s
    where s.tenant_id = ${ctx.tenantId} and s.kind in ('invoice', 'credit_note') and s.status = 'submitted'
      and s.document_date between ${filter.from}::date and ${filter.to}::date
      and (${filter.branchId}::uuid is null or s.branch_id = ${filter.branchId}::uuid)
    order by s.document_date, s.number`);
  return rows.map((row) => ({ date: row.document_date, kind: row.kind, number: row.number, customer: row.customer, salesperson: row.salesperson, amount: d(row.amount), tax: d(row.tax), total: d(row.total) }));
}

/** One sales report, as a table, for the screen, the printer and the file alike. */
export async function getSalesReport(ctx: TenantContext, report: SalesReportKey, filter: SalesFilter): Promise<ReportTable> {
  requireSalesReport(ctx);
  const group = SALES_REPORTS[report].group;
  const withCost = can(ctx.role, "stock.cost.read");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    if (group === null) {
      const [rows, books] = await Promise.all([register(tx, ctx, filter), booksSales(tx, ctx, filter)]);
      return salesRegisterTable(rows, books, filter);
    }
    const [rows, books] = await Promise.all([grouped(tx, ctx, filter, group, withCost), booksSales(tx, ctx, filter)]);
    return salesBreakdownTable(report as Exclude<SalesReportKey, "sales-register">, rows, books, filter);
  });
}
