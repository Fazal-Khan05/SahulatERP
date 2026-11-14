import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { CountScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "Stock count" };

export default function CountPage({ params }: PageProps<"/stock/counts/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <CountScreen params={params} />
    </Suspense>
  );
}
