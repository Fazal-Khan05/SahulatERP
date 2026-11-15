import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { FACTOR_SCALE, QUANTITY_SCALE } from "@/modules/items/rules";
import { periodRefusal } from "@/modules/numbering/rules";
import { suppliers } from "@/modules/parties/schema";
import { can, type Permission, type TenantContext } from "@/modules/tenant/rules";
import { warehouses } from "@/modules/warehouses/schema";
import { selectLinesToReceive, selectOrder, selectOrderHead, selectOrderItems, selectReceipt, type GoodsReceipt, type PurchaseOrder } from "./queries";
import { UNIT_COST_SCALE, costLine, orderTotal, readOrder, readReceipt, receiptLines, type CostedLine, type OrderDraft, type RawOrder, type RawReceipt, type ReceiptDraft } from "./rules";
import { goodsReceiptLines, goodsReceipts, purchaseOrderLines, purchaseOrders } from "./schema";

// The commands behind the buying screens. A draft is written here, by the app, under row-level
// security. Submitting an order, cancelling it and posting goods received are not: each command
// only asks the database's own function, which takes the number, moves the stock and posts the
// journal in the same transaction, or refuses.

function requirePermission(ctx: TenantContext, permission: Permission, refusal: string): void {
  if (!can(ctx.role, permission)) throw new UserError(refusal);
}

const ONLY_BOOKS = "Only an owner or an accountant can write purchase orders.";
const ONLY_RECEIVERS = "Only an owner, an accountant or the warehouse can receive goods.";
const ORDER_GONE = "That purchase order is not in this company.";
const RECEIPT_GONE = "That goods received note is not in this company.";
const ORDER_CLOSED = "That order is not open for receiving goods. It may have been cancelled; reload the page.";

/** A screen opened before someone else's change must not act on what it no longer shows. */
function requireFresh(updatedAt: Date, loadedAt: unknown, what: string): void {
  const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
  if (typeof loaded === "string" && loaded !== "" && loaded !== updatedAt.toISOString()) {
    throw new UserError(`Someone changed this ${what} after you opened it. Reload the page and try again.`);
  }
}

const isNew = (id: unknown) => id === null || id === undefined || id === "";
const dmy = (date: string) => date.split("-").reverse().join("-");

/** What to tell someone whose purchase document the database refused, or null for anything unexpected. */
function purchaseRefusal(error: unknown, date: string, what: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE064") return new UserError("The chart of accounts has no stock account, or no account for goods received and not yet billed. Set the company up first.");
  if (code === "SE211") return new UserError(what === "purchase order" ? ORDER_GONE : RECEIPT_GONE);
  if (code === "SE215") return new UserError("Add at least one item to the order, save it, then submit it.");
  if (code === "SE216") return new UserError("More has been entered than is left of the order. Someone may have received goods against it since you opened this page; reload it and check the quantities.");
  if (code === "SE217") return new UserError(what === "purchase order" ? ORDER_CLOSED : "Goods are received against a submitted order, on or after the day it was ordered. Check the date, or reload the page: the order may have been cancelled.");
  if (code === "SE218") return new UserError("Goods have been received against this order, or a goods received note is waiting as a draft, so it cannot be cancelled. Throw the draft away first; an order with goods received stays.");
  if (code === "SE220") return new UserError("That date has not come yet.");
  if (code === "SE221") return new UserError("The supplier is archived. Restore the supplier before submitting the order.");
  if (code === "23505") return new UserError("A goods received note for this order is already waiting as a draft. Open that one.");
  if (code === "42501") return new UserError("Your role cannot do that.");
  if (code === "SE212" || code === "SE213" || code === "SE214" || code === "SE219" || code === "23514") {
    return new UserError(`This ${what} could not be saved as it stands. Reload the page and try again.`);
  }
  return null;
}

// ── purchase orders ─────────────────────────────────────────────────────────────────────────────

