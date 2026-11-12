import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PartyNewScreen } from "../../_parties/screens";

export const metadata: Metadata = { title: "New customer" };

export default function NewCustomerPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PartyNewScreen kind="customer" />
    </Suspense>
  );
}
