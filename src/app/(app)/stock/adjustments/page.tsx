import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { AdjustmentsScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Stock adjustments" };

export default function AdjustmentsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AdjustmentsScreen />
    </Suspense>
  );
}
