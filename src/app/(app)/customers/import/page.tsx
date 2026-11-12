import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PartyImportScreen } from "../../_parties/screens";

export const metadata: Metadata = { title: "Import customers" };

export default function ImportCustomersPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PartyImportScreen kind="customer" />
    </Suspense>
  );
}
