import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PayslipsScreen } from "../_parts/runs";

export const metadata: Metadata = { title: "Payslips" };

export default function Page({ searchParams }: PageProps<"/payroll/payslips">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <PayslipsScreen searchParams={searchParams} />
    </Suspense>
  );
}
