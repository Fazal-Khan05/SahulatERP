import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ItemUnitsScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Units and categories" };

export default function ItemUnitsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ItemUnitsScreen />
    </Suspense>
  );
}
