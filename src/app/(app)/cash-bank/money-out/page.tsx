import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { MoneyInOutScreen } from "../_parts/money-screens";

export const metadata: Metadata = { title: "Money out" };

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <MoneyInOutScreen direction="out" />
    </Suspense>
  );
}
