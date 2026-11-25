import "server-only";
import { sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { getOrderChoices, type ItemChoice } from "@/modules/purchasing/queries";
import { selectWithholdingOn } from "@/modules/supplier-bills/queries";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { requireMarketPurchase } from "./commands";

export type MarketPurchaseChoices = {
  suppliers: { id: string; label: string }[];
  warehouses: { id: string; label: string }[];
  items: ItemChoice[];
  accounts: { id: string; label: string; kind: "cash" | "bank" }[];
  /** The company withholds tax from suppliers: the screen says a quick market purchase withholds none. */
  withholds: boolean;
};

/** What the quick market purchase screen chooses from: suppliers on the list, the member's warehouses, items with their units, and the cash and bank accounts money can leave. */
export async function getMarketPurchaseChoices(ctx: TenantContext): Promise<MarketPurchaseChoices> {
  requireMarketPurchase(ctx);
  const [choices, rest] = await Promise.all([
    getOrderChoices(ctx),
    withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const accounts = await tx.execute<{ id: string; label: string; kind: "cash" | "bank" }>(sql`
        select id, code || ' ' || name as label, control_type::text as kind from accounts
        where tenant_id = ${ctx.tenantId}::uuid and control_type in ('cash', 'bank') and not is_group and archived_at is null
        order by control_type = 'bank', code`);
      return { accounts: accounts.map((row) => ({ id: row.id, label: row.label, kind: row.kind })), withholds: await selectWithholdingOn(tx, ctx.tenantId) };
    }),
  ]);
  return { ...choices, ...rest };
}

export type MarketPurchaseView = {
  id: string;
  /** Who sold, as typed, for a seller who is not on the list; null for a supplier who is. */
  sellerName: string | null;
  sellerPhone: string | null;
  memoNo: string | null;
  order: { id: string; number: string | null };
  receipt: { id: string; number: string | null } | null;
  bill: { id: string; number: string | null } | null;
  payment: { id: string; number: string | null; method: "cash" | "bank" | null; status: string } | null;
  orderNumber: string | null;
  receiptNumber: string | null;
  paymentNumber: string | null;
  method: "cash" | "bank" | null;
};

type ViewRow = {
  id: string;
  seller_name: string | null;
  seller_phone: string | null;
  memo_no: string | null;
  order_id: string;
  order_number: string | null;
  receipt_id: string | null;
  receipt_number: string | null;
  bill_id: string | null;
  bill_number: string | null;
  payment_id: string | null;
  payment_number: string | null;
  payment_status: string | null;
  method: "cash" | "bank" | null;
};

/**
 * The quick market purchase that made one of these documents, for its page: who sold, and the
 * other documents made with it. Null for a document made any other way, and for a reader who
 * does not read purchase orders (which carry cost): the warehouse and the sales team.
 */
async function marketPurchaseOf(ctx: TenantContext, column: "order_id" | "receipt_id" | "bill_id" | "payment_id", documentId: string): Promise<MarketPurchaseView | null> {
  if (!isUuid(documentId) || !can(ctx.role, "purchase_order.read")) return null;
  const rows = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx.execute<ViewRow>(sql`
      select m.id, m.seller_name, m.seller_phone, m.memo_no, m.order_id, o.number as order_number, m.receipt_id, r.number as receipt_number,
             m.bill_id, b.number as bill_number, m.payment_id, p.number as payment_number, p.status as payment_status, a.control_type::text as method
      from market_purchases m
      join purchase_orders o on o.tenant_id = m.tenant_id and o.id = m.order_id
      left join goods_receipts r on r.tenant_id = m.tenant_id and r.id = m.receipt_id
      left join supplier_bills b on b.tenant_id = m.tenant_id and b.id = m.bill_id
      left join supplier_payments p on p.tenant_id = m.tenant_id and p.id = m.payment_id
      left join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id
      where m.tenant_id = ${ctx.tenantId}::uuid and ${sql.raw(`m.${column}`)} = ${documentId}::uuid`),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sellerName: row.seller_name,
    sellerPhone: row.seller_phone,
    memoNo: row.memo_no,
    order: { id: row.order_id, number: row.order_number },
    receipt: row.receipt_id ? { id: row.receipt_id, number: row.receipt_number } : null,
    bill: row.bill_id ? { id: row.bill_id, number: row.bill_number } : null,
    payment: row.payment_id ? { id: row.payment_id, number: row.payment_number, method: row.method, status: row.payment_status ?? "draft" } : null,
    orderNumber: row.order_number,
    receiptNumber: row.receipt_number,
    paymentNumber: row.payment_number,
    method: row.method,
  };
}

export const getMarketPurchaseOfOrder = (ctx: TenantContext, orderId: string) => marketPurchaseOf(ctx, "order_id", orderId);
export const getMarketPurchaseOfBill = (ctx: TenantContext, billId: string) => marketPurchaseOf(ctx, "bill_id", billId);
export const getMarketPurchaseOfPayment = (ctx: TenantContext, paymentId: string) => marketPurchaseOf(ctx, "payment_id", paymentId);
