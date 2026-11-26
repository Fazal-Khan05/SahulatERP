import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ExpenseScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "Expense" };

export default function Page({ params, searchParams }: PageProps<"/cash-bank/expenses/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <ExpenseScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
