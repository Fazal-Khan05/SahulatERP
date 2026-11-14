import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { CountsScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Stock counts" };

export default function CountsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <CountsScreen />
    </Suspense>
  );
}
