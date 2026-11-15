import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PaymentsScreen } from "../_parts/payment-screens";

export const metadata: Metadata = { title: "Supplier payments" };

export default function PaymentsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PaymentsScreen />
    </Suspense>
  );
}
