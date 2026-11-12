import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PartyDetailScreen } from "../../_parties/screens";

export const metadata: Metadata = { title: "Customer" };

export default function CustomerPage({ params }: PageProps<"/customers/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <PartyDetailScreen kind="customer" params={params} />
    </Suspense>
  );
}
