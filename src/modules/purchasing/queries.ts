import "server-only";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { itemUnits, items, units } from "@/modules/items/schema";
import { suppliers } from "@/modules/parties/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { warehouses } from "@/modules/warehouses/schema";
import type { GoodsReceiptStatus, OrderItem, OrderLineToReceive, PurchaseOrderStatus } from "./rules";
import { goodsReceiptLines, goodsReceipts, purchaseOrderLines, purchaseOrders } from "./schema";

// Read models for buying. Row-level security decides what comes back: orders carry cost and are
// read by the owner and whoever keeps or checks the books; goods received carry quantities only
// and are read by the warehouse too. What the warehouse needs of an order (what is left to
// arrive, never its cost) comes from the database's own functions.

export function requireOrderAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "purchase_order.read")) throw new UserError("Your role does not include purchase orders.");
}
export function requireReceiptAccess(ctx: TenantContext): void {
  if (!can(ctx.role, "goods_receipt.read")) throw new UserError("Your role does not include goods received.");
}

const d = (value: string | null) => new Decimal(value ?? "0");

export type OrderLine = { id: string; lineNo: number; itemId: string; itemCode: string; description: string; unitId: string; unitCode: string; unitFactor: Decimal; quantity: Decimal; baseQuantity: Decimal; unitCost: Decimal; amount: Decimal };

export type PurchaseOrder = {
  id: string;
  status: PurchaseOrderStatus;
  number: string | null;
  date: string;
  supplierId: string;
  supplierName: string;
  supplierArchived: boolean;
  warehouseId: string;
  warehouseName: string;
  expectedOn: string | null;
  supplierReference: string | null;
  note: string | null;
  total: Decimal;
  cancelReason: string | null;
  updatedAt: Date;
  lines: OrderLine[];
};

/** One purchase order with its lines, inside a transaction the caller holds. Null when it is not one this member may read. `lock` holds a draft's row. */
export async function selectOrder(tx: Tx, tenantId: string, id: string, lock = false): Promise<PurchaseOrder | null> {
  // A row can be held only where it can be changed: a draft. Anything else is read as it is.
  if (lock) await tx.execute(sql`select 1 from public.purchase_orders where tenant_id = ${tenantId}::uuid and id = ${id}::uuid for update`);
  const [row] = await tx
    .select({
      id: purchaseOrders.id,
      status: purchaseOrders.status,
      number: purchaseOrders.number,
      date: purchaseOrders.orderDate,
      supplierId: purchaseOrders.supplierId,
      warehouseId: purchaseOrders.warehouseId,
      expectedOn: purchaseOrders.expectedOn,
      supplierReference: purchaseOrders.supplierReference,
      note: purchaseOrders.note,
      total: purchaseOrders.total,
      cancelReason: purchaseOrders.cancelReason,
      updatedAt: purchaseOrders.updatedAt,
    })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, id)));
  if (!row) return null;
  const [[supplier], [warehouse], lines] = await Promise.all([
    tx.select({ name: suppliers.name, archivedAt: suppliers.archivedAt }).from(suppliers).where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, row.supplierId))),
    tx.select({ name: warehouses.name }).from(warehouses).where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, row.warehouseId))),
    tx
      .select({
        id: purchaseOrderLines.id,
        lineNo: purchaseOrderLines.lineNo,
        itemId: purchaseOrderLines.itemId,
        itemCode: items.code,
        description: purchaseOrderLines.description,
        unitId: purchaseOrderLines.unitId,
        unitCode: units.code,
        unitFactor: purchaseOrderLines.unitFactor,
        quantity: purchaseOrderLines.quantity,
        baseQuantity: purchaseOrderLines.baseQuantity,
        unitCost: purchaseOrderLines.unitCost,
        amount: purchaseOrderLines.amount,
      })
      .from(purchaseOrderLines)
      .innerJoin(items, and(eq(items.tenantId, purchaseOrderLines.tenantId), eq(items.id, purchaseOrderLines.itemId)))
      .innerJoin(units, and(eq(units.tenantId, purchaseOrderLines.tenantId), eq(units.id, purchaseOrderLines.unitId)))
      .where(and(eq(purchaseOrderLines.tenantId, tenantId), eq(purchaseOrderLines.orderId, id)))
      .orderBy(asc(purchaseOrderLines.lineNo)),
  ]);
  return {
    ...row,
    status: row.status as PurchaseOrderStatus,
    supplierName: supplier?.name ?? "",
    supplierArchived: supplier?.archivedAt != null,
    warehouseName: warehouse?.name ?? "",
    total: d(row.total),
    lines: lines.map((line) => ({ ...line, unitFactor: d(line.unitFactor), quantity: d(line.quantity), baseQuantity: d(line.baseQuantity), unitCost: d(line.unitCost), amount: d(line.amount) })),
  };
}

