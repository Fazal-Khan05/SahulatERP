import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { items, units } from "@/modules/items/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { warehouses } from "@/modules/warehouses/schema";
import type { AdjustmentKind, AdjustmentReason, StockDocumentStatus } from "./rules";
import { stockAdjustmentLines, stockAdjustments, stockBalances, stockCountLines, stockCounts, stockMoves, stockTransferLines, stockTransfers } from "./schema";

// Stock as the database holds it: what each warehouse has of each item, and what it is worth.
// Row-level security decides what the reader may see: the stock of the warehouses of their own
// branches, for the roles that work with stock.

/**
 * How much a warehouse holds of some items, in each item's own unit, inside a transaction the
 * caller holds. An item it has never held is absent. What the stock is worth is not read here:
 * the app's role cannot read it.
 */
export async function selectStockOnHand(tx: Tx, tenantId: string, warehouseId: string, itemIds: readonly string[]): Promise<Map<string, Decimal>> {
  const ids = [...new Set(itemIds)].filter(isUuid);
  if (ids.length === 0 || !isUuid(warehouseId)) return new Map();
  const rows = await tx
    .select({ itemId: stockBalances.itemId, quantity: stockBalances.quantity })
    .from(stockBalances)
    .where(and(eq(stockBalances.tenantId, tenantId), eq(stockBalances.warehouseId, warehouseId), inArray(stockBalances.itemId, ids)));
  return new Map(rows.map((row) => [row.itemId, new Decimal(row.quantity)]));
}

/**
 * What the goods of one document cost when they left stock, line by line: the value of its
 * moves out. The moves that undid them, if the document was cancelled, are left out.
 */
export async function selectMoveCosts(tx: Tx, tenantId: string, sourceType: string, sourceId: string): Promise<Map<string, Decimal>> {
  const rows = await tx
    .select({ lineId: stockMoves.sourceLineId, cost: sql<string>`(-${stockMoves.value})::text` })
    .from(stockMoves)
    .where(and(eq(stockMoves.tenantId, tenantId), eq(stockMoves.sourceType, sourceType), eq(stockMoves.sourceId, sourceId), isNull(stockMoves.reversesMoveId)));
  return new Map(rows.filter((row): row is { lineId: string; cost: string } => row.lineId !== null).map((row) => [row.lineId, new Decimal(row.cost)]));
}

// ── Step 30: stock on hand, and the documents that move stock by hand ───────────────────────────

const READ_REFUSALS = {
  "stock.read": "Your role does not include stock.",
  "stock_transfer.read": "Your role does not include stock transfers.",
  "stock_adjustment.read": "Only an owner, an accountant or an auditor can see stock adjustments.",
  "stock_count.read": "Your role does not include stock counts.",
} as const;

export function requireStockAccess(ctx: TenantContext, permission: keyof typeof READ_REFUSALS = "stock.read"): void {
  if (!can(ctx.role, permission)) throw new UserError(READ_REFUSALS[permission]);
}

export const STOCK_LIST_LIMIT = 200;
export const ON_HAND_LIMIT = 1000;

export type OnHandRow = { itemId: string; code: string; name: string; unit: string; warehouseId: string; warehouse: string; quantity: Decimal; reorderLevel: Decimal | null };

/**
 * What the warehouses this member sees hold now, item by item, in each item's own unit.
 * Quantities only. An item a warehouse held once and holds none of now is left out.
 */
