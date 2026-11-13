import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listOrdersOnHold } from "@/modules/sales/queries";
import { can } from "@/modules/tenant/rules";
import type { InboxSource } from "./shape";

// Track A, selling and collecting: what its screens leave waiting on someone.
export const waiting: InboxSource = async (session) => {
  // Only the owner can let an order over the credit limit through, so only the owner is asked.
  const held = can(session.role, "sales.approve_credit") && session.modules.sales ? await listOrdersOnHold(session) : [];
  return held.map((order) => ({
    key: `sales-hold-${order.id}`,
    href: `/sales/${order.id}`,
    title: `Approve or send back: sales order for ${order.customerName}`,
    detail: `${formatAmount(order.total)}, dated ${formatIsoDate(order.date)}, over the credit limit`,
  }));
};
