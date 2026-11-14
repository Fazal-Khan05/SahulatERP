import "server-only";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import type { ReportTable } from "@/modules/reports/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";
import {
  STOCK_REPORTS,
  ageStock,
  ageingTable,
  itemMovesTable,
  itemProfitTable,
  lowStockTable,
  movementTable,
  valuationTable,
  type StockFilter,
  type StockReportKey,
} from "./rules";

// The stock reports, read from posted stock moves, stock balances and posted invoices. Row-level
// security decides what the reader sees: stock moves only by an owner, an accountant or an
// auditor, and a member limited to some branches sees those branches' warehouses only.

const d = (value: string | null | undefined) => new Decimal(value ?? "0");

/** Refuses a member who may not read this report. */
export function requireStockReport(ctx: TenantContext, report: StockReportKey): void {
  const permission = STOCK_REPORTS[report].permission;
  if (!can(ctx.role, permission)) {
    throw new UserError(permission === "stock.read" ? "Your role does not include stock." : "Only an owner, an accountant or an auditor can see what stock cost.");
  }
}

const branchOf = (filter: StockFilter) => sql`(${filter.branchId}::uuid is null or w.branch_id = ${filter.branchId}::uuid)`;
const warehouseOf = (filter: StockFilter) => sql`(${filter.warehouseId}::uuid is null or m.warehouse_id = ${filter.warehouseId}::uuid)`;

type Held = { item_id: string; warehouse_id: string; code: string; name: string; unit: string; warehouse: string; quantity: string; value: string };

/** What each warehouse held of each item at the end of a day, from the moves up to it. */
async function selectHeld(tx: Tx, tenantId: string, filter: StockFilter): Promise<Held[]> {
  return tx.execute<Held>(sql`
    select i.id as item_id, w.id as warehouse_id, i.code, i.name, u.code as unit, w.name as warehouse,
      sum(m.quantity)::text as quantity, sum(m.value)::text as value
    from public.stock_moves m
    join public.items i on i.tenant_id = m.tenant_id and i.id = m.item_id
    join public.units u on u.tenant_id = i.tenant_id and u.id = i.base_unit_id
    join public.warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
    where m.tenant_id = ${tenantId} and m.move_date <= ${filter.to}::date and ${branchOf(filter)} and ${warehouseOf(filter)}
    group by i.id, w.id, i.code, i.name, u.code, w.name
    having sum(m.quantity) <> 0 or sum(m.value) <> 0
    order by lower(i.code), lower(w.name)`);
}

/** The stock account (control type "inventory") in the books at the end of a day, for a branch or the whole company. */
async function selectStockAccount(tx: Tx, tenantId: string, filter: StockFilter): Promise<Decimal> {
  const [row] = await tx.execute<{ balance: string }>(sql`
    select coalesce(sum(l.debit - l.credit), 0)::text as balance
    from public.journal_lines l
    join public.journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
    join public.accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
    where l.tenant_id = ${tenantId} and j.journal_date <= ${filter.to}::date and a.control_type = 'inventory'
      and (${filter.branchId}::uuid is null or l.branch_id = ${filter.branchId}::uuid)`);
  return d(row?.balance);
}

async function valuation(tx: Tx, ctx: TenantContext, filter: StockFilter): Promise<ReportTable> {
  const [held, books] = await Promise.all([selectHeld(tx, ctx.tenantId, filter), filter.warehouseId ? null : selectStockAccount(tx, ctx.tenantId, filter)]);
  return valuationTable(
    held.map((row) => ({ code: row.code, name: row.name, unit: row.unit, warehouse: row.warehouse, quantity: d(row.quantity), value: d(row.value) })),
    filter,
    books,
  );
}

