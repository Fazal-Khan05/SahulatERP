import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { RatesScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Statutory rates" };

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <RatesScreen  />
    </Suspense>
  );
}
