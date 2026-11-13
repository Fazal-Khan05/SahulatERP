import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty, PageHead } from "@/components/page-parts";
import Link from "next/link";
import { requireTenant } from "@/lib/auth/session";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listOrdersOnHold } from "@/modules/sales/queries";
import { can } from "@/modules/tenant/rules";

export const metadata: Metadata = { title: "Needs attention" };

// The one list of things waiting on this person. It fills in as the modules that put work into
// it are built: so far, sales orders over a customer's credit limit, which wait for the owner.
export default function InboxPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <InboxList />
    </Suspense>
  );
}

async function InboxList() {
  const session = await requireTenant();
  // Only the owner can let an order over the credit limit through, so only the owner is asked.
  const held = can(session.role, "sales.approve_credit") && session.modules.sales ? await listOrdersOnHold(session) : [];
  return (
    <>
      <PageHead title="Needs attention" sub="Everything that is waiting on you, in one list." />
      <Card>
        {held.length === 0 ? (
          <Empty>Nothing needs your attention.</Empty>
        ) : (
          <ul aria-label="Waiting on you" className="divide-y text-sm">
            {held.map((order) => (
              <li key={order.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                <Link href={`/sales/${order.id}`} className="font-medium underline-offset-4 hover:underline">
                  Approve or send back: sales order for {order.customerName}
                </Link>
                <span className="text-muted-foreground">
                  {formatAmount(order.total)}, dated {formatIsoDate(order.date)}, over the credit limit
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
