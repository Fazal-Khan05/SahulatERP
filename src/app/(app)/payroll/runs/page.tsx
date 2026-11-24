import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { RunsScreen } from "../_parts/runs";

export const metadata: Metadata = { title: "Payroll runs" };

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <RunsScreen />
    </Suspense>
  );
}
