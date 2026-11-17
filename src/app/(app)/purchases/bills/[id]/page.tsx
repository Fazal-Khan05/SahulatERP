import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { BillScreen } from "../../_parts/bill-screens";

export const metadata: Metadata = { title: "Supplier bill" };

export default function BillPage({ params, searchParams }: PageProps<"/purchases/bills/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <BillScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
