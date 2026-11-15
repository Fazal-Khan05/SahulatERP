import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { EarnedScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Commission earned" };

export default function CommissionEarnedPage({ searchParams }: PageProps<"/commissions/earned">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <EarnedScreen searchParams={searchParams} />
    </Suspense>
  );
}
