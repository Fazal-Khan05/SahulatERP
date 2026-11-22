import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewShipmentScreen } from "../../_parts/shipment-screens";

export const metadata: Metadata = { title: "New shipment" };

export default function NewShipmentPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewShipmentScreen />
    </Suspense>
  );
}
