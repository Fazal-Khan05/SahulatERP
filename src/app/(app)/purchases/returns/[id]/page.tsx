import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ReturnScreen } from "../../_parts/return-screens";

export const metadata: Metadata = { title: "Supplier return" };

export default function ReturnPage({ params, searchParams }: PageProps<"/purchases/returns/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <ReturnScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