type ToReceiveRow = { line_id: string; line_no: number; item_id: string; item_code: string; description: string; unit_code: string; unit_factor: string; ordered: string; received: string };

/** The lines of a submitted order with what has arrived of each, without cost; inside a transaction the caller holds. */
export async function selectLinesToReceive(tx: Tx, orderId: string): Promise<OrderLineToReceive[]> {
  const rows = await tx.execute<ToReceiveRow>(sql`
    select line_id, line_no, item_id, item_code, description, unit_code, unit_factor::text, ordered::text, received::text
    from app.order_lines_to_receive(${orderId}::uuid)`);
  return rows.map((row) => ({ lineId: row.line_id, lineNo: row.line_no, itemId: row.item_id, itemCode: row.item_code, description: row.description, unitCode: row.unit_code, unitFactor: d(row.unit_factor), ordered: d(row.ordered), received: d(row.received) }));
}

export type ReceiptSummary = { id: string; number: string | null; status: GoodsReceiptStatus; date: string };

/** The goods received notes of one order, drafts included, oldest first. */
export async function selectReceiptsOf(tx: Tx, tenantId: string, orderId: string): Promise<ReceiptSummary[]> {
  const rows = await tx
    .select({ id: goodsReceipts.id, number: goodsReceipts.number, status: goodsReceipts.status, date: goodsReceipts.receiptDate })
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.tenantId, tenantId), eq(goodsReceipts.orderId, orderId)))
    .orderBy(asc(goodsReceipts.createdAt));
  return rows.map((row) => ({ ...row, status: row.status as GoodsReceiptStatus }));
}

/** One order for its own page: with what has arrived of each line, and its goods received notes. */
export async function getOrder(ctx: TenantContext, id: string): Promise<(PurchaseOrder & { toReceive: OrderLineToReceive[]; receipts: ReceiptSummary[] }) | null> {
  requireOrderAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const order = await selectOrder(tx, ctx.tenantId, id);
    if (!order) return null;
    const [toReceive, receipts] = await Promise.all([order.status === "submitted" ? selectLinesToReceive(tx, id) : [], selectReceiptsOf(tx, ctx.tenantId, id)]);
    return { ...order, toReceive, receipts };
  });
}

export const PURCHASE_LIST_LIMIT = 200;

export type OrderRow = { id: string; status: PurchaseOrderStatus; number: string | null; date: string; supplierName: string; warehouseName: string; total: Decimal };

/** The newest purchase orders. */
export async function listOrders(ctx: TenantContext): Promise<{ rows: OrderRow[]; more: boolean }> {
  requireOrderAccess(ctx);
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; status: PurchaseOrderStatus; number: string | null; order_date: string; supplier_name: string; warehouse_name: string; total: string }>(sql`
      select o.id, o.status, o.number, o.order_date::text, s.name as supplier_name, w.name as warehouse_name, o.total::text
      from purchase_orders o
      join suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
      join warehouses w on w.tenant_id = o.tenant_id and w.id = o.warehouse_id
      where o.tenant_id = ${ctx.tenantId}::uuid
      order by o.order_date desc, o.created_at desc
      limit ${PURCHASE_LIST_LIMIT + 1}`),
  );
  return {
    more: found.length > PURCHASE_LIST_LIMIT,
    rows: found.slice(0, PURCHASE_LIST_LIMIT).map((row) => ({ id: row.id, status: row.status, number: row.number, date: row.order_date, supplierName: row.supplier_name, warehouseName: row.warehouse_name, total: d(row.total) })),
  };
}

