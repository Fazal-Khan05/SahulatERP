import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { JournalScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Journal" };

export default function JournalPage({ params, searchParams }: PageProps<"/journals/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <JournalScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