async function lockOrder(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<PurchaseOrder> {
  if (!isUuid(id)) throw new UserError(ORDER_GONE);
  const order = await selectOrder(tx, ctx.tenantId, id, true);
  if (!order) throw new UserError(ORDER_GONE);
  requireFresh(order.updatedAt, loadedAt, "order");
  return order;
}

const describeOrder = (
  head: { date: string; expectedOn: string | null; supplierReference: string | null; note: string | null },
  supplier: string,
  warehouse: string,
  lines: readonly { code: string; quantity: string; unitCost: string }[],
  total: string,
) => ({ date: head.date, supplier, warehouse, expectedOn: head.expectedOn, supplierReference: head.supplierReference, note: head.note, total, lines });

const describeStored = (order: PurchaseOrder) =>
  describeOrder(
    order,
    order.supplierName,
    order.warehouseName,
    order.lines.map((line) => ({ code: line.itemCode, quantity: line.quantity.toFixed(), unitCost: line.unitCost.toFixed() })),
    order.total.toFixed(2),
  );

/** The lines of an order worked out against its items: each in one of its item's units, costed to the paisa. */
async function costOrder(tx: Tx, ctx: TenantContext, draft: OrderDraft): Promise<{ lines: CostedLine[]; codes: string[] }> {
  const found = await selectOrderItems(
    tx,
    ctx.tenantId,
    draft.lines.map((line) => line.itemId),
  );
  const lines: CostedLine[] = [];
  const codes: string[] = [];
  draft.lines.forEach((line, index) => {
    const item = found.get(line.itemId);
    if (!item) throw new UserError(`Line ${index + 1}: choose an item from the list.`);
    const costed = costLine(line, item);
    if (!costed.ok) throw new UserError(`Line ${index + 1}: ${costed.reason}`);
    lines.push(costed.line);
    codes.push(item.code);
  });
  return { lines, codes };
}

/** Saves a purchase order as a draft: a new one, or an existing draft with its lines replaced. */
export async function saveOrderDraft(ctx: TenantContext, id: unknown, raw: RawOrder, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requirePermission(ctx, "purchase_order.manage", ONLY_BOOKS);
  const read = readOrder(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.order;
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      if (!isUuid(draft.supplierId)) throw new UserError("Choose the supplier from the list.");
      const [supplier] = await tx.select({ name: suppliers.name, archivedAt: suppliers.archivedAt }).from(suppliers).where(and(eq(suppliers.tenantId, ctx.tenantId), eq(suppliers.id, draft.supplierId)));
      if (!supplier) throw new UserError("Choose the supplier from the list.");
      if (supplier.archivedAt) throw new UserError(`${supplier.name} is archived. Restore the supplier before ordering from them.`);
      if (!isUuid(draft.warehouseId)) throw new UserError("Choose the warehouse from your own warehouses.");
      const [warehouse] = await tx.select({ name: warehouses.name }).from(warehouses).where(and(eq(warehouses.tenantId, ctx.tenantId), eq(warehouses.id, draft.warehouseId)));
      if (!warehouse) throw new UserError("Choose the warehouse from your own warehouses.");
      const { lines, codes } = await costOrder(tx, ctx, draft);
      const total = orderTotal(lines);
      const values = {
        orderDate: draft.date,
        supplierId: draft.supplierId,
        warehouseId: draft.warehouseId,
        expectedOn: draft.expectedOn,
        supplierReference: draft.supplierReference,
        note: draft.note,
        total: total.toFixed(2),
        updatedBy: ctx.userId,
      };
      let saved: { id: string; updatedAt: Date };
      let before: unknown = null;
      if (isNew(id)) {
        [saved] = await tx
          .insert(purchaseOrders)
          .values({ tenantId: ctx.tenantId, createdBy: ctx.userId, ...values })
          .returning({ id: purchaseOrders.id, updatedAt: purchaseOrders.updatedAt });
      } else {
        const stored = await lockOrder(tx, ctx, id, loadedAt);
        if (stored.status !== "draft") throw new UserError("This order is submitted and cannot be changed. Cancel it and write a new one.");
        before = describeStored(stored);
        await tx.delete(purchaseOrderLines).where(and(eq(purchaseOrderLines.tenantId, ctx.tenantId), eq(purchaseOrderLines.orderId, stored.id)));
        [saved] = await tx
          .update(purchaseOrders)
          .set({ ...values, updatedAt: sql`now()` })
          .where(and(eq(purchaseOrders.tenantId, ctx.tenantId), eq(purchaseOrders.id, stored.id)))
          .returning({ id: purchaseOrders.id, updatedAt: purchaseOrders.updatedAt });
      }
      if (lines.length > 0) {
        await tx.insert(purchaseOrderLines).values(
          lines.map((line, index) => ({
            tenantId: ctx.tenantId,
            orderId: saved.id,
            lineNo: index + 1,
            itemId: line.itemId,
            description: line.description,
            unitId: line.unitId,
            unitFactor: line.unitFactor.toFixed(FACTOR_SCALE),
            quantity: line.quantity.toFixed(QUANTITY_SCALE),
            baseQuantity: line.baseQuantity.toFixed(QUANTITY_SCALE),
            unitCost: line.unitCost.toFixed(UNIT_COST_SCALE),
            amount: line.amount.toFixed(2),
            createdBy: ctx.userId,
          })),
        );
      }
      await audit(tx, ctx, {
        action: before === null ? "purchase_order.create" : "purchase_order.update",
        entity: "purchase_order",
        entityId: saved.id,
        before,
        after: describeOrder(
          draft,
          supplier.name,
          warehouse.name,
          lines.map((line, index) => ({ code: codes[index], quantity: line.quantity.toFixed(), unitCost: line.unitCost.toFixed() })),
          total.toFixed(2),
        ),
      });
      return saved;
    });
  } catch (error) {
    throw purchaseRefusal(error, draft.date, "purchase order") ?? error;
  }
}