export type OrderToReceive = { id: string; number: string; date: string; expectedOn: string | null; supplierId: string; supplierName: string; warehouseId: string; warehouseName: string; linesLeft: number };

/** Submitted orders with something still to arrive, soonest expected first: what the warehouse works from. No cost. */
export async function listOrdersToReceive(ctx: TenantContext): Promise<OrderToReceive[]> {
  requireReceiptAccess(ctx);
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; number: string; order_date: string; expected_on: string | null; supplier_id: string; supplier_name: string; warehouse_id: string; warehouse_name: string; lines_left: number }>(sql`
      select id, number, order_date::text, expected_on::text, supplier_id, supplier_name, warehouse_id, warehouse_name, lines_left from app.orders_to_receive()`),
  );
  return rows.map((row) => ({ id: row.id, number: row.number, date: row.order_date, expectedOn: row.expected_on, supplierId: row.supplier_id, supplierName: row.supplier_name, warehouseId: row.warehouse_id, warehouseName: row.warehouse_name, linesLeft: row.lines_left }));
}

export type ReceiptLine = { id: string; lineNo: number; orderLineId: string; itemId: string; itemCode: string; itemName: string; unitFactor: Decimal; quantity: Decimal; baseQuantity: Decimal };

export type GoodsReceipt = {
  id: string;
  status: GoodsReceiptStatus;
  number: string | null;
  date: string;
  orderId: string;
  supplierId: string;
  supplierName: string;
  warehouseId: string;
  warehouseName: string;
  supplierDeliveryNote: string | null;
  note: string | null;
  journalId: string | null;
  updatedAt: Date;
  lines: ReceiptLine[];
};

/** One goods received note with its lines, inside a transaction the caller holds. `lock` holds a draft's row. */
export async function selectReceipt(tx: Tx, tenantId: string, id: string, lock = false): Promise<GoodsReceipt | null> {
  if (lock) await tx.execute(sql`select 1 from public.goods_receipts where tenant_id = ${tenantId}::uuid and id = ${id}::uuid for update`);
  const [row] = await tx
    .select({
      id: goodsReceipts.id,
      status: goodsReceipts.status,
      number: goodsReceipts.number,
      date: goodsReceipts.receiptDate,
      orderId: goodsReceipts.orderId,
      supplierId: goodsReceipts.supplierId,
      warehouseId: goodsReceipts.warehouseId,
      supplierDeliveryNote: goodsReceipts.supplierDeliveryNote,
      note: goodsReceipts.note,
      journalId: goodsReceipts.journalId,
      updatedAt: goodsReceipts.updatedAt,
    })
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.tenantId, tenantId), eq(goodsReceipts.id, id)));
  if (!row) return null;
  const [[supplier], [warehouse], lines] = await Promise.all([
    tx.select({ name: suppliers.name }).from(suppliers).where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, row.supplierId))),
    tx.select({ name: warehouses.name }).from(warehouses).where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, row.warehouseId))),
    tx
      .select({ id: goodsReceiptLines.id, lineNo: goodsReceiptLines.lineNo, orderLineId: goodsReceiptLines.orderLineId, itemId: goodsReceiptLines.itemId, itemCode: items.code, itemName: items.name, unitFactor: goodsReceiptLines.unitFactor, quantity: goodsReceiptLines.quantity, baseQuantity: goodsReceiptLines.baseQuantity })
      .from(goodsReceiptLines)
      .innerJoin(items, and(eq(items.tenantId, goodsReceiptLines.tenantId), eq(items.id, goodsReceiptLines.itemId)))
      .where(and(eq(goodsReceiptLines.tenantId, tenantId), eq(goodsReceiptLines.receiptId, id)))
      .orderBy(asc(goodsReceiptLines.lineNo)),
  ]);
  return {
    ...row,
    status: row.status as GoodsReceiptStatus,
    supplierName: supplier?.name ?? "",
    warehouseName: warehouse?.name ?? "",
    lines: lines.map((line) => ({ ...line, unitFactor: d(line.unitFactor), quantity: d(line.quantity), baseQuantity: d(line.baseQuantity) })),
  };
}

