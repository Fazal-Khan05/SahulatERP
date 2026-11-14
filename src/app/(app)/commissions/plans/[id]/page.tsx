import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PlanScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "Commission plan" };

export default function PlanPage({ params }: PageProps<"/commissions/plans/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Plan params={params} />
    </Suspense>
  );
}

async function Plan({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlanScreen id={id} />;
}
