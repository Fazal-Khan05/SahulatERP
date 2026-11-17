import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { TransferScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "Transfer" };

export default function Page({ params }: PageProps<"/cash-bank/transfers/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <TransferScreen params={params} />
    </Suspense>
  );
}
