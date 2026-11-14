import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewAdjustmentScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "New adjustment" };

export default function NewAdjustmentPage({ searchParams }: PageProps<"/stock/adjustments/new">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewAdjustmentScreen searchParams={searchParams} />
    </Suspense>
  );
}
