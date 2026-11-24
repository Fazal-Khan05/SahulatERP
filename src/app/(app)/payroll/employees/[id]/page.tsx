import type { Metadata } from "next";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { EmployeeMoney } from "../../_parts/loans";
import { EmployeeScreen } from "../../_parts/screens";

export const metadata: Metadata = { title: "Employee" };

export default function Page({ params }: PageProps<"/payroll/employees/[id]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <EmployeeScreen params={params} more={(employee) => <EmployeeMoney employeeId={employee.id} leftOn={employee.leftOn} />} />
    </Suspense>
  );
}