export async function listStockOnHand(ctx: TenantContext, options: { warehouseId?: string; search?: string } = {}): Promise<{ rows: OnHandRow[]; more: boolean }> {
  requireStockAccess(ctx);
  const search = (options.search ?? "").trim().toLowerCase();
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ itemId: items.id, code: items.code, name: items.name, unit: units.code, warehouseId: warehouses.id, warehouse: warehouses.name, quantity: stockBalances.quantity, reorderLevel: items.reorderLevel })
      .from(stockBalances)
      .innerJoin(items, and(eq(items.tenantId, stockBalances.tenantId), eq(items.id, stockBalances.itemId)))
      .innerJoin(units, and(eq(units.tenantId, items.tenantId), eq(units.id, items.baseUnitId)))
      .innerJoin(warehouses, and(eq(warehouses.tenantId, stockBalances.tenantId), eq(warehouses.id, stockBalances.warehouseId)))
      .where(
        and(
          eq(stockBalances.tenantId, ctx.tenantId),
          sql`${stockBalances.quantity} > 0`,
          isUuid(options.warehouseId) ? eq(stockBalances.warehouseId, options.warehouseId) : undefined,
          search === "" ? undefined : sql`(lower(${items.code}) like ${`%${search.replace(/[\\%_]/g, "\\$&")}%`} or lower(${items.name}) like ${`%${search.replace(/[\\%_]/g, "\\$&")}%`})`,
        ),
      )
      .orderBy(asc(sql`lower(${items.code})`), asc(sql`lower(${warehouses.name})`))
      .limit(ON_HAND_LIMIT + 1),
  );
  return {
    more: found.length > ON_HAND_LIMIT,
    rows: found.slice(0, ON_HAND_LIMIT).map((row) => ({ ...row, quantity: new Decimal(row.quantity), reorderLevel: row.reorderLevel === null ? null : new Decimal(row.reorderLevel) })),
  };
}

export type ItemChoice = { id: string; code: string; name: string; unit: string };

/** The items a stock document may name, by code: every item that is not archived. */
export async function listItemChoices(ctx: TenantContext): Promise<ItemChoice[]> {
  requireStockAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ id: items.id, code: items.code, name: items.name, unit: units.code })
      .from(items)
      .innerJoin(units, and(eq(units.tenantId, items.tenantId), eq(units.id, items.baseUnitId)))
      .where(and(eq(items.tenantId, ctx.tenantId), isNull(items.archivedAt)))
      .orderBy(asc(sql`lower(${items.code})`)),
  );
}

/** The items behind some codes, compared as the item list compares them, inside a transaction the caller holds. */
export async function selectItemsByCode(tx: Tx, tenantId: string, codes: readonly string[]): Promise<Map<string, { id: string; code: string; archived: boolean }>> {
  const wanted = [...new Set(codes.map((code) => code.toLowerCase()))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ id: items.id, code: items.code, archivedAt: items.archivedAt })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), inArray(sql`lower(${items.code})`, wanted)));
  return new Map(rows.map((row) => [row.code.toLowerCase(), { id: row.id, code: row.code, archived: row.archivedAt !== null }]));
}

// Holds a draft's row for the rest of the transaction, so that what is read next cannot change
// under the command. Only a draft this member may write can be held by the app (the database
// lets it lock what it may update, and nothing else). A finished or posted document is read
// without being held, which is enough: the app cannot change it, and the database's own
// function holds it and looks at its state again before doing anything.
const lockRow = (table: typeof stockTransfers | typeof stockAdjustments | typeof stockCounts, tenantId: string, id: string) =>
  sql`select 1 from ${table} where ${table.tenantId} = ${tenantId} and ${table.id} = ${id} for update`;

// ── transfers ───────────────────────────────────────────────────────────────────────────────────

export type StockTransferLine = { id: string; lineNo: number; itemId: string; code: string; name: string; unit: string; quantity: Decimal };
export type StockTransfer = {
  id: string;
  status: "draft" | "posted";
  date: string;
  fromWarehouseId: string;
  fromWarehouse: string;
  toWarehouseId: string;
  toWarehouse: string;
  note: string | null;
  number: string | null;
  postedAt: Date | null;
  updatedAt: Date;
  lines: StockTransferLine[];
};

const fromWarehouse = alias(warehouses, "from_warehouse");
const toWarehouse = alias(warehouses, "to_warehouse");

