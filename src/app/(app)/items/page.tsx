import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ItemListScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Items" };

export default function ItemsPage({ searchParams }: PageProps<"/items">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <ItemListScreen searchParams={searchParams} />
    </Suspense>
  );
}
