import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ShipmentScreen } from "../../_parts/shipment-screens";

export const metadata: Metadata = { title: "Shipment" };

export default function ShipmentPage({ params }: PageProps<"/purchases/shipments/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <ShipmentScreen params={params} />
    </Suspense>
  );
}