/** One transfer with its lines, inside a transaction the caller holds; null when this member may not see it. `lock` holds its row. */
export async function selectStockTransfer(tx: Tx, tenantId: string, id: string, lock = false): Promise<StockTransfer | null> {
  if (lock) await tx.execute(lockRow(stockTransfers, tenantId, id));
  const [row] = await tx
    .select({
      id: stockTransfers.id,
      status: stockTransfers.status,
      date: stockTransfers.transferDate,
      fromWarehouseId: stockTransfers.fromWarehouseId,
      // A member of one branch sees a transfer into it; the other warehouse's name is shown all the same.
      fromWarehouse: sql<string>`coalesce(${fromWarehouse.name}, 'Another branch')`,
      toWarehouseId: stockTransfers.toWarehouseId,
      toWarehouse: sql<string>`coalesce(${toWarehouse.name}, 'Another branch')`,
      note: stockTransfers.note,
      number: stockTransfers.number,
      postedAt: stockTransfers.postedAt,
      updatedAt: stockTransfers.updatedAt,
    })
    .from(stockTransfers)
    .leftJoin(fromWarehouse, and(eq(fromWarehouse.tenantId, stockTransfers.tenantId), eq(fromWarehouse.id, stockTransfers.fromWarehouseId)))
    .leftJoin(toWarehouse, and(eq(toWarehouse.tenantId, stockTransfers.tenantId), eq(toWarehouse.id, stockTransfers.toWarehouseId)))
    .where(and(eq(stockTransfers.tenantId, tenantId), eq(stockTransfers.id, id)));
  if (!row) return null;
  const lines = await tx
    .select({ id: stockTransferLines.id, lineNo: stockTransferLines.lineNo, itemId: stockTransferLines.itemId, code: items.code, name: items.name, unit: units.code, quantity: stockTransferLines.quantity })
    .from(stockTransferLines)
    .innerJoin(items, and(eq(items.tenantId, stockTransferLines.tenantId), eq(items.id, stockTransferLines.itemId)))
    .innerJoin(units, and(eq(units.tenantId, items.tenantId), eq(units.id, items.baseUnitId)))
    .where(and(eq(stockTransferLines.tenantId, tenantId), eq(stockTransferLines.transferId, id)))
    .orderBy(asc(stockTransferLines.lineNo));
  return { ...row, status: row.status as "draft" | "posted", lines: lines.map((line) => ({ ...line, quantity: new Decimal(line.quantity) })) };
}

export async function getStockTransfer(ctx: TenantContext, id: string): Promise<StockTransfer | null> {
  requireStockAccess(ctx, "stock_transfer.read");
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectStockTransfer(tx, ctx.tenantId, id));
}

export type StockTransferRow = { id: string; status: "draft" | "posted"; date: string; number: string | null; fromWarehouse: string; toWarehouse: string; lines: number; note: string | null };

/** The newest transfers first. At most STOCK_LIST_LIMIT. */
export async function listStockTransfers(ctx: TenantContext): Promise<{ rows: StockTransferRow[]; more: boolean }> {
  requireStockAccess(ctx, "stock_transfer.read");
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        id: stockTransfers.id,
        status: stockTransfers.status,
        date: stockTransfers.transferDate,
        number: stockTransfers.number,
        fromWarehouse: sql<string>`coalesce(${fromWarehouse.name}, 'Another branch')`,
        toWarehouse: sql<string>`coalesce(${toWarehouse.name}, 'Another branch')`,
        lines: sql<number>`(select count(*)::int from public.stock_transfer_lines l where l.tenant_id = public.stock_transfers.tenant_id and l.transfer_id = public.stock_transfers.id)`,
        note: stockTransfers.note,
      })
      .from(stockTransfers)
      .leftJoin(fromWarehouse, and(eq(fromWarehouse.tenantId, stockTransfers.tenantId), eq(fromWarehouse.id, stockTransfers.fromWarehouseId)))
      .leftJoin(toWarehouse, and(eq(toWarehouse.tenantId, stockTransfers.tenantId), eq(toWarehouse.id, stockTransfers.toWarehouseId)))
      .where(eq(stockTransfers.tenantId, ctx.tenantId))
      .orderBy(desc(stockTransfers.transferDate), desc(stockTransfers.createdAt))
      .limit(STOCK_LIST_LIMIT + 1),
  );
  return { more: found.length > STOCK_LIST_LIMIT, rows: found.slice(0, STOCK_LIST_LIMIT).map((row) => ({ ...row, status: row.status as "draft" | "posted" })) };
}

