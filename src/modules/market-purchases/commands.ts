import "server-only";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { postReceiptIn, purchaseRefusal, saveOrderDraftIn, saveReceiptDraftIn, submitOrderIn } from "@/modules/purchasing/commands";
import { selectLinesToReceive } from "@/modules/purchasing/queries";
import { goodsReceipts, purchaseOrders } from "@/modules/purchasing/schema";
import { billRefusal, postBillIn, saveBillDraftIn } from "@/modules/supplier-bills/commands";
import { selectReceiptLinesToBill } from "@/modules/supplier-bills/queries";
import { supplierBills } from "@/modules/supplier-bills/schema";
import { paymentRefusal, postPaymentIn, savePaymentDraftIn } from "@/modules/supplier-payments/commands";
import { supplierPayments } from "@/modules/supplier-payments/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { documentNote, readMarketPurchase, type RawMarketPurchase } from "./rules";
import { marketPurchases } from "./schema";

// A quick market purchase: goods bought in the market and paid for on the spot. One transaction
// makes the purchase order, the goods received note that brings the goods into stock at what
// they cost, the supplier's bill for them and the payment that settles the bill in full, each
// through the same code that makes it anywhere else; if any of them is refused, none is made.

export const ONLY_BUYERS = "Only the owner or an accountant makes a quick market purchase: it pays the seller as it buys.";

export function requireMarketPurchase(ctx: TenantContext): void {
  if (!can(ctx.role, "market_purchase.manage")) throw new UserError(ONLY_BUYERS);
}

export type MarketPurchaseResult = { id: string; orderId: string; billId: string; orderNumber: string; receiptNumber: string; billNumber: string; paymentNumber: string; total: string };

/** What the database's refusals of a quick market purchase mean, whichever of the four documents it was making. */
function marketRefusal(error: unknown, date: string): unknown {
  if (error instanceof UserError) return error;
  const code = pgCode(error);
  if (code === "SE267" || code === "SE268" || code === "SE269") return new UserError("This purchase could not be recorded as it stands. Reload the page and try again.");
  return purchaseRefusal(error, date, "purchase") ?? billRefusal(error, date) ?? paymentRefusal(error, date) ?? error;
}

/** The quick market purchase already recorded with this key: one sent twice is recorded once. */
async function alreadyRecorded(ctx: TenantContext, clientKey: string): Promise<MarketPurchaseResult | null> {
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [found] = await tx
      .select({
        id: marketPurchases.id,
        orderId: marketPurchases.orderId,
        billId: marketPurchases.billId,
        orderNumber: purchaseOrders.number,
        receiptNumber: goodsReceipts.number,
        billNumber: supplierBills.number,
        paymentNumber: supplierPayments.number,
        total: supplierBills.total,
      })
      .from(marketPurchases)
      .innerJoin(purchaseOrders, and(eq(purchaseOrders.tenantId, marketPurchases.tenantId), eq(purchaseOrders.id, marketPurchases.orderId)))
      .innerJoin(goodsReceipts, and(eq(goodsReceipts.tenantId, marketPurchases.tenantId), eq(goodsReceipts.id, marketPurchases.receiptId)))
      .innerJoin(supplierBills, and(eq(supplierBills.tenantId, marketPurchases.tenantId), eq(supplierBills.id, marketPurchases.billId)))
      .innerJoin(supplierPayments, and(eq(supplierPayments.tenantId, marketPurchases.tenantId), eq(supplierPayments.id, marketPurchases.paymentId)))
      .where(and(eq(marketPurchases.tenantId, ctx.tenantId), eq(marketPurchases.clientKey, clientKey)));
    if (!found?.billId || !found.orderNumber || !found.receiptNumber || !found.billNumber || !found.paymentNumber) return null;
    return { id: found.id, orderId: found.orderId, billId: found.billId, orderNumber: found.orderNumber, receiptNumber: found.receiptNumber, billNumber: found.billNumber, paymentNumber: found.paymentNumber, total: found.total };
  });
}

