import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { StatementsScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Commission statements" };

export default function CommissionStatementsPage({ searchParams }: PageProps<"/commissions/statements">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <StatementsScreen searchParams={searchParams} />
    </Suspense>
  );
}