// ── adjustments and opening stock ───────────────────────────────────────────────────────────────

export type StockAdjustmentLine = { id: string; lineNo: number; itemId: string; code: string; name: string; unit: string; quantity: Decimal; unitCost: Decimal | null; /** What the line moved was worth, once posted. */ value: Decimal | null };
export type StockAdjustment = {
  id: string;
  kind: AdjustmentKind;
  status: "draft" | "posted";
  date: string;
  warehouseId: string;
  warehouse: string;
  reason: AdjustmentReason | null;
  note: string | null;
  number: string | null;
  journalId: string | null;
  postedAt: Date | null;
  updatedAt: Date;
  lines: StockAdjustmentLine[];
};

/** One adjustment with its lines and, once posted, what each line was worth; null when this member may not see it. */
export async function selectStockAdjustment(tx: Tx, tenantId: string, id: string, lock = false): Promise<StockAdjustment | null> {
  if (lock) await tx.execute(lockRow(stockAdjustments, tenantId, id));
  const [row] = await tx
    .select({
      id: stockAdjustments.id,
      kind: stockAdjustments.kind,
      status: stockAdjustments.status,
      date: stockAdjustments.adjustmentDate,
      warehouseId: stockAdjustments.warehouseId,
      warehouse: warehouses.name,
      reason: stockAdjustments.reason,
      note: stockAdjustments.note,
      number: stockAdjustments.number,
      journalId: stockAdjustments.journalId,
      postedAt: stockAdjustments.postedAt,
      updatedAt: stockAdjustments.updatedAt,
    })
    .from(stockAdjustments)
    .innerJoin(warehouses, and(eq(warehouses.tenantId, stockAdjustments.tenantId), eq(warehouses.id, stockAdjustments.warehouseId)))
    .where(and(eq(stockAdjustments.tenantId, tenantId), eq(stockAdjustments.id, id)));
  if (!row) return null;
  const lines = await tx
    .select({
      id: stockAdjustmentLines.id,
      lineNo: stockAdjustmentLines.lineNo,
      itemId: stockAdjustmentLines.itemId,
      code: items.code,
      name: items.name,
      unit: units.code,
      quantity: stockAdjustmentLines.quantity,
      unitCost: stockAdjustmentLines.unitCost,
      // Whoever reads an adjustment may read what stock cost: the same three roles.
      value: sql<string | null>`(select abs(m.value)::text from public.stock_moves m where m.tenant_id = public.stock_adjustment_lines.tenant_id and m.source_type = 'stock_adjustment' and m.source_line_id = public.stock_adjustment_lines.id)`,
    })
    .from(stockAdjustmentLines)
    .innerJoin(items, and(eq(items.tenantId, stockAdjustmentLines.tenantId), eq(items.id, stockAdjustmentLines.itemId)))
    .innerJoin(units, and(eq(units.tenantId, items.tenantId), eq(units.id, items.baseUnitId)))
    .where(and(eq(stockAdjustmentLines.tenantId, tenantId), eq(stockAdjustmentLines.adjustmentId, id)))
    .orderBy(asc(stockAdjustmentLines.lineNo));
  return {
    ...row,
    kind: row.kind as AdjustmentKind,
    status: row.status as "draft" | "posted",
    reason: row.reason as AdjustmentReason | null,
    lines: lines.map((line) => ({ ...line, quantity: new Decimal(line.quantity), unitCost: line.unitCost === null ? null : new Decimal(line.unitCost), value: line.value === null ? null : new Decimal(line.value) })),
  };
}

