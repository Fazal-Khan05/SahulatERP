import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ChequesScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Cheques" };

export default function ChequesPage({ searchParams }: PageProps<"/receipts/cheques">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <ChequesScreen searchParams={searchParams} />
    </Suspense>
  );
}
