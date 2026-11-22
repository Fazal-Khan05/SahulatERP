import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewPaymentScreen } from "../../_parts/payment-screens";

export const metadata: Metadata = { title: "New supplier payment" };

export default function NewPaymentPage({ searchParams }: PageProps<"/purchases/payments/new">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewPaymentScreen searchParams={searchParams} />
    </Suspense>
  );
}