export type OrderHead = { id: string; number: string; status: PurchaseOrderStatus; date: string; expectedOn: string | null; supplierId: string; supplierName: string; warehouseId: string; warehouseName: string };

/** One submitted (or cancelled) order as whoever receives against it sees it: no cost. Null for a draft, or one this member may not receive against. */
export async function selectOrderHead(tx: Tx, orderId: string): Promise<OrderHead | null> {
  const [row] = await tx.execute<{ id: string; number: string; status: PurchaseOrderStatus; order_date: string; expected_on: string | null; supplier_id: string; supplier_name: string; warehouse_id: string; warehouse_name: string }>(sql`
    select id, number, status, order_date::text, expected_on::text, supplier_id, supplier_name, warehouse_id, warehouse_name from app.order_to_receive(${orderId}::uuid)`);
  if (!row) return null;
  return { id: row.id, number: row.number, status: row.status, date: row.order_date, expectedOn: row.expected_on, supplierId: row.supplier_id, supplierName: row.supplier_name, warehouseId: row.warehouse_id, warehouseName: row.warehouse_name };
}

/** One goods received note for its own page, with its order and what has arrived of each of the order's lines. */
export async function getReceipt(ctx: TenantContext, id: string): Promise<(GoodsReceipt & { order: OrderHead | null; toReceive: OrderLineToReceive[] }) | null> {
  requireReceiptAccess(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const receipt = await selectReceipt(tx, ctx.tenantId, id);
    if (!receipt) return null;
    const [toReceive, order] = await Promise.all([selectLinesToReceive(tx, receipt.orderId), selectOrderHead(tx, receipt.orderId)]);
    return { ...receipt, order, toReceive };
  });
}

/** What the page that starts a goods received note needs: the order, what is left of it, and the draft already waiting for it, if any. */
export async function getOrderToReceive(ctx: TenantContext, orderId: string): Promise<{ order: OrderHead; toReceive: OrderLineToReceive[]; draftId: string | null } | null> {
  requireReceiptAccess(ctx);
  if (!isUuid(orderId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const order = await selectOrderHead(tx, orderId);
    if (!order || order.status !== "submitted") return null;
    const [toReceive, receipts] = await Promise.all([selectLinesToReceive(tx, orderId), selectReceiptsOf(tx, ctx.tenantId, orderId)]);
    return { order, toReceive, draftId: receipts.find((receipt) => receipt.status === "draft")?.id ?? null };
  });
}

export type ReceiptRow = { id: string; status: GoodsReceiptStatus; number: string | null; date: string; supplierName: string; warehouseName: string; lines: number };

/** The newest goods received notes. */
export async function listReceipts(ctx: TenantContext): Promise<{ rows: ReceiptRow[]; more: boolean }> {
  requireReceiptAccess(ctx);
  const found = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<{ id: string; status: GoodsReceiptStatus; number: string | null; receipt_date: string; supplier_name: string; warehouse_name: string; lines: number }>(sql`
      select r.id, r.status, r.number, r.receipt_date::text, s.name as supplier_name, w.name as warehouse_name,
             (select count(*)::int from goods_receipt_lines l where l.tenant_id = r.tenant_id and l.receipt_id = r.id) as lines
      from goods_receipts r
      join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
      join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
      where r.tenant_id = ${ctx.tenantId}::uuid
      order by r.receipt_date desc, r.created_at desc
      limit ${PURCHASE_LIST_LIMIT + 1}`),
  );
  return {
    more: found.length > PURCHASE_LIST_LIMIT,
    rows: found.slice(0, PURCHASE_LIST_LIMIT).map((row) => ({ id: row.id, status: row.status, number: row.number, date: row.receipt_date, supplierName: row.supplier_name, warehouseName: row.warehouse_name, lines: row.lines })),
  };
}

