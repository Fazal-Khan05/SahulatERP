import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PayslipScreen } from "../../_parts/runs";

export const metadata: Metadata = { title: "Payslip" };

export default function Page({ params }: PageProps<"/payroll/payslips/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <PayslipScreen params={params} />
    </Suspense>
  );
}
