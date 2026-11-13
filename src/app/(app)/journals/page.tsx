import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { JournalsScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Journals" };

export default function JournalsPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <JournalsScreen />
    </Suspense>
  );
}
