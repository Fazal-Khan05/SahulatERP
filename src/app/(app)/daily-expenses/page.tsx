import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { DailyExpensesScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Daily expenses" };

export default function DailyExpensesPage({ searchParams }: PageProps<"/daily-expenses">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <DailyExpensesScreen searchParams={searchParams} />
    </Suspense>
  );
}
