import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { NewEmployeeScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "New employee" };

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <NewEmployeeScreen  />
    </Suspense>
  );
}
