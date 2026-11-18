import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { LoansScreen } from "../_parts/loans";

export const metadata: Metadata = { title: "Loans and advances" };

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <LoansScreen />
    </Suspense>
  );
}