/** Throws a draft order away. A submitted one is never removed; it is cancelled. */
export async function discardOrder(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "purchase_order.manage", ONLY_BOOKS);
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await lockOrder(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("This order is submitted and cannot be removed. Cancel it instead.");
    await tx.delete(purchaseOrderLines).where(and(eq(purchaseOrderLines.tenantId, ctx.tenantId), eq(purchaseOrderLines.orderId, stored.id)));
    await tx.delete(purchaseOrders).where(and(eq(purchaseOrders.tenantId, ctx.tenantId), eq(purchaseOrders.id, stored.id)));
    await audit(tx, ctx, { action: "purchase_order.discard", entity: "purchase_order", entityId: stored.id, before: describeStored(stored), after: null });
  });
}

/** Submits a draft order: it takes its PO number and can be received against. Nothing reaches the books or the stock. */
export async function submitOrder(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string }> {
  requirePermission(ctx, "purchase_order.manage", ONLY_BOOKS);
  let date = "";
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockOrder(tx, ctx, id, loadedAt);
      if (stored.status !== "draft") throw new UserError("This order is already submitted.");
      if (stored.lines.length === 0) throw new UserError("Add at least one item to the order before submitting it.");
      date = stored.date;
      const [row] = await tx.execute<{ number: string }>(sql`select app.submit_purchase_order(${stored.id}::uuid) as number`);
      return { number: row.number };
    });
  } catch (error) {
    throw purchaseRefusal(error, date, "purchase order") ?? error;
  }
}

/** Cancels a submitted order that nothing has been received against, with a reason. */
export async function cancelOrder(ctx: TenantContext, id: unknown, reason: unknown, loadedAt?: unknown): Promise<void> {
  requirePermission(ctx, "purchase_order.manage", ONLY_BOOKS);
  const why = typeof reason === "string" ? reason.trim().replace(/\s+/g, " ") : "";
  if (why.length < 3) throw new UserError("Say why the order is cancelled, in a few words.");
  if (why.length > 300) throw new UserError("The reason: use at most 300 characters.");
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockOrder(tx, ctx, id, loadedAt);
      if (stored.status === "cancelled") throw new UserError("This order is already cancelled.");
      if (stored.status !== "submitted") throw new UserError("A draft is thrown away, not cancelled.");
      await tx.execute(sql`select app.cancel_purchase_order(${stored.id}::uuid, ${why})`);
    });
  } catch (error) {
    throw purchaseRefusal(error, "", "purchase order") ?? error;
  }
}

// ── goods received ──────────────────────────────────────────────────────────────────────────────