async function movement(tx: Tx, ctx: TenantContext, filter: StockFilter): Promise<ReportTable> {
  if (filter.itemId) {
    const moves = await itemMoves(tx, ctx, filter, filter.itemId);
    if (moves) return moves;
  }
  const rows = await tx.execute<{ code: string; name: string; unit: string; warehouse: string; oq: string; ov: string; iq: string; iv: string; outq: string; outv: string }>(sql`
    select i.code, i.name, u.code as unit, w.name as warehouse,
      coalesce(sum(m.quantity) filter (where m.move_date < ${filter.from}::date), 0)::text as oq,
      coalesce(sum(m.value) filter (where m.move_date < ${filter.from}::date), 0)::text as ov,
      coalesce(sum(m.quantity) filter (where m.move_date >= ${filter.from}::date and m.quantity > 0), 0)::text as iq,
      coalesce(sum(m.value) filter (where m.move_date >= ${filter.from}::date and m.quantity > 0), 0)::text as iv,
      coalesce(-sum(m.quantity) filter (where m.move_date >= ${filter.from}::date and m.quantity < 0), 0)::text as outq,
      coalesce(-sum(m.value) filter (where m.move_date >= ${filter.from}::date and m.quantity < 0), 0)::text as outv
    from public.stock_moves m
    join public.items i on i.tenant_id = m.tenant_id and i.id = m.item_id
    join public.units u on u.tenant_id = i.tenant_id and u.id = i.base_unit_id
    join public.warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
    where m.tenant_id = ${ctx.tenantId} and m.move_date <= ${filter.to}::date and ${branchOf(filter)} and ${warehouseOf(filter)}
    group by i.id, w.id, i.code, i.name, u.code, w.name
    having sum(m.quantity) filter (where m.move_date < ${filter.from}::date) <> 0
      or sum(m.value) filter (where m.move_date < ${filter.from}::date) <> 0
      or count(*) filter (where m.move_date >= ${filter.from}::date) > 0
    order by lower(i.code), lower(w.name)`);
  return movementTable(
    rows.map((row) => ({ code: row.code, name: row.name, unit: row.unit, warehouse: row.warehouse, openingQuantity: d(row.oq), openingValue: d(row.ov), inQuantity: d(row.iq), inValue: d(row.iv), outQuantity: d(row.outq), outValue: d(row.outv) })),
    filter,
  );
}

const DOCUMENT_WORDS: Record<string, string> = {
  delivery_note: "Delivery note",
  sales_invoice: "Sales invoice",
  stock_transfer: "Transfer",
  stock_adjustment: "Adjustment",
  stock_count: "Stock count",
};

/** The moves of one item in a period, with the documents behind them. */
async function itemMoves(tx: Tx, ctx: TenantContext, filter: StockFilter, itemId: string): Promise<ReportTable | null> {
  const [item] = await tx.execute<{ code: string; name: string; unit: string }>(sql`
    select i.code, i.name, u.code as unit from public.items i join public.units u on u.tenant_id = i.tenant_id and u.id = i.base_unit_id
    where i.tenant_id = ${ctx.tenantId} and i.id = ${itemId}::uuid`);
  // An item of another company, or none: the report for every item.
  if (!item) return null;
  const [[opening], moves] = await Promise.all([
    tx.execute<{ quantity: string; value: string }>(sql`
      select coalesce(sum(m.quantity), 0)::text as quantity, coalesce(sum(m.value), 0)::text as value
      from public.stock_moves m join public.warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
      where m.tenant_id = ${ctx.tenantId} and m.item_id = ${itemId}::uuid and m.move_date < ${filter.from}::date and ${branchOf(filter)} and ${warehouseOf(filter)}`),
    tx.execute<{ move_date: string; quantity: string; value: string; warehouse: string; source_type: string; number: string | null; reversal: boolean }>(sql`
      select m.move_date::text, m.quantity::text, m.value::text, w.name as warehouse, m.source_type,
        coalesce(sd.number, st.number, sa.number, sc.number) as number, m.reverses_move_id is not null as reversal
      from public.stock_moves m
      join public.warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
      left join public.sales_documents sd on m.source_type in ('delivery_note', 'sales_invoice') and sd.tenant_id = m.tenant_id and sd.id = m.source_id
      left join public.stock_transfers st on m.source_type = 'stock_transfer' and st.tenant_id = m.tenant_id and st.id = m.source_id
      left join public.stock_adjustments sa on m.source_type = 'stock_adjustment' and sa.tenant_id = m.tenant_id and sa.id = m.source_id
      left join public.stock_counts sc on m.source_type = 'stock_count' and sc.tenant_id = m.tenant_id and sc.id = m.source_id
      where m.tenant_id = ${ctx.tenantId} and m.item_id = ${itemId}::uuid and m.move_date between ${filter.from}::date and ${filter.to}::date
        and ${branchOf(filter)} and ${warehouseOf(filter)}
      -- A document's moves share one moment: what left goes before what came in, as a transfer does it.
      order by m.move_date, m.created_at, m.quantity > 0, m.id`),
  ]);
  return itemMovesTable(
    item,
    { quantity: d(opening?.quantity), value: d(opening?.value) },
    moves.map((move) => ({
      date: move.move_date,
      document: `${DOCUMENT_WORDS[move.source_type] ?? move.source_type}${move.number ? ` ${move.number}` : ""}${move.reversal ? ", cancelled" : ""}`,
      warehouse: move.warehouse,
      quantity: d(move.quantity),
      value: d(move.value),
    })),
    filter,
  );
}

