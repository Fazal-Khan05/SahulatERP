import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { EmployeesScreen } from "../_parts/screens";

export const metadata: Metadata = { title: "Employees" };

export default function Page({ searchParams }: PageProps<"/payroll/employees">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <EmployeesScreen searchParams={searchParams} />
    </Suspense>
  );
}
