import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewReceiptScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "Receive goods" };

export default function NewReceiptPage({ params }: PageProps<"/purchases/receive/[order]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewReceiptScreen params={params} />
    </Suspense>
  );
}