// ── What an order is written from ───────────────────────────────────────────────────────────────

export type Choice = { id: string; label: string };

/** An item an order can name: its code and name, and the units it can be ordered in, its own first. */
export type ItemChoice = { id: string; code: string; name: string; units: { id: string; code: string; factor: string }[] };

/** The suppliers, warehouses and items an order can name: those in use, and the ones this member sees. */
export async function getOrderChoices(ctx: TenantContext): Promise<{ suppliers: Choice[]; warehouses: Choice[]; items: ItemChoice[] }> {
  requireOrderAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [supplierRows, warehouseRows, itemRows, unitRows] = await Promise.all([
      tx.select({ id: suppliers.id, name: suppliers.name, code: suppliers.code }).from(suppliers).where(and(eq(suppliers.tenantId, ctx.tenantId), isNull(suppliers.archivedAt))).orderBy(asc(sql`lower(${suppliers.name})`)).limit(1000),
      tx.select({ id: warehouses.id, name: warehouses.name }).from(warehouses).where(eq(warehouses.tenantId, ctx.tenantId)).orderBy(asc(warehouses.createdAt)),
      tx
        .select({ id: items.id, code: items.code, name: items.name, unitId: items.baseUnitId, unitCode: units.code })
        .from(items)
        .innerJoin(units, and(eq(units.tenantId, items.tenantId), eq(units.id, items.baseUnitId)))
        .where(and(eq(items.tenantId, ctx.tenantId), isNull(items.archivedAt)))
        .orderBy(asc(sql`lower(${items.code})`))
        .limit(2000),
      tx
        .select({ itemId: itemUnits.itemId, unitId: itemUnits.unitId, unitCode: units.code, factor: itemUnits.factor })
        .from(itemUnits)
        .innerJoin(units, and(eq(units.tenantId, itemUnits.tenantId), eq(units.id, itemUnits.unitId)))
        .where(eq(itemUnits.tenantId, ctx.tenantId))
        .orderBy(asc(sql`lower(${units.code})`)),
    ]);
    const larger = new Map<string, { id: string; code: string; factor: string }[]>();
    for (const row of unitRows) larger.set(row.itemId, [...(larger.get(row.itemId) ?? []), { id: row.unitId, code: row.unitCode, factor: new Decimal(row.factor).toFixed() }]);
    return {
      suppliers: supplierRows.map((row) => ({ id: row.id, label: row.code ? `${row.name} (${row.code})` : row.name })),
      warehouses: warehouseRows.map((row) => ({ id: row.id, label: row.name })),
      items: itemRows.map((row) => ({ id: row.id, code: row.code, name: row.name, units: [{ id: row.unitId, code: row.unitCode, factor: "1" }, ...(larger.get(row.id) ?? []).filter((unit) => unit.id !== row.unitId)] })),
    };
  });
}

/** The items of an order's lines with their units, inside a transaction the caller holds. */
export async function selectOrderItems(tx: Tx, tenantId: string, itemIds: readonly string[]): Promise<Map<string, OrderItem>> {
  const ids = [...new Set(itemIds)].filter(isUuid);
  if (ids.length === 0) return new Map();
  const [itemRows, conversionRows] = await Promise.all([
    tx.select({ id: items.id, code: items.code, name: items.name, archivedAt: items.archivedAt, baseUnitId: items.baseUnitId }).from(items).where(and(eq(items.tenantId, tenantId), inArray(items.id, ids))),
    tx.select({ itemId: itemUnits.itemId, unitId: itemUnits.unitId, factor: itemUnits.factor }).from(itemUnits).where(and(eq(itemUnits.tenantId, tenantId), inArray(itemUnits.itemId, ids))),
  ]);
  return new Map(
    itemRows.map((row) => [
      row.id,
      { id: row.id, code: row.code, name: row.name, archived: row.archivedAt !== null, baseUnitId: row.baseUnitId, conversions: conversionRows.filter((c) => c.itemId === row.id).map((c) => ({ unitId: c.unitId, factor: new Decimal(c.factor) })) },
    ]),
  );
}

