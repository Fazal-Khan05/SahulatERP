import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { SalesListScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Sales" };

export default function SalesPage({ searchParams }: PageProps<"/sales">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <SalesListScreen searchParams={searchParams} />
    </Suspense>
  );
}
