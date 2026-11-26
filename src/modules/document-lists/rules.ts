import type { SalesKind } from "@/modules/sales/rules";
import { can, type TenantContext } from "@/modules/tenant/rules";

// The combined "All" lists on Sales and Purchases (batch A): every kind of document a member may
// read, newest first, from the lists each kind already has. Nothing here reads the database.

export const ALL_LIST_LIMIT = 200;

export type Listed = { date: string };

/**
 * Several lists, each already newest first, as one list newest first. Of the same day, the order
 * within each list is kept (the newest made first) and the kinds follow the order given. `more`
 * when any list had more than it showed or the whole is cut to the limit.
 */
export function newestFirst<T extends Listed>(lists: readonly { rows: readonly T[]; more: boolean }[], limit = ALL_LIST_LIMIT): { rows: T[]; more: boolean } {
  const tagged = lists.flatMap((list, kind) => list.rows.map((row, at) => ({ row, kind, at })));
  tagged.sort((a, b) => (a.row.date === b.row.date ? a.kind - b.kind || a.at - b.at : a.row.date < b.row.date ? 1 : -1));
  return { rows: tagged.slice(0, limit).map((t) => t.row), more: tagged.length > limit || lists.some((list) => list.more) };
}

/** What is typed in the search box, as the sales lists clean it: no control characters, at most 80 characters, case ignored. */
export function searchTerm(typed: unknown): string {
  return (typeof typed === "string" ? typed : "").replace(/[^\P{Cc}]/gu, " ").trim().slice(0, 80).toLowerCase();
}

/** Whether a row's number or party has the term in it. An empty term matches everything. */
export function matches(row: { number: string | null; party: string }, term: string): boolean {
  if (term === "") return true;
  return (row.number ?? "").toLowerCase().includes(term) || row.party.toLowerCase().includes(term);
}

/** The kinds of sales document this role reads, in the order the Sales tabs show them. */
export function salesKindsFor(ctx: Pick<TenantContext, "role">): SalesKind[] {
  if (can(ctx.role, "sales.read")) return ["quotation", "order", "delivery", "invoice", "credit_note"];
  return can(ctx.role, "delivery.read") ? ["order", "delivery"] : [];
}

export type PurchaseKind = "order" | "receipt" | "bill" | "payment" | "return";
export const PURCHASE_KIND_LABELS: Record<PurchaseKind, string> = { order: "Purchase order", receipt: "Goods received", bill: "Supplier bill", payment: "Supplier payment", return: "Supplier return" };

/** The kinds of buying document this role reads, in the order the Purchases links show them. */
export function purchaseKindsFor(ctx: Pick<TenantContext, "role">): PurchaseKind[] {
  const all: [PurchaseKind, Parameters<typeof can>[1]][] = [
    ["order", "purchase_order.read"],
    ["receipt", "goods_receipt.read"],
    ["bill", "supplier_bill.read"],
    ["payment", "supplier_payment.read"],
    ["return", "supplier_return.read"],
  ];
  return all.filter(([, permission]) => can(ctx.role, permission)).map(([kind]) => kind);
}

