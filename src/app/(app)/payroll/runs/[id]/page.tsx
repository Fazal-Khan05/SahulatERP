import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { RunScreen } from "../../_parts/runs";

export const metadata: Metadata = { title: "Payroll run" };

export default function Page({ params }: PageProps<"/payroll/runs/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <RunScreen params={params} />
    </Suspense>
  );
}
