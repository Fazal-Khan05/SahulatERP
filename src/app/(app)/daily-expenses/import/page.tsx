import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ImportExpensesScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Upload a sheet of expenses" };

export default function ImportExpensesPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ImportExpensesScreen />
    </Suspense>
  );
}