async function ageing(tx: Tx, ctx: TenantContext, filter: StockFilter): Promise<ReportTable> {
  const [held, incoming, sold] = await Promise.all([
    selectHeld(tx, ctx.tenantId, filter),
    // Everything that came in, newest first.
    tx.execute<{ item_id: string; warehouse_id: string; move_date: string; quantity: string }>(sql`
      select m.item_id, m.warehouse_id, m.move_date::text, m.quantity::text
      from public.stock_moves m join public.warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
      where m.tenant_id = ${ctx.tenantId} and m.quantity > 0 and m.move_date <= ${filter.to}::date and ${branchOf(filter)} and ${warehouseOf(filter)}
      order by m.move_date desc, m.created_at desc, m.id desc`),
    // The last day each item left each warehouse on a delivery note or an invoice that still stands.
    tx.execute<{ item_id: string; warehouse_id: string; last_sold: string }>(sql`
      select m.item_id, m.warehouse_id, max(m.move_date)::text as last_sold
      from public.stock_moves m join public.warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
      where m.tenant_id = ${ctx.tenantId} and m.quantity < 0 and m.source_type in ('delivery_note', 'sales_invoice') and m.reverses_move_id is null
        and m.move_date <= ${filter.to}::date and ${branchOf(filter)} and ${warehouseOf(filter)}
        and not exists (select 1 from public.stock_moves r where r.tenant_id = m.tenant_id and r.reverses_move_id = m.id and r.move_date <= ${filter.to}::date)
      group by m.item_id, m.warehouse_id`),
  ]);
  const key = (itemId: string, warehouseId: string) => `${itemId}/${warehouseId}`;
  const ins = new Map<string, { date: string; quantity: Decimal }[]>();
  for (const move of incoming) {
    const list = ins.get(key(move.item_id, move.warehouse_id)) ?? [];
    list.push({ date: move.move_date, quantity: d(move.quantity) });
    ins.set(key(move.item_id, move.warehouse_id), list);
  }
  const lastSold = new Map(sold.map((row) => [key(row.item_id, row.warehouse_id), row.last_sold]));
  return ageingTable(
    held
      .filter((row) => d(row.quantity).gt(0))
      .map((row) => ({
        code: row.code,
        name: row.name,
        unit: row.unit,
        warehouse: row.warehouse,
        quantity: d(row.quantity),
        value: d(row.value),
        bands: ageStock(d(row.quantity), ins.get(key(row.item_id, row.warehouse_id)) ?? [], filter.to),
        lastSold: lastSold.get(key(row.item_id, row.warehouse_id)) ?? null,
      })),
    filter,
  );
}

async function lowStock(tx: Tx, ctx: TenantContext, filter: StockFilter, today: string): Promise<ReportTable> {
  const [listed, held, ordered] = await Promise.all([
    tx.execute<{ id: string; code: string; name: string; unit: string; reorder_level: string }>(sql`
      select i.id, i.code, i.name, u.code as unit, i.reorder_level::text
      from public.items i join public.units u on u.tenant_id = i.tenant_id and u.id = i.base_unit_id
      where i.tenant_id = ${ctx.tenantId} and i.reorder_level is not null and i.archived_at is null
      order by lower(i.code)`),
    tx.execute<{ item_id: string; warehouse: string; quantity: string }>(sql`
      select b.item_id, w.name as warehouse, b.quantity::text
      from public.stock_balances b join public.warehouses w on w.tenant_id = b.tenant_id and w.id = b.warehouse_id
      where b.tenant_id = ${ctx.tenantId} and b.quantity <> 0 and ${branchOf(filter)}
      order by lower(w.name)`),
    // What submitted sales orders still have to deliver: each line less what posted delivery notes and invoices made from it took.
    tx.execute<{ item_id: string; open: string }>(sql`
      select ol.item_id, sum(greatest(ol.base_quantity - coalesce((
          select sum(l.base_quantity) from public.sales_lines l
          join public.sales_documents x on x.tenant_id = l.tenant_id and x.id = l.document_id
          where l.tenant_id = ol.tenant_id and l.source_line_id = ol.id and x.kind in ('delivery', 'invoice') and x.status = 'submitted'), 0), 0))::text as open
      from public.sales_lines ol
      join public.sales_documents o on o.tenant_id = ol.tenant_id and o.id = ol.document_id
      join public.warehouses w on w.tenant_id = o.tenant_id and w.id = o.warehouse_id
      where ol.tenant_id = ${ctx.tenantId} and o.kind = 'order' and o.status = 'submitted' and ${branchOf(filter)}
      group by ol.item_id`),
  ]);
  const places = new Map<string, { warehouse: string; quantity: Decimal }[]>();
  for (const row of held) places.set(row.item_id, [...(places.get(row.item_id) ?? []), { warehouse: row.warehouse, quantity: d(row.quantity) }]);
  const open = new Map(ordered.map((row) => [row.item_id, d(row.open)]));
  return lowStockTable(
    listed.map((item) => {
      const byWarehouse = places.get(item.id) ?? [];
      return { code: item.code, name: item.name, unit: item.unit, reorderLevel: d(item.reorder_level), onHand: byWarehouse.reduce((total, place) => total.plus(place.quantity), new Decimal(0)), onOrder: open.get(item.id) ?? new Decimal(0), byWarehouse };
    }),
    today,
  );
}