export async function postMarketPurchase(ctx: TenantContext, raw: RawMarketPurchase & { clientKey?: unknown }): Promise<MarketPurchaseResult> {
  requireMarketPurchase(ctx);
  const read = readMarketPurchase(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  const purchase = read.purchase;
  const { date, payment } = purchase;
  const clientKey = isUuid(raw.clientKey) ? raw.clientKey : randomUUID();
  const note = documentNote(purchase);
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      // The warehouse says which branch the bill and the payment belong to. One outside the member's branches is not found.
      if (!isUuid(purchase.warehouseId)) throw new UserError("Choose the warehouse from your own warehouses.");
      const [warehouse] = await tx.execute<{ branch_id: string }>(sql`select branch_id from warehouses where tenant_id = ${ctx.tenantId}::uuid and id = ${purchase.warehouseId}::uuid`);
      if (!warehouse) throw new UserError("Choose the warehouse from your own warehouses.");
      // The money leaves an account of the kind chosen: cash, or a bank account.
      if (!isUuid(payment.accountId)) throw new UserError("Choose the cash or bank account from the list.");
      const [account] = await tx.execute<{ id: string }>(sql`
        select id from accounts
        where tenant_id = ${ctx.tenantId}::uuid and id = ${payment.accountId}::uuid and control_type = ${payment.method} and not is_group and archived_at is null`);
      if (!account) throw new UserError(payment.method === "cash" ? "Choose the cash account the money came out of from the list." : "Choose the bank account the money came out of from the list.");

      // The seller: a supplier on the list, or the company's market supplier for one who is not.
      let supplierId: string;
      if (purchase.seller.kind === "market") {
        const [market] = await tx.execute<{ id: string }>(sql`select app.market_supplier() as id`);
        supplierId = market.id;
      } else {
        supplierId = purchase.seller.supplierId;
        if (!isUuid(supplierId)) throw new UserError("Choose the supplier from the list.");
        const [market] = await tx.execute<{ id: string }>(sql`select supplier_id as id from market_suppliers where tenant_id = ${ctx.tenantId}::uuid and supplier_id = ${supplierId}::uuid`);
        if (market) throw new UserError('For a seller who is not on your list, choose "A seller in the market" and type their name.');
      }

      // The goods, as an order: worked out as any purchase order is.
      const order = await saveOrderDraftIn(tx, ctx, null, { date, supplierId, warehouseId: purchase.warehouseId, expectedOn: null, supplierReference: purchase.memoNo, note, lines: purchase.lines });
      // Written column by column: the app may name the order and the seller, and nothing else.
      const [row] = await tx.execute<{ id: string }>(sql`
        insert into public.market_purchases (tenant_id, order_id, seller_name, seller_phone, memo_no, client_key, created_by)
        values (${ctx.tenantId}, ${order.id}, ${purchase.seller.kind === "market" ? purchase.seller.name : null}, ${purchase.seller.kind === "market" ? purchase.seller.phone : null}, ${purchase.memoNo}, ${clientKey}, ${ctx.userId})
        returning id`);
      const mine = and(eq(marketPurchases.tenantId, ctx.tenantId), eq(marketPurchases.id, row.id));
      const submitted = await submitOrderIn(tx, ctx, order.id);

      // All of it arrived: the goods come into the warehouse at the order's cost.
      const toReceive = await selectLinesToReceive(tx, order.id);
      const receipt = await saveReceiptDraftIn(tx, ctx, null, order.id, { date, supplierDeliveryNote: purchase.memoNo, note, lines: toReceive.map((line) => ({ orderLineId: line.lineId, quantity: line.ordered })) });
      await tx.update(marketPurchases).set({ receiptId: receipt.id }).where(mine);
      const received = await postReceiptIn(tx, ctx, receipt.id);

      // The bill: exactly those goods at the order's cost. No input tax and nothing withheld (rules.ts says why).
      const toBill = (await selectReceiptLinesToBill(tx, ctx.tenantId, supplierId, warehouse.branch_id)).filter((line) => line.receiptNumber === received.number);
      if (toBill.length !== toReceive.length) throw new UserError("This purchase could not be recorded as it stands. Reload the page and try again.");
      const bill = await saveBillDraftIn(tx, ctx, null, {
        date,
        supplierId,
        branchId: warehouse.branch_id,
        // The seller's own number where they gave one and are on the list; otherwise the order's, which no other bill has.
        supplierInvoiceNo: purchase.seller.kind === "supplier" && purchase.memoNo ? purchase.memoNo : submitted.number,
        dueDate: null,
        note,
        incomeTaxCode: null,
        salesTaxCode: null,
        provincialTaxCode: null,
        goods: toBill.map((line) => ({ receiptLineId: line.receiptLineId, quantity: line.received, unitPrice: line.orderCost, taxCategoryId: null })),
        expenses: [],
      });
      await tx.update(marketPurchases).set({ billId: bill.id }).where(mine);
      const billed = await postBillIn(tx, ctx, bill.id);
      const [{ total }] = await tx.select({ total: supplierBills.total }).from(supplierBills).where(and(eq(supplierBills.tenantId, ctx.tenantId), eq(supplierBills.id, bill.id)));
      const amount = new Decimal(total);
      if (amount.lte(0)) throw new UserError("This purchase comes to nothing. A quick market purchase is for goods that were paid for.");

      // The money: a payment for the whole bill, out of the account it left.
      const paid = await savePaymentDraftIn(tx, ctx, null, { date, supplierId, branchId: warehouse.branch_id, accountId: payment.accountId, reference: payment.reference, note, amount, foreign: null, allocations: [{ billId: bill.id, amount }] });
      await tx.update(marketPurchases).set({ paymentId: paid.id }).where(mine);
      const payed = await postPaymentIn(tx, ctx, paid.id);

      await audit(tx, ctx, {
        action: "market_purchase.post",
        entity: "market_purchase",
        entityId: row.id,
        after: {
          seller: purchase.seller.kind === "market" ? purchase.seller.name : null,
          onTheList: purchase.seller.kind === "supplier",
          order: submitted.number,
          goodsReceived: received.number,
          bill: billed.number,
          payment: payed.number,
          total,
          paidBy: payment.method,
        },
      });
      return { id: row.id, orderId: order.id, billId: bill.id, orderNumber: submitted.number, receiptNumber: received.number, billNumber: billed.number, paymentNumber: payed.number, total };
    });
  } catch (error) {
    // Sent twice: the first went through, and this is it.
    if (pgCode(error) === "23505") {
      const first = await alreadyRecorded(ctx, clientKey);
      if (first) return first;
    }
    throw marketRefusal(error, date);
  }
}
