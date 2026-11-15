import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewOrderScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "New purchase order" };

export default function NewOrderPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewOrderScreen />
    </Suspense>
  );
}