async function itemProfit(tx: Tx, ctx: TenantContext, filter: StockFilter): Promise<ReportTable> {
  const rows = await tx.execute<{ code: string; name: string; unit: string; quantity: string; sales: string; cost: string }>(sql`
    select i.code, i.name, u.code as unit, sum(l.base_quantity)::text as quantity,
      round(sum(l.value * s.exchange_rate), 4)::text as sales, coalesce(sum(c.cost), 0)::text as cost
    from public.sales_lines l
    join public.sales_documents s on s.tenant_id = l.tenant_id and s.id = l.document_id
    join public.items i on i.tenant_id = l.tenant_id and i.id = l.item_id
    join public.units u on u.tenant_id = i.tenant_id and u.id = i.base_unit_id
    -- What the goods on the line left stock at: on the invoice itself when it delivered them, or
    -- on the delivery note line it bills.
    left join lateral (
      select -sum(m.value) as cost from public.stock_moves m
      where m.tenant_id = l.tenant_id
        and ((m.source_type = 'sales_invoice' and m.source_id = s.id and m.source_line_id = l.id)
          or (m.source_type = 'delivery_note' and l.source_line_id is not null and m.source_line_id = l.source_line_id))
    ) c on true
    where l.tenant_id = ${ctx.tenantId} and s.kind = 'invoice' and s.status = 'submitted'
      and s.document_date between ${filter.from}::date and ${filter.to}::date
      and (${filter.branchId}::uuid is null or s.branch_id = ${filter.branchId}::uuid)
    group by i.id, i.code, i.name, u.code
    order by lower(i.code)`);
  return itemProfitTable(
    rows.map((row) => ({ code: row.code, name: row.name, unit: row.unit, quantity: d(row.quantity), sales: d(row.sales), cost: d(row.cost) })),
    filter,
  );
}

/** One stock report as a table, for the screen, the printer and the file alike. */
export async function getStockReport(ctx: TenantContext, report: StockReportKey, filter: StockFilter, today: string): Promise<ReportTable> {
  requireStockReport(ctx, report);
  return withTenant(ctx.userId, ctx.tenantId, (tx) => {
    switch (report) {
      case "valuation":
        return valuation(tx, ctx, filter);
      case "movement":
        return movement(tx, ctx, filter);
      case "ageing":
        return ageing(tx, ctx, filter);
      case "low-stock":
        return lowStock(tx, ctx, filter, today);
      case "item-profit":
        return itemProfit(tx, ctx, filter);
    }
  });
}

/** The items and warehouses a report can be narrowed to. */
export async function listStockReportChoices(ctx: TenantContext): Promise<{ items: { id: string; label: string }[]; warehouses: { id: string; label: string; branchId: string }[] }> {
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [items, warehouses] = await Promise.all([
      tx.execute<{ id: string; label: string }>(sql`select id, code || ' ' || name as label from public.items where tenant_id = ${ctx.tenantId} order by lower(code)`),
      tx.execute<{ id: string; label: string; branch_id: string }>(sql`select id, name as label, branch_id from public.warehouses where tenant_id = ${ctx.tenantId} order by lower(name)`),
    ]);
    return { items: [...items], warehouses: warehouses.map((w) => ({ id: w.id, label: w.label, branchId: w.branch_id })) };
  });
}
