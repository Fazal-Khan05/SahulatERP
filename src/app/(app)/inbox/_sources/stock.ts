import { formatIsoDate } from "@/modules/currencies/rules";
import { listCountsToPost } from "@/modules/inventory/queries";
import { can } from "@/modules/tenant/rules";
import type { InboxSource } from "./shape";

// Track B, stock and buying: what its screens leave waiting on someone.
export const waiting: InboxSource = async (session) => {
  // A finished stock count waits for whoever may post it: an owner or an accountant.
  const counts = can(session.role, "stock_count.post") && session.modules.inventory ? await listCountsToPost(session) : [];
  return counts.map((count) => ({
    key: `stock-count-${count.id}`,
    href: `/stock/counts/${count.id}`,
    title: `Post or send back: stock count of ${count.warehouse}`,
    detail: `${count.counted} of ${count.lines} items counted, dated ${formatIsoDate(count.date)}`,
  }));
};
