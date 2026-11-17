import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ReceiptScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "Goods received" };

export default function ReceiptPage({ params, searchParams }: PageProps<"/purchases/receipts/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <ReceiptScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
