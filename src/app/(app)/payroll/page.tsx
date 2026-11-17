import { redirect } from "next/navigation";

// The menu's "Payroll" entry: the employees, with attendance and the statutory rates beside them.
export default function PayrollPage() {
  redirect("/payroll/employees");
}
