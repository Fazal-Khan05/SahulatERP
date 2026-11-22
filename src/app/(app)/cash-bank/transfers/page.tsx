import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { TransfersScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Transfers" };

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <TransfersScreen  />
    </Suspense>
  );
}