// ── Goods received, not yet billed ──────────────────────────────────────────────────────────────

export type GrniRow = { receiptId: string; receiptNumber: string; date: string; supplierName: string; orderNumber: string; itemCode: string; description: string; unitCode: string; quantity: Decimal; value: Decimal };

/**
 * Goods that have arrived and have not been billed, at what they cost: every line of every
 * posted goods received note, less what posted supplier bills have billed of it and what was
 * sent back to the supplier unbilled, with what the books hold in Goods received not invoiced
 * to set beside the total.
 */
export async function getGrni(ctx: TenantContext): Promise<{ rows: GrniRow[]; total: Decimal; ledger: Decimal }> {
  requireOrderAccess(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [rows, [ledger]] = await Promise.all([
      tx.execute<{ receipt_id: string; receipt_number: string; receipt_date: string; supplier_name: string; order_number: string; item_code: string; description: string; unit_code: string; quantity: string; value: string }>(sql`
        select r.id as receipt_id, r.number as receipt_number, r.receipt_date::text, s.name as supplier_name, o.number as order_number,
               i.code as item_code, ol.description, u.code as unit_code, (l.quantity - billed.quantity - back.quantity)::text as quantity, (m.value - billed.value - back.value)::text as value
        from goods_receipts r
        join goods_receipt_lines l on l.tenant_id = r.tenant_id and l.receipt_id = r.id
        join purchase_orders o on o.tenant_id = r.tenant_id and o.id = r.order_id
        join purchase_order_lines ol on ol.tenant_id = l.tenant_id and ol.id = l.order_line_id
        join suppliers s on s.tenant_id = r.tenant_id and s.id = r.supplier_id
        join items i on i.tenant_id = l.tenant_id and i.id = l.item_id
        join units u on u.tenant_id = ol.tenant_id and u.id = ol.unit_id
        join stock_moves m on m.tenant_id = l.tenant_id and m.source_type = 'goods_receipt' and m.source_id = r.id and m.source_line_id = l.id
        -- What posted supplier bills (Step 25) have billed of the line, and cleared of its value.
        cross join lateral (
          select coalesce(sum(bl.quantity), 0) as quantity, coalesce(sum(bl.received_value), 0) as value
          from supplier_bill_lines bl join supplier_bills b on b.tenant_id = bl.tenant_id and b.id = bl.bill_id
          where bl.tenant_id = l.tenant_id and bl.receipt_line_id = l.id and b.status = 'posted') billed
        -- What went back to the supplier before it was billed (Step 27), and what that took off the account.
        cross join lateral (
          select coalesce(sum(x.quantity), 0) as quantity, coalesce(sum(x.grni_value), 0) as value
          from supplier_return_lines x join supplier_returns d on d.tenant_id = x.tenant_id and d.id = x.return_id
          where x.tenant_id = l.tenant_id and x.receipt_line_id = l.id and x.bill_line_id is null and d.status = 'posted') back
        where r.tenant_id = ${ctx.tenantId}::uuid and r.status = 'posted' and l.quantity > billed.quantity + back.quantity
        order by r.receipt_date, r.number, l.line_no`),
      tx.execute<{ balance: string }>(sql`
        select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
        from journal_lines jl join accounts a on a.tenant_id = jl.tenant_id and a.id = jl.account_id
        where jl.tenant_id = ${ctx.tenantId}::uuid and a.is_control and a.control_type = 'grni'`),
    ]);
    const list = rows.map((row) => ({ receiptId: row.receipt_id, receiptNumber: row.receipt_number, date: row.receipt_date, supplierName: row.supplier_name, orderNumber: row.order_number, itemCode: row.item_code, description: row.description, unitCode: row.unit_code, quantity: d(row.quantity), value: d(row.value) }));
    return { rows: list, total: list.reduce((sum, row) => sum.plus(row.value), new Decimal(0)), ledger: d(ledger?.balance ?? "0") };
  });
}
