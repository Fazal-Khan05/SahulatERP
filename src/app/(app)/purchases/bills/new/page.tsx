import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewBillScreen } from "../../_parts/bill-screens";

export const metadata: Metadata = { title: "New supplier bill" };

export default function NewBillPage({ searchParams }: PageProps<"/purchases/bills/new">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewBillScreen searchParams={searchParams} />
    </Suspense>
  );
}
