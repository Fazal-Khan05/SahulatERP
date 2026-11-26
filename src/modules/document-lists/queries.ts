import "server-only";
import type Decimal from "decimal.js";
import { listOrders, listReceipts } from "@/modules/purchasing/queries";
import { ORDER_STATUS_LABELS, RECEIPT_STATUS_LABELS } from "@/modules/purchasing/rules";
import { listSalesDocuments, type SalesListRow } from "@/modules/sales/queries";
import { listBills } from "@/modules/supplier-bills/queries";
import { BILL_STATUS_LABELS } from "@/modules/supplier-bills/rules";
import { listPayments } from "@/modules/supplier-payments/queries";
import { PAYMENT_STATUS_LABELS } from "@/modules/supplier-payments/rules";
import { listReturns } from "@/modules/supplier-returns/queries";
import { RETURN_STATUS_LABELS } from "@/modules/supplier-returns/rules";
import type { TenantContext } from "@/modules/tenant/rules";
import { matches, newestFirst, purchaseKindsFor, salesKindsFor, searchTerm, type PurchaseKind } from "./rules";

export { PURCHASE_KIND_LABELS, purchaseKindsFor } from "./rules";

// The combined "All" lists (batch A): read-only, made of the lists each kind already has, so each
// kind is read with its own permission check and its own row-level security. A member sees only
// the kinds their role already reads.

/** Every sales document this member may read, newest first, found by part of the number or the customer's name. */
export async function listAllSales(ctx: TenantContext, search = ""): Promise<{ rows: SalesListRow[]; more: boolean }> {
  const lists = await Promise.all(salesKindsFor(ctx).map((kind) => listSalesDocuments(ctx, { kind, search })));
  return newestFirst(lists);
}

export type PurchaseListRow = { id: string; kind: PurchaseKind; number: string | null; date: string; party: string; amount: Decimal | null; status: string; href: string };

const empty = { rows: [] as PurchaseListRow[], more: false };

/** Every buying document this member may read, newest first, found by part of the number or the supplier's name. */
export async function listAllPurchases(ctx: TenantContext, search = ""): Promise<{ rows: PurchaseListRow[]; more: boolean }> {
  const kinds = new Set(purchaseKindsFor(ctx));
  const term = searchTerm(search);
  const [orders, receipts, bills, payments, returns] = await Promise.all([
    kinds.has("order")
      ? listOrders(ctx).then((l) => ({ more: l.more, rows: l.rows.map((r): PurchaseListRow => ({ id: r.id, kind: "order", number: r.number, date: r.date, party: r.supplierName, amount: r.total, status: ORDER_STATUS_LABELS[r.status], href: `/purchases/${r.id}` })) }))
      : empty,
    kinds.has("receipt")
      ? listReceipts(ctx).then((l) => ({ more: l.more, rows: l.rows.map((r): PurchaseListRow => ({ id: r.id, kind: "receipt", number: r.number, date: r.date, party: r.supplierName, amount: null, status: RECEIPT_STATUS_LABELS[r.status], href: `/purchases/receipts/${r.id}` })) }))
      : empty,
    kinds.has("bill")
      ? listBills(ctx).then((l) => ({ more: l.more, rows: l.rows.map((r): PurchaseListRow => ({ id: r.id, kind: "bill", number: r.number, date: r.date, party: r.supplierName, amount: r.total, status: BILL_STATUS_LABELS[r.status], href: `/purchases/bills/${r.id}` })) }))
      : empty,
    kinds.has("payment")
      ? listPayments(ctx).then((l) => ({ more: l.more, rows: l.rows.map((r): PurchaseListRow => ({ id: r.id, kind: "payment", number: r.number, date: r.date, party: r.supplierName, amount: r.amount, status: PAYMENT_STATUS_LABELS[r.status], href: `/purchases/payments/${r.id}` })) }))
      : empty,
    kinds.has("return")
      ? listReturns(ctx).then((l) => ({ more: l.more, rows: l.rows.map((r): PurchaseListRow => ({ id: r.id, kind: "return", number: r.number, date: r.date, party: r.supplierName, amount: r.credit, status: RETURN_STATUS_LABELS[r.status], href: `/purchases/returns/${r.id}` })) }))
      : empty,
  ]);
  // The buying lists have no search of their own: what they show is searched here.
  const found = [orders, receipts, bills, payments, returns].map((list) => ({ more: list.more, rows: list.rows.filter((row) => matches(row, term)) }));
  return newestFirst(found);
}
