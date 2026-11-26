import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { MoneyInOutEntryScreen } from "../../_parts/money-screens";

export const metadata: Metadata = { title: "Money in or out" };

export default function Page({ params }: PageProps<"/cash-bank/money/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <MoneyInOutEntryScreen params={params} />
    </Suspense>
  );
}
