import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { TransferScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "Stock transfer" };

export default function TransferPage({ params, searchParams }: PageProps<"/stock/transfers/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <TransferScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
