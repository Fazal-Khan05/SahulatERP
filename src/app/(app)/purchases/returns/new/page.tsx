import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewReturnScreen } from "../../_parts/return-screens";

export const metadata: Metadata = { title: "New supplier return" };

export default function NewReturnPage({ searchParams }: PageProps<"/purchases/returns/new">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewReturnScreen searchParams={searchParams} />
    </Suspense>
  );
}
