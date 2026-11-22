import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ExpensesScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Expenses" };

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ExpensesScreen  />
    </Suspense>
  );
}
