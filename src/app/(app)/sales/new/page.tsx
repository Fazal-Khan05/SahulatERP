import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewSalesScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "New sales document" };

export default function NewSalesPage({ searchParams }: PageProps<"/sales/new">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewSalesScreen searchParams={searchParams} />
    </Suspense>
  );
}
