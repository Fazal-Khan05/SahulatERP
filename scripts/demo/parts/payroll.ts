import { approveCommission } from "@/modules/commission-ledger/commands";
import { approveRun, payRun, reviewRun, workOutRun } from "@/modules/payroll-runs/commands";
import { getRun } from "@/modules/payroll-runs/queries";
import { importAttendance, saveEmployee, setPay } from "@/modules/payroll/commands";
import { issueLoan, repayLoan } from "@/modules/staff-loans/commands";
import { listLoans } from "@/modules/staff-loans/queries";
import { recordTaxChallan } from "@/modules/tax-paid-over/commands";
import { formatAmount } from "@/lib/money";
import type { Demo } from "../world";

// Payroll: five invented employees, last month's run approved and paid, this month's worked out
// and left as a draft, a loan to one of them with its instalment taken from pay, and one
// salesperson whose commission is paid with her salary.

export async function seedPayroll(d: Demo): Promise<void> {
  const { owner, accountant, payroll, day, lastMonth, thisMonth, today } = d;
  const joined = `${d.fyYear}-07-01`;
  // code, name, designation, province, basis, registered with EOBI, the login they sign in with, pay
  const PEOPLE: [string, string, string, string, "monthly" | "daily", string | null, [string, string][]][] = [
    ["E-001", "Imran Qureshi", "Sales manager", "sindh", "monthly", null, [["basic", "62000"], ["house_rent", "15000"], ["conveyance", "5000"]]],
    ["E-002", "Sana Malik", "Salesperson, Lahore", "punjab", "monthly", d.people.SANA.id, [["basic", "34000"], ["conveyance", "5000"]]],
    ["E-003", "Ali Raza", "Salesperson, Karachi", "sindh", "monthly", null, [["basic", "34000"], ["conveyance", "5000"]]],
    ["E-004", "Nadia Hussain", "Accountant", "sindh", "monthly", null, [["basic", "50000"], ["medical", "5000"]]],
    ["E-005", "Bilal Ahmed", "Warehouse helper", "sindh", "daily", null, [["daily_wage", "1300"]]],
  ];
  const employees: Record<string, string> = {};
  for (const [code, name, designation, province, payBasis, userId, pay] of PEOPLE) {
    employees[code] = (await saveEmployee(owner, null, { code, name, designation, province, payBasis, joinedOn: joined, eobi: "on", socialSecurity: payBasis === "daily" ? "on" : "", userId: userId ?? "" })).id;
    for (const [component, amount] of pay) await setPay(owner, employees[code], { component, amount, effectiveFrom: joined });
  }

  // A loan to Ali for a motorcycle repair, paid from the bank; ten thousand comes off each month's pay.
  const loan = await issueLoan(accountant, { employeeId: employees["E-003"], date: day(0, 12), amount: "60000", instalment: "10000", accountId: d.bank, note: "Motorcycle repair" });

  // Sana's commission is paid with her salary: what last month's money released is approved, and the run carries it.
  const released = await d.sql<{ id: string }[]>`select id from public.commission_accruals where tenant_id = ${d.tenantId} and user_id = ${d.people.SANA.id} and released > paid`;
  if (released.length > 0) await approveCommission(owner, released.map((row) => row.id));

  const attendance = (days: number) => ({ name: "attendance.csv", text: `Code,Days worked,Unpaid days\nE-005,${days},0\n` });
  const worked = async (month: string) => {
    const outcome = await workOutRun(payroll, month);
    if (!("id" in outcome)) throw new Error(`Payroll for ${month} could not be worked out: ${outcome.problems.map((p) => `${p.name} ${p.reason}`).join("; ")}`);
    return outcome.id;
  };
  await importAttendance(payroll, lastMonth, attendance(24));
  const lastRun = await worked(lastMonth);
  await reviewRun(payroll, lastRun);
  const approved = await approveRun(accountant, lastRun);
  await payRun(accountant, lastRun, { date: day(1, 1), accountId: d.bank });
  const paid = (await getRun(owner, lastRun))!;
  // The income tax deducted from last month's pay is paid over to the government with its challan.
  const salaryChallan = paid.tax.gt(0)
    ? (await recordTaxChallan(accountant, { kind: "income_tax", paidOn: day(1, 10), accountId: d.bank, challanNo: "IT-20261110-005102", note: "Income tax deducted from last month's salaries", runIds: [lastRun] })).number
    : "";

  // Ali pays five thousand of his loan back in cash; then this month is worked out and left as a draft.
  const [owed] = await listLoans(owner, employees["E-003"]);
  const repaid = await repayLoan(accountant, owed.id, { date: day(1, 8), amount: "5000", accountId: d.cash });
  await importAttendance(payroll, thisMonth, attendance(Math.max(1, Math.min(22, Math.floor(Number(today.slice(8, 10)) * 0.8)))));
  await worked(thisMonth);

  Object.assign(d.facts, { salaryChallan, salaryTaxPaid: formatAmount(paid.tax), payrollRun: approved.number, payrollNet: formatAmount(paid.net), loan: loan.number, loanRepayment: repaid.number });
  d.said.push(`Payroll: ${PEOPLE.length} employees; last month's run ${approved.number} approved and paid, ${formatAmount(paid.net)} to the staff, Sana's commission in it; this month's run is a draft; loan ${loan.number} to Ali, ${repaid.number} paid back in cash${salaryChallan ? `; ${salaryChallan} pays over the ${formatAmount(paid.tax)} of income tax deducted from the salaries` : ""}.`);
}
