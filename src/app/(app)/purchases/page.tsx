import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { OrdersScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Purchase orders" };

export default function OrdersPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <OrdersScreen />
    </Suspense>
  );
}
