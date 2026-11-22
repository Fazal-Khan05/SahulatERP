import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewExpenseScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "New expense" };

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewExpenseScreen  />
    </Suspense>
  );
}
