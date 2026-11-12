import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PartyDetailScreen } from "../../_parties/screens";

export const metadata: Metadata = { title: "Supplier" };

export default function SupplierPage({ params }: PageProps<"/suppliers/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <PartyDetailScreen kind="supplier" params={params} />
    </Suspense>
  );
}
