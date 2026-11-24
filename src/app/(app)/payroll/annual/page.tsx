import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { AnnualScreen } from "../_parts/loans";

export const metadata: Metadata = { title: "Salary statement" };

export default function Page({ searchParams }: PageProps<"/payroll/annual">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <AnnualScreen searchParams={searchParams} />
    </Suspense>
  );
}
