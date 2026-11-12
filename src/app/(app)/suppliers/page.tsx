import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PartyListScreen } from "../_parties/screens";

export const metadata: Metadata = { title: "Suppliers" };

export default function SuppliersPage({ searchParams }: PageProps<"/suppliers">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <PartyListScreen kind="supplier" searchParams={searchParams} />
    </Suspense>
  );
}
