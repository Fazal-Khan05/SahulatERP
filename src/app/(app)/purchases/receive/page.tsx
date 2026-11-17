import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { ReceiveScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Receive goods" };

export default function ReceivePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ReceiveScreen />
    </Suspense>
  );
}
