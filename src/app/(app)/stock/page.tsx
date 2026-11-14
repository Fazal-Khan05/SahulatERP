import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { StockScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Stock" };

export default function StockPage({ searchParams }: PageProps<"/stock">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <StockScreen searchParams={searchParams} />
    </Suspense>
  );
}
