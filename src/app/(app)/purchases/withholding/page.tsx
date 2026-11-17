import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { WithholdingScreen } from "../_parts/bill-screens";

export const metadata: Metadata = { title: "Withholding tax" };

export default function WithholdingPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <WithholdingScreen />
    </Suspense>
  );
}
