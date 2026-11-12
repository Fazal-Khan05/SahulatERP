import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PriceListsScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Price lists" };

export default function PriceListsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PriceListsScreen />
    </Suspense>
  );
}
