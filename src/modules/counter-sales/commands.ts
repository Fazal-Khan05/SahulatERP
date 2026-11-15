import "server-only";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { postReceiptIn, receiptRefusal, saveReceiptDraftIn } from "@/modules/receipts/commands";
import { receipts } from "@/modules/receipts/schema";
import { invoiceRefusal, postInvoiceIn, saveSalesDraftIn, startInvoiceIn, submitIn, submitRefusal } from "@/modules/sales/commands";
import { salesDocuments } from "@/modules/sales/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { readCounterSale, type RawCounterSale } from "./rules";
import { counterSales } from "./schema";

// Step 22: a sale at the counter to a walk-in buyer, who pays at once. One transaction makes the
// order, its invoice (which takes the goods out of stock and puts the sale in the books) and the
// receipt that pays the invoice in full, each through the same code that makes it anywhere else;
// if any of them is refused, none of them is made.

export function requireCounter(ctx: TenantContext): void {
  if (!can(ctx.role, "counter_sale.manage")) throw new UserError("Only the owner or an accountant sells at the counter: it takes the money as it sells.");
}

export type CounterSaleResult = { invoiceId: string; invoiceNumber: string; receiptNumber: string; total: string };

/** What the database's refusals of a counter sale mean, whichever of the three documents it was making. */
function counterRefusal(error: unknown, date: string): unknown {
  if (error instanceof UserError) return error;
  const code = pgCode(error);
  if (code === "SE052") return new UserError("The walk-in customer cannot be sold to as it stands. Check it under Customers: it is not archived, and has no credit limit.");
  if (code === "SE122" || code === "SE123" || code === "SE124") return new UserError("The walk-in customer is sold to only at the counter, and pays at once. Reload the page and try again.");
  // The tables' own checks, for what the form cannot send.
  if (code === "23514" || code === "23503") return new UserError("This sale could not be recorded as it stands. Check the buyer, the lines and the account the money went into.");
  return invoiceRefusal(error, date) ?? receiptRefusal(error, date) ?? submitRefusal(error) ?? error;
}

/** The counter sale already recorded with this key: a sale sent twice is recorded once. */
async function alreadyRecorded(ctx: TenantContext, clientKey: string): Promise<CounterSaleResult | null> {
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [found] = await tx
      .select({ invoiceId: counterSales.invoiceId, invoiceNumber: salesDocuments.number, total: salesDocuments.total, receiptNumber: receipts.number })
      .from(counterSales)
      .innerJoin(salesDocuments, and(eq(salesDocuments.tenantId, counterSales.tenantId), eq(salesDocuments.id, counterSales.invoiceId)))
      .leftJoin(receipts, and(eq(receipts.tenantId, counterSales.tenantId), eq(receipts.id, counterSales.receiptId)))
      .where(and(eq(counterSales.tenantId, ctx.tenantId), eq(counterSales.clientKey, clientKey)));
    if (!found?.invoiceId || !found.invoiceNumber) return null;
    return { invoiceId: found.invoiceId, invoiceNumber: found.invoiceNumber, receiptNumber: found.receiptNumber ?? "", total: found.total };
  });
}

export async function postCounterSale(ctx: TenantContext, raw: RawCounterSale & { clientKey?: unknown }): Promise<CounterSaleResult> {
  requireCounter(ctx);
  const read = readCounterSale(raw, todayIso(new Date()));
  if (!read.ok) throw new UserError(read.reason);
  const { order, buyer, payment } = read.sale;
  const clientKey = isUuid(raw.clientKey) ? raw.clientKey : randomUUID();
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [walkIn] = await tx.execute<{ id: string }>(sql`select app.walk_in_customer() as id`);
      // The goods: an order to the walk-in customer, worked out as any order is.
      const draft = await saveSalesDraftIn(tx, ctx, null, { ...order, customerId: walkIn.id });
      // Written column by column: the app may name the order and the buyer, and nothing else.
      await tx.execute(sql`
        insert into public.counter_sales (tenant_id, order_id, buyer_name, buyer_phone, client_key, created_by)
        values (${ctx.tenantId}, ${draft.id}, ${buyer.name}, ${buyer.phone}, ${clientKey}, ${ctx.userId})`);
      const submitted = await submitIn(tx, ctx, draft.id, undefined, {});
      if (submitted.status !== "submitted") throw new UserError("The walk-in customer has a credit limit, so a counter sale would wait for approval. Clear its credit limit on the customer's page.");
      // Billed at once, on the sale's own date: the invoice takes the goods out of stock as it posts.
      const invoice = await startInvoiceIn(tx, ctx, draft.id, order.date);
      await tx.update(counterSales).set({ invoiceId: invoice.id }).where(and(eq(counterSales.tenantId, ctx.tenantId), eq(counterSales.orderId, draft.id)));
      const posted = await postInvoiceIn(tx, ctx, invoice.id);
      const [{ total, branchId }] = await tx
        .select({ total: salesDocuments.total, branchId: salesDocuments.branchId })
        .from(salesDocuments)
        .where(and(eq(salesDocuments.tenantId, ctx.tenantId), eq(salesDocuments.id, invoice.id)));
      const amount = new Decimal(total);
      if (amount.lte(0)) throw new UserError("This sale comes to nothing. A counter sale is for goods the buyer pays for.");
      // The money: a receipt for the whole invoice, into the account it went into.
      const receipt = await saveReceiptDraftIn(tx, ctx, null, {
        date: order.date,
        customerId: walkIn.id,
        method: payment.method,
        accountId: payment.accountId,
        amount,
        bankCharges: new Decimal(0),
        reference: payment.reference,
        note: null,
        branchId,
        cheque: null,
        allocations: [{ kind: "invoice", id: invoice.id, amount }],
      });
      await tx.update(counterSales).set({ receiptId: receipt.id }).where(and(eq(counterSales.tenantId, ctx.tenantId), eq(counterSales.orderId, draft.id)));
      const paid = await postReceiptIn(tx, receipt.id);
      await audit(tx, ctx, {
        action: "counter_sale.post",
        entity: "sales_document",
        entityId: invoice.id,
        after: { buyer: buyer.name, order: submitted.number, invoice: posted.number, receipt: paid.number, total: total, paidBy: payment.method },
      });
      return { invoiceId: invoice.id, invoiceNumber: posted.number, receiptNumber: paid.number, total };
    });
  } catch (error) {
    // Sent twice: the first went through, and this is it.
    if (pgCode(error) === "23505") {
      const first = await alreadyRecorded(ctx, clientKey);
      if (first) return first;
    }
    throw counterRefusal(error, order.date);
  }
}
