import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { CommissionsScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Commission plans" };

export default function CommissionsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <CommissionsScreen />
    </Suspense>
  );
}