export async function getStockAdjustment(ctx: TenantContext, id: string): Promise<StockAdjustment | null> {
  requireStockAccess(ctx, "stock_adjustment.read");
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectStockAdjustment(tx, ctx.tenantId, id));
}

export type StockAdjustmentRow = { id: string; kind: AdjustmentKind; status: "draft" | "posted"; date: string; number: string | null; warehouse: string; reason: AdjustmentReason | null; note: string | null; lines: number };

/** The newest adjustments and opening stock entries first. At most STOCK_LIST_LIMIT. */
export async function listStockAdjustments(ctx: TenantContext): Promise<{ rows: StockAdjustmentRow[]; more: boolean }> {
  requireStockAccess(ctx, "stock_adjustment.read");
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({
        id: stockAdjustments.id,
        kind: stockAdjustments.kind,
        status: stockAdjustments.status,
        date: stockAdjustments.adjustmentDate,
        number: stockAdjustments.number,
        warehouse: warehouses.name,
        reason: stockAdjustments.reason,
        note: stockAdjustments.note,
        lines: sql<number>`(select count(*)::int from public.stock_adjustment_lines l where l.tenant_id = public.stock_adjustments.tenant_id and l.adjustment_id = public.stock_adjustments.id)`,
      })
      .from(stockAdjustments)
      .innerJoin(warehouses, and(eq(warehouses.tenantId, stockAdjustments.tenantId), eq(warehouses.id, stockAdjustments.warehouseId)))
      .where(eq(stockAdjustments.tenantId, ctx.tenantId))
      .orderBy(desc(stockAdjustments.adjustmentDate), desc(stockAdjustments.createdAt))
      .limit(STOCK_LIST_LIMIT + 1),
  );
  return {
    more: found.length > STOCK_LIST_LIMIT,
    rows: found.slice(0, STOCK_LIST_LIMIT).map((row) => ({ ...row, kind: row.kind as AdjustmentKind, status: row.status as "draft" | "posted", reason: row.reason as AdjustmentReason | null })),
  };
}

// ── counts ──────────────────────────────────────────────────────────────────────────────────────

export type StockCountLine = {
  id: string;
  itemId: string;
  code: string;
  name: string;
  unit: string;
  /** What the books held when the line was written, or last brought up to date. */
  book: Decimal;
  counted: Decimal | null;
  /** What the warehouse holds now. On a sheet not yet posted, a figure other than `book` means stock has moved since. */
  onHand: Decimal;
};
export type StockCount = {
  id: string;
  status: StockDocumentStatus;
  date: string;
  warehouseId: string;
  warehouse: string;
  note: string | null;
  number: string | null;
  journalId: string | null;
  submittedAt: Date | null;
  postedAt: Date | null;
  updatedAt: Date;
  lines: StockCountLine[];
};

