import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { waiting as moneyWaiting } from "./_sources/money";
import { waiting as sellingWaiting } from "./_sources/selling";
import { waiting as stockWaiting } from "./_sources/stock";

export const metadata: Metadata = { title: "Needs attention" };

// The one list of things waiting on this person. It fills in as the modules that put work into
// it are built. Each of the three tracks adds its own work in its own file in ./_sources; this
// page only puts the three lists together, in that order.
const SOURCES = [sellingWaiting, stockWaiting, moneyWaiting];

export default function InboxPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <InboxList />
    </Suspense>
  );
}

async function InboxList() {
  const session = await requireTenant();
  const items = (await Promise.all(SOURCES.map((source) => source(session)))).flat();
  return (
    <>
      <PageHead title="Needs attention" sub="Everything that is waiting on you, in one list." />
      <Card>
        {items.length === 0 ? (
          <Empty>Nothing needs your attention.</Empty>
        ) : (
          <ul aria-label="Waiting on you" className="divide-y text-sm">
            {items.map((item) => (
              <li key={item.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                <Link href={item.href} className="font-medium underline-offset-4 hover:underline">
                  {item.title}
                </Link>
                <span className="text-muted-foreground">{item.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
