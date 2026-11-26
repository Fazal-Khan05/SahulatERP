import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { AllPurchasesScreen } from "../_parts/all-screens";

export const metadata: Metadata = { title: "All purchases" };

export default function AllPurchasesPage({ searchParams }: PageProps<"/purchases/all">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <AllPurchasesScreen searchParams={searchParams} />
    </Suspense>
  );
}
