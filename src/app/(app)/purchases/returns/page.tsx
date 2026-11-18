import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ReturnsScreen } from "../_parts/return-screens";

export const metadata: Metadata = { title: "Supplier returns" };

export default function ReturnsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ReturnsScreen />
    </Suspense>
  );
}
