import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { OrderScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Purchase order" };

export default function OrderPage({ params, searchParams }: PageProps<"/purchases/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <OrderScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
