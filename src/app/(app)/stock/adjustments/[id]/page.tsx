import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { AdjustmentScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "Stock adjustment" };

export default function AdjustmentPage({ params, searchParams }: PageProps<"/stock/adjustments/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <AdjustmentScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
