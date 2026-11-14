import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PlanScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "New commission plan" };

export default function NewPlanPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PlanScreen id={null} />
    </Suspense>
  );
}
