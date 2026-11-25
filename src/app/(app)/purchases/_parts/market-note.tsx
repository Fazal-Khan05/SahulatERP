import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import type { MarketPurchaseView } from "@/modules/market-purchases/queries";
import { can, type MemberRole } from "@/modules/tenant/rules";

/** The button that opens the quick market purchase screen, for the lists of the buying screens. */
export function MarketPurchaseButton({ role }: { role: MemberRole }) {
  if (!can(role, "market_purchase.manage")) return null;
  return (
    <Link href="/purchases/market" className={buttonVariants({ variant: "outline" })}>
      Quick market purchase
    </Link>
  );
}

/** On the page of an order, a bill or a payment a quick market purchase made: who sold, and the documents made with it. */
export function MarketPurchaseNote({ purchase, on }: { purchase: MarketPurchaseView | null; on: "order" | "receipt" | "bill" | "payment" }) {
  if (!purchase) return null;
  const link = (href: string, number: string | null) =>
    number ? (
      <Link href={href} className="font-medium underline underline-offset-4">
        {number}
      </Link>
    ) : null;
  const parts: React.ReactNode[] = [];
  if (on !== "order") parts.push(<>order {link(`/purchases/${purchase.order.id}`, purchase.order.number)}</>);
  if (on !== "receipt" && purchase.receipt) parts.push(<>goods received note {link(`/purchases/receipts/${purchase.receipt.id}`, purchase.receipt.number)}</>);
  if (on !== "bill" && purchase.bill) parts.push(<>bill {link(`/purchases/bills/${purchase.bill.id}`, purchase.bill.number)}</>);
  if (on !== "payment" && purchase.payment) parts.push(<>payment {link(`/purchases/payments/${purchase.payment.id}`, purchase.payment.number)}</>);
  const paid = purchase.payment?.status === "posted" ? `Paid in full ${purchase.payment.method === "bank" ? "from the bank" : "in cash"} as it was bought.` : purchase.payment?.status === "cancelled" ? "Its payment was cancelled later." : "";
  return (
    <p role="status" data-testid="market-purchase" className="mb-4 max-w-5xl text-sm">
      Quick market purchase{purchase.sellerName ? ` from ${purchase.sellerName}` : ""}
      {purchase.sellerPhone ? ` (${purchase.sellerPhone})` : ""}
      {purchase.memoNo ? `, cash memo ${purchase.memoNo}` : ""}. {paid} Made with{" "}
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? (index === parts.length - 1 ? " and " : ", ") : ""}
          {part}
        </span>
      ))}
      .
    </p>
  );
}
