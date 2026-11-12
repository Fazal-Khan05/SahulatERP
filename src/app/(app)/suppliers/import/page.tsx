import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PartyImportScreen } from "../../_parties/screens";

export const metadata: Metadata = { title: "Import suppliers" };

export default function ImportSuppliersPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PartyImportScreen kind="supplier" />
    </Suspense>
  );
}
