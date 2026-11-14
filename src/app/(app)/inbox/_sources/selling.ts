import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { todayIso } from "@/lib/format";
import { listCheques } from "@/modules/receipts/queries";
import { listOrdersOnHold } from "@/modules/sales/queries";
import { can } from "@/modules/tenant/rules";
import type { InboxSource } from "./shape";

// Track A, selling and collecting: what its screens leave waiting on someone.
export const waiting: InboxSource = async (session) => {
  // Only the owner can let an order over the credit limit through, so only the owner is asked.
  const held = can(session.role, "sales.approve_credit") && session.modules.sales ? await listOrdersOnHold(session) : [];
  const orders = held.map((order) => ({
    key: `sales-hold-${order.id}`,
    href: `/sales/${order.id}`,
    title: `Approve or send back: sales order for ${order.customerName}`,
    detail: `${formatAmount(order.total)}, dated ${formatIsoDate(order.date)}, over the credit limit`,
  }));
  // Cheques in hand whose date has come can go to the bank: one line for whoever records receipts.
  const today = todayIso(new Date());
  const due = can(session.role, "receipt.manage") && session.modules.collections ? (await listCheques(session)).rows.filter((cheque) => cheque.chequeStage === "received" && (cheque.chequeDate ?? "") <= today) : [];
  const cheques =
    due.length === 0
      ? []
      : [
          {
            key: "cheques-to-deposit",
            href: "/receipts/cheques",
            title: due.length === 1 ? `Deposit a cheque from ${due[0].customerName}` : `Deposit ${due.length} cheques that are in hand`,
            detail: `${formatAmount(due.reduce((sum, cheque) => sum.plus(cheque.amount), due[0].amount.minus(due[0].amount)))} in all, dated today or earlier`,
          },
        ];
  return [...orders, ...cheques];
};
