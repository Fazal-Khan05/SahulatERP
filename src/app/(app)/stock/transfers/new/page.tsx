import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewTransferScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "New transfer" };

export default function NewTransferPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewTransferScreen />
    </Suspense>
  );
}
