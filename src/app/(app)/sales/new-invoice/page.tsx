import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewInvoiceScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "New invoice" };

export default function NewInvoicePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewInvoiceScreen />
    </Suspense>
  );
}
