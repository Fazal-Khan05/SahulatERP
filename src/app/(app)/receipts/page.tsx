import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ReceiptsScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Receipts" };

export default function ReceiptsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ReceiptsScreen />
    </Suspense>
  );
}
