import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { SalesDocumentScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Sales document" };

export default function SalesDocumentPage({ params, searchParams }: PageProps<"/sales/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <SalesDocumentScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
