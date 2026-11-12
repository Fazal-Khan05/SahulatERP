import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PartyNewScreen } from "../../_parties/screens";

export const metadata: Metadata = { title: "New supplier" };

export default function NewSupplierPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PartyNewScreen kind="supplier" />
    </Suspense>
  );
}
