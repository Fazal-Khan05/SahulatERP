import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { MarketPurchaseScreen } from "../_parts/market-screens";

export const metadata: Metadata = { title: "Quick market purchase" };

export default function MarketPurchasePage({ searchParams }: PageProps<"/purchases/market">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <MarketPurchaseScreen searchParams={searchParams} />
    </Suspense>
  );
}
