import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewReceiptScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "New receipt" };

export default function NewReceiptPage({ searchParams }: PageProps<"/receipts/new">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewReceiptScreen searchParams={searchParams} />
    </Suspense>
  );
}
