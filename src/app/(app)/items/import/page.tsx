import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ItemImportScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Import items" };

export default function ImportItemsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ItemImportScreen />
    </Suspense>
  );
}
