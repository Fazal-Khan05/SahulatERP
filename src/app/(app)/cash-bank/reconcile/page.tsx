import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ReconcileListScreen } from "../_parts/reconcile";

export const metadata: Metadata = { title: "Reconcile" };

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ReconcileListScreen />
    </Suspense>
  );
}
