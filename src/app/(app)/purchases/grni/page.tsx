import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { GrniScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Goods received, not yet billed" };

export default function GrniPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <GrniScreen />
    </Suspense>
  );
}
