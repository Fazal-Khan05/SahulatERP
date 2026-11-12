import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PriceListScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Price list" };

export default function PriceListPage({ params }: PageProps<"/price-lists/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <PriceListScreen params={params} />
    </Suspense>
  );
}