/** One count with its lines, by item code; null when this member may not see it. `lock` holds its row. */
export async function selectStockCount(tx: Tx, tenantId: string, id: string, lock = false): Promise<StockCount | null> {
  if (lock) await tx.execute(lockRow(stockCounts, tenantId, id));
  const [row] = await tx
    .select({
      id: stockCounts.id,
      status: stockCounts.status,
      date: stockCounts.countDate,
      warehouseId: stockCounts.warehouseId,
      warehouse: warehouses.name,
      note: stockCounts.note,
      number: stockCounts.number,
      journalId: stockCounts.journalId,
      submittedAt: stockCounts.submittedAt,
      postedAt: stockCounts.postedAt,
      updatedAt: stockCounts.updatedAt,
    })
    .from(stockCounts)
    .innerJoin(warehouses, and(eq(warehouses.tenantId, stockCounts.tenantId), eq(warehouses.id, stockCounts.warehouseId)))
    .where(and(eq(stockCounts.tenantId, tenantId), eq(stockCounts.id, id)));
  if (!row) return null;
  const lines = await tx
    .select({
      id: stockCountLines.id,
      itemId: stockCountLines.itemId,
      code: items.code,
      name: items.name,
      unit: units.code,
      book: stockCountLines.bookQuantity,
      counted: stockCountLines.countedQuantity,
      onHand: sql<string>`coalesce(${stockBalances.quantity}, 0)`,
    })
    .from(stockCountLines)
    .innerJoin(items, and(eq(items.tenantId, stockCountLines.tenantId), eq(items.id, stockCountLines.itemId)))
    .innerJoin(units, and(eq(units.tenantId, items.tenantId), eq(units.id, items.baseUnitId)))
    .leftJoin(stockBalances, and(eq(stockBalances.tenantId, stockCountLines.tenantId), eq(stockBalances.itemId, stockCountLines.itemId), eq(stockBalances.warehouseId, row.warehouseId)))
    .where(and(eq(stockCountLines.tenantId, tenantId), eq(stockCountLines.countId, id)))
    .orderBy(asc(sql`lower(${items.code})`));
  return {
    ...row,
    status: row.status as StockDocumentStatus,
    lines: lines.map((line) => ({ ...line, book: new Decimal(line.book), counted: line.counted === null ? null : new Decimal(line.counted), onHand: new Decimal(line.onHand) })),
  };
}

export async function getStockCount(ctx: TenantContext, id: string): Promise<StockCount | null> {
  requireStockAccess(ctx, "stock_count.read");
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectStockCount(tx, ctx.tenantId, id));
}

export type StockCountRow = { id: string; status: StockDocumentStatus; date: string; number: string | null; warehouse: string; note: string | null; lines: number; counted: number };

async function selectCountRows(tx: Tx, tenantId: string, only?: StockDocumentStatus): Promise<StockCountRow[]> {
  const found = await tx
    .select({
      id: stockCounts.id,
      status: stockCounts.status,
      date: stockCounts.countDate,
      number: stockCounts.number,
      warehouse: warehouses.name,
      note: stockCounts.note,
      lines: sql<number>`(select count(*)::int from public.stock_count_lines l where l.tenant_id = public.stock_counts.tenant_id and l.count_id = public.stock_counts.id)`,
      counted: sql<number>`(select count(l.counted_quantity)::int from public.stock_count_lines l where l.tenant_id = public.stock_counts.tenant_id and l.count_id = public.stock_counts.id)`,
    })
    .from(stockCounts)
    .innerJoin(warehouses, and(eq(warehouses.tenantId, stockCounts.tenantId), eq(warehouses.id, stockCounts.warehouseId)))
    .where(and(eq(stockCounts.tenantId, tenantId), only ? eq(stockCounts.status, only) : undefined))
    .orderBy(desc(stockCounts.countDate), desc(stockCounts.createdAt))
    .limit(STOCK_LIST_LIMIT + 1);
  return found.map((row) => ({ ...row, status: row.status as StockDocumentStatus }));
}

/** The newest counts first. At most STOCK_LIST_LIMIT. */
export async function listStockCounts(ctx: TenantContext): Promise<{ rows: StockCountRow[]; more: boolean }> {
  requireStockAccess(ctx, "stock_count.read");
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) => selectCountRows(tx, ctx.tenantId));
  return { more: found.length > STOCK_LIST_LIMIT, rows: found.slice(0, STOCK_LIST_LIMIT) };
}

/** Counts that are finished and wait for an owner or an accountant to post them, oldest first. */
export async function listCountsToPost(ctx: TenantContext): Promise<StockCountRow[]> {
  if (!can(ctx.role, "stock_count.post")) return [];
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) => selectCountRows(tx, ctx.tenantId, "submitted"));
  return found.slice(0, STOCK_LIST_LIMIT).reverse();
}
