import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ShipmentsScreen } from "../_parts/shipment-screens";

export const metadata: Metadata = { title: "Shipments" };

export default function ShipmentsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ShipmentsScreen />
    </Suspense>
  );
}
