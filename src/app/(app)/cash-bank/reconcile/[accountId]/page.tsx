import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ReconcileScreen } from "../../_parts/reconcile";

export const metadata: Metadata = { title: "Reconcile" };

export default function Page({ params, searchParams }: PageProps<"/cash-bank/reconcile/[accountId]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <ReconcileScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
