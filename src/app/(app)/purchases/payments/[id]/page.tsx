import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PaymentScreen } from "../../_parts/payment-screens";

export const metadata: Metadata = { title: "Supplier payment" };

export default function PaymentPage({ params, searchParams }: PageProps<"/purchases/payments/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <PaymentScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
