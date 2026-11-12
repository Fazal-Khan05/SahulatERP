import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ItemNewScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "New item" };

export default function NewItemPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ItemNewScreen />
    </Suspense>
  );
}
