import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { CounterSaleScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "New counter sale" };

export default function CounterSalePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <CounterSaleScreen />
    </Suspense>
  );
}
