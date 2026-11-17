import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { BillsScreen } from "../_parts/bill-screens";

export const metadata: Metadata = { title: "Supplier bills" };

export default function BillsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <BillsScreen />
    </Suspense>
  );
}
