import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { AttendanceScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Attendance" };

export default function Page({ searchParams }: PageProps<"/payroll/attendance">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <AttendanceScreen searchParams={searchParams} />
    </Suspense>
  );
}
