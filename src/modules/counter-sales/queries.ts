import "server-only";
import { and, eq, or, sql } from "drizzle-orm";
import { customers } from "@/modules/parties/schema";
import { isUuid, withTenant, type Tx } from "@/db";
import { receipts } from "@/modules/receipts/schema";
import type { TenantContext } from "@/modules/tenant/rules";
import { counterSales, walkInCustomers } from "./schema";

/** Said when the walk-in customer is chosen anywhere but at the counter. */
export const WALK_IN_AT_COUNTER = "Walk-in buyers are sold to at the counter and pay at once: open Sales invoices and choose New counter sale.";

/** For a list of customers to choose from: leaves out the walk-in customer, who is sold to only at the counter. */
export const notWalkIn = sql`not exists (select 1 from public.walk_in_customers w where w.tenant_id = ${customers.tenantId} and w.customer_id = ${customers.id})`;

/** Whether this customer is the one that stands for walk-in buyers. */
export async function isWalkInCustomer(tx: Tx, tenantId: string, customerId: unknown): Promise<boolean> {
  if (!isUuid(customerId)) return false;
  const [found] = await tx
    .select({ id: walkInCustomers.customerId })
    .from(walkInCustomers)
    .where(and(eq(walkInCustomers.tenantId, tenantId), eq(walkInCustomers.customerId, customerId)));
  return found !== undefined;
}

/** The company's walk-in customer, or null before its first counter sale. */
export async function selectWalkInCustomer(tx: Tx, tenantId: string): Promise<string | null> {
  const [found] = await tx.select({ id: walkInCustomers.customerId }).from(walkInCustomers).where(eq(walkInCustomers.tenantId, tenantId));
  return found?.id ?? null;
}

export type CounterSaleFacts = { orderId: string; invoiceId: string | null; receiptId: string | null; buyerName: string; buyerPhone: string | null };

/** The counter sale an order or an invoice belongs to, or null for any other document. */
export async function selectCounterSaleOf(tx: Tx, tenantId: string, documentId: string): Promise<CounterSaleFacts | null> {
  const [found] = await tx
    .select({ orderId: counterSales.orderId, invoiceId: counterSales.invoiceId, receiptId: counterSales.receiptId, buyerName: counterSales.buyerName, buyerPhone: counterSales.buyerPhone })
    .from(counterSales)
    .where(and(eq(counterSales.tenantId, tenantId), or(eq(counterSales.orderId, documentId), eq(counterSales.invoiceId, documentId))));
  return found ?? null;
}

export type CounterSaleView = { buyerName: string; buyerPhone: string | null; receipt: { id: string; number: string | null; method: string } | null };

/**
 * The counter sale a posted invoice was made by, for its page: who bought, and the receipt that
 * paid it. The receipt is shown only to those who may read receipts; anyone else sees it paid.
 */
export async function getCounterSaleOfInvoice(ctx: TenantContext, invoiceId: string): Promise<CounterSaleView | null> {
  if (!isUuid(invoiceId)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const facts = await selectCounterSaleOf(tx, ctx.tenantId, invoiceId);
    if (!facts || facts.invoiceId !== invoiceId) return null;
    const [receipt] = facts.receiptId
      ? await tx.select({ id: receipts.id, number: receipts.number, method: receipts.method }).from(receipts).where(and(eq(receipts.tenantId, ctx.tenantId), eq(receipts.id, facts.receiptId)))
      : [];
    return { buyerName: facts.buyerName, buyerPhone: facts.buyerPhone, receipt: receipt ?? null };
  });
}
