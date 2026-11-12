import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { PartyListScreen } from "../_parties/screens";

export const metadata: Metadata = { title: "Customers" };

export default function CustomersPage({ searchParams }: PageProps<"/customers">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <PartyListScreen kind="customer" searchParams={searchParams} />
    </Suspense>
  );
}
