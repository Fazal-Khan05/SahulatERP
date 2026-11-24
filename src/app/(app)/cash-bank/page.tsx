import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { AccountsScreen } from "./_parts/screens";

export const metadata: Metadata = { title: "Cash and bank" };

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <AccountsScreen  />
    </Suspense>
  );
}
