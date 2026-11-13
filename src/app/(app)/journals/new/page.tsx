import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewJournalScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "New journal" };

export default function NewJournalPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewJournalScreen />
    </Suspense>
  );
}
