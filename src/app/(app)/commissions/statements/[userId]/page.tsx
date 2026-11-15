import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { StatementScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Commission statement" };

export default function CommissionStatementPage({ params, searchParams }: PageProps<"/commissions/statements/[userId]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <StatementScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