async function lockReceipt(tx: Tx, ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<GoodsReceipt> {
  if (!isUuid(id)) throw new UserError(RECEIPT_GONE);
  const receipt = await selectReceipt(tx, ctx.tenantId, id, true);
  if (!receipt) throw new UserError(RECEIPT_GONE);
  requireFresh(receipt.updatedAt, loadedAt, "goods received note");
  return receipt;
}

const describeReceipt = (head: Pick<ReceiptDraft, "date" | "supplierDeliveryNote" | "note">, order: string, supplier: string, warehouse: string, lines: readonly { code: string; quantity: string }[]) => ({
  date: head.date,
  order,
  supplier,
  warehouse,
  supplierDeliveryNote: head.supplierDeliveryNote,
  note: head.note,
  lines,
});

/**
 * Saves goods received against a submitted order as a draft: a new one (`id` empty, `orderId`
 * the order), or an existing draft with its lines replaced. Each line is a line of the order,
 * for no more than is still to arrive.
 */
export async function saveReceiptDraft(ctx: TenantContext, id: unknown, orderId: unknown, raw: RawReceipt, loadedAt?: unknown): Promise<{ id: string; updatedAt: Date }> {
  requirePermission(ctx, "goods_receipt.manage", ONLY_RECEIVERS);
  const read = readReceipt(raw);
  if (!read.ok) throw new UserError(read.reason);
  const draft = read.receipt;
  if (draft.date > todayIso(new Date())) throw new UserError("Goods cannot be received on a day that has not come yet.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = isNew(id) ? null : await lockReceipt(tx, ctx, id, loadedAt);
      if (stored && stored.status !== "draft") throw new UserError("These goods received are posted and cannot be changed.");
      const of = stored ? stored.orderId : orderId;
      if (!isUuid(of)) throw new UserError(ORDER_CLOSED);
      const order = await selectOrderHead(tx, of);
      if (!order || order.status !== "submitted") throw new UserError(ORDER_CLOSED);
      if (draft.date < order.date) throw new UserError(`The order is dated ${dmy(order.date)}. Goods cannot arrive before they were ordered.`);
      const worked = receiptLines(await selectLinesToReceive(tx, order.id), draft.lines);
      if (!worked.ok) throw new UserError(worked.reason);
      const values = { receiptDate: draft.date, supplierDeliveryNote: draft.supplierDeliveryNote, note: draft.note, updatedBy: ctx.userId };
      let saved: { id: string; updatedAt: Date };
      let before: unknown = null;
      if (!stored) {
        [saved] = await tx
          .insert(goodsReceipts)
          .values({ tenantId: ctx.tenantId, orderId: order.id, supplierId: order.supplierId, warehouseId: order.warehouseId, createdBy: ctx.userId, ...values })
          .returning({ id: goodsReceipts.id, updatedAt: goodsReceipts.updatedAt });
      } else {
        before = describeReceipt(stored, order.number, stored.supplierName, stored.warehouseName, stored.lines.map((line) => ({ code: line.itemCode, quantity: line.quantity.toFixed() })));
        await tx.delete(goodsReceiptLines).where(and(eq(goodsReceiptLines.tenantId, ctx.tenantId), eq(goodsReceiptLines.receiptId, stored.id)));
        [saved] = await tx
          .update(goodsReceipts)
          .set({ ...values, updatedAt: sql`now()` })
          .where(and(eq(goodsReceipts.tenantId, ctx.tenantId), eq(goodsReceipts.id, stored.id)))
          .returning({ id: goodsReceipts.id, updatedAt: goodsReceipts.updatedAt });
      }
      if (worked.lines.length > 0) {
        await tx.insert(goodsReceiptLines).values(
          worked.lines.map((line, index) => ({
            tenantId: ctx.tenantId,
            receiptId: saved.id,
            lineNo: index + 1,
            orderLineId: line.orderLineId,
            itemId: line.itemId,
            unitFactor: line.unitFactor.toFixed(FACTOR_SCALE),
            quantity: line.quantity.toFixed(QUANTITY_SCALE),
            baseQuantity: line.baseQuantity.toFixed(QUANTITY_SCALE),
            createdBy: ctx.userId,
          })),
        );
      }
      await audit(tx, ctx, {
        action: before === null ? "goods_receipt.create" : "goods_receipt.update",
        entity: "goods_receipt",
        entityId: saved.id,
        before,
        after: describeReceipt(draft, order.number, order.supplierName, order.warehouseName, worked.lines.map((line) => ({ code: line.itemCode, quantity: line.quantity.toFixed() }))),
      });
      return saved;
    });
  } catch (error) {
    throw purchaseRefusal(error, draft.date, "goods received note") ?? error;
  }
}

/** Throws a draft of goods received away. A posted one is never removed. */
export async function discardReceipt(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ orderId: string }> {
  requirePermission(ctx, "goods_receipt.manage", ONLY_RECEIVERS);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const stored = await lockReceipt(tx, ctx, id, loadedAt);
    if (stored.status !== "draft") throw new UserError("These goods received are posted and cannot be removed.");
    const order = await selectOrderHead(tx, stored.orderId);
    await tx.delete(goodsReceiptLines).where(and(eq(goodsReceiptLines.tenantId, ctx.tenantId), eq(goodsReceiptLines.receiptId, stored.id)));
    await tx.delete(goodsReceipts).where(and(eq(goodsReceipts.tenantId, ctx.tenantId), eq(goodsReceipts.id, stored.id)));
    await audit(tx, ctx, {
      action: "goods_receipt.discard",
      entity: "goods_receipt",
      entityId: stored.id,
      before: describeReceipt(stored, order?.number ?? "", stored.supplierName, stored.warehouseName, stored.lines.map((line) => ({ code: line.itemCode, quantity: line.quantity.toFixed() }))),
      after: null,
    });
    return { orderId: stored.orderId };
  });
}

/**
 * Posts a draft of goods received: the goods come into the order's warehouse at the order's
 * cost and the journal is posted (debit Stock in trade, credit Goods received not invoiced),
 * in one transaction.
 */
export async function postReceipt(ctx: TenantContext, id: unknown, loadedAt?: unknown): Promise<{ number: string }> {
  requirePermission(ctx, "goods_receipt.manage", ONLY_RECEIVERS);
  let date = "";
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const stored = await lockReceipt(tx, ctx, id, loadedAt);
      if (stored.status !== "draft") throw new UserError("These goods received are already posted.");
      if (stored.lines.length === 0) throw new UserError("Enter how much arrived of at least one line, save, then post.");
      date = stored.date;
      const [row] = await tx.execute<{ number: string }>(sql`select app.post_goods_receipt(${stored.id}::uuid) as number`);
      return { number: row.number };
    });
  } catch (error) {
    throw purchaseRefusal(error, date, "goods received note") ?? error;
  }
}
