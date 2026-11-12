import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ItemDetailScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Item" };

export default function ItemPage({ params }: PageProps<"/items/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <ItemDetailScreen params={params} />
    </Suspense>
  );
}
