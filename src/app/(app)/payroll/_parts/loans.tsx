import Decimal from "decimal.js";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listEmployees } from "@/modules/payroll/queries";
import { listPayingAccounts } from "@/modules/payroll-runs/queries";
import { getAnnualStatement, getBankAccount, listLoans, type LoanRow } from "@/modules/staff-loans/queries";
import { taxYearName } from "@/modules/staff-loans/rules";
import { can } from "@/modules/tenant/rules";
import { bankAccountAction, issueLoanAction, repayLoanAction } from "./loan-actions";
import { closed, PayrollNav, Shut } from "./screens";

// Step 42: loans and advances to staff, a person's bank account and final settlement, and the
// year's salary statement.

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

type Accounts = Awaited<ReturnType<typeof listPayingAccounts>>;

function AccountSelect({ accounts, label, id = "accountId" }: { accounts: Accounts; label: string; id?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} name="accountId" required defaultValue="" className={SELECT}>
        <option value="" disabled>
          Choose a cash or bank account
        </option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function RepayForm({ loan, accounts }: { loan: LoanRow; accounts: Accounts }) {
  return (
    <ActionForm action={repayLoanAction.bind(null, loan.id)} submitLabel="Record the repayment">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Repaid on" name="date" id={`repaid-on-${loan.id}`} type="date" defaultValue={todayIso(new Date())} max={todayIso(new Date())} required />
        <Field label="Amount" name="amount" id={`repaid-${loan.id}`} inputMode="decimal" placeholder={`Up to ${formatAmount(loan.owed)}`} required />
        <AccountSelect accounts={accounts} label="Into" id={`into-${loan.id}`} />
      </div>
    </ActionForm>
  );
}

function LoanTable({ loans, label }: { loans: LoanRow[]; label: string }) {
  return (
    <table aria-label={label} className="w-full min-w-[640px] text-left text-sm">
      <thead className="border-b text-muted-foreground">
        <tr>
          <th className="py-2 pr-3 font-medium">Loan</th>
          <th className="py-2 pr-3 font-medium">To</th>
          <th className="py-2 pr-3 font-medium">Made on</th>
          <th className="py-2 pr-3 text-right font-medium">Amount</th>
          <th className="py-2 pr-3 text-right font-medium">A month</th>
          <th className="py-2 pr-3 text-right font-medium">Back</th>
          <th className="py-2 text-right font-medium">Owed</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {loans.map((loan) => (
          <tr key={loan.id}>
            <td className="py-2 pr-3 font-medium">{loan.number}</td>
            <td className="py-2 pr-3">
              <Link href={`/payroll/employees/${loan.employeeId}`} className="underline-offset-4 hover:underline">
                {loan.code} {loan.name}
              </Link>
            </td>
            <td className="py-2 pr-3">{formatIsoDate(loan.issuedOn)}</td>
            <td className="py-2 pr-3 text-right tabular-nums">{formatAmount(loan.amount)}</td>
            <td className="py-2 pr-3 text-right tabular-nums">{formatAmount(loan.instalment)}</td>
            <td className="py-2 pr-3 text-right tabular-nums">{formatAmount(loan.recovered)}</td>
            <td className="py-2 text-right tabular-nums">{formatAmount(loan.owed)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export async function LoansScreen() {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Loans" why={why} />;
  const keeper = can(session.role, "staff_loan.manage") && session.branchIds === null;
  const today = todayIso(new Date());
  const [loans, people, accounts] = await Promise.all([listLoans(session), keeper ? listEmployees(session, { on: today }) : [], keeper ? listPayingAccounts(session) : []]);
  return (
    <>
      <PageHead title="Loans and advances" sub="What the company lends its people, the instalment taken from each month's pay, and what is still owed." />
      <PayrollNav here="loans" />
      <div className="flex max-w-5xl flex-col gap-5">
        {keeper ? (
          <Card title="Lend to someone on the payroll">
            <ActionForm action={issueLoanAction} submitLabel="Pay the loan">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="employeeId">To</Label>
                  <select id="employeeId" name="employeeId" required defaultValue="" className={SELECT}>
                    <option value="" disabled>
                      Choose a person
                    </option>
                    {people
                      .filter((p) => p.leftOn === null)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.code} {p.name}
                        </option>
                      ))}
                  </select>
                </div>
                <Field label="Paid on" name="date" type="date" defaultValue={today} max={today} required />
                <AccountSelect accounts={accounts} label="From" />
                <Field label="Amount" name="amount" inputMode="decimal" required />
                <Field label="Taken from each month's pay" name="instalment" inputMode="decimal" required />
                <Field label="Note" name="note" maxLength={300} />
              </div>
            </ActionForm>
          </Card>
        ) : null}
        <Card>{loans.length === 0 ? <Empty>No loans yet.</Empty> : <LoanTable loans={loans} label="Loans" />}</Card>
      </div>
    </>
  );
}

/** A person's bank account, loans and, once they have left, their final settlement: on their page. */
export async function EmployeeMoney({ employeeId, leftOn }: { employeeId: string; leftOn: string | null }) {
  const session = await requireTenant();
  const manager = can(session.role, "payroll.manage");
  const keeper = can(session.role, "staff_loan.manage") && session.branchIds === null;
  const [bank, loans] = await Promise.all([getBankAccount(session, employeeId), listLoans(session, employeeId)]);
  const owed = loans.filter((loan) => loan.owed.gt(0));
  const accounts = keeper && owed.length > 0 ? await listPayingAccounts(session) : [];
  return (
    <>
      <Card title="Bank account">
        {manager ? (
          <ActionForm action={bankAccountAction.bind(null, employeeId)} submitLabel="Save bank account">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Bank" name="bankName" defaultValue={bank?.bankName ?? ""} required />
              <Field label="Account title" name="accountTitle" defaultValue={bank?.accountTitle ?? ""} required />
              <Field label="IBAN" name="iban" defaultValue={bank?.iban ?? ""} placeholder="PK36 SCBL 0000 0011 2345 6702" required />
            </div>
          </ActionForm>
        ) : bank ? (
          <p className="text-sm">
            {bank.bankName}, {bank.accountTitle}, {bank.iban}
          </p>
        ) : (
          <Empty>No bank account on record: the salary bank file cannot pay this person.</Empty>
        )}
      </Card>
      <Card title={leftOn ? "Final settlement" : "Loans"}>
        {leftOn ? (
          <p className="mb-3 text-sm text-muted-foreground" data-testid="final-settlement">
            Left on {formatIsoDate(leftOn)}. Their last month&apos;s pay takes all they owe on loans, as far as it goes;{" "}
            {owed.length === 0 ? "nothing is owed now." : `${formatAmount(owed.reduce((total, loan) => total.plus(loan.owed), new Decimal(0)))} is still owed, to be repaid in cash.`}
          </p>
        ) : null}
        {loans.length === 0 ? <Empty>No loans.</Empty> : <LoanTable loans={loans} label="Their loans" />}
        {keeper && owed.length > 0
          ? owed.map((loan) => (
              <div key={loan.id} className="mt-4">
                <h3 className="mb-2 text-sm font-semibold">Repay {loan.number} in cash</h3>
                <RepayForm loan={loan} accounts={accounts} />
              </div>
            ))
          : null}
      </Card>
    </>
  );
}

export async function AnnualScreen({ searchParams }: { searchParams: Promise<{ year?: string | string[] }> }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Salary statement" why={why} />;
  const today = todayIso(new Date());
  const current = Number(today.slice(5, 7)) >= 7 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
  const asked = Number((await searchParams).year);
  const julyOf = Number.isInteger(asked) && asked >= 2000 && asked <= current ? asked : current;
  const { rows } = await getAnnualStatement(session, julyOf);
  return (
    <>
      <PageHead title="The year's salary statement" sub="Each person's pay and the income tax deducted from it (s.149) over a tax year, from the approved payroll runs." />
      <PayrollNav here="annual" />
      <div className="flex max-w-5xl flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          {[julyOf - 1, julyOf, julyOf + 1]
            .filter((y) => y <= current)
            .map((y) => (
              <Link key={y} href={`/payroll/annual?year=${y}`} aria-current={y === julyOf ? "page" : undefined} className={buttonVariants({ variant: y === julyOf ? "default" : "outline", size: "sm" })}>
                {taxYearName(y)}
              </Link>
            ))}
          <a href={`/payroll/annual/export?year=${julyOf}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Download CSV
          </a>
        </div>
        <Card title={`${taxYearName(julyOf)}: 1 July ${julyOf} to 30 June ${julyOf + 1}`}>
          {rows.length === 0 ? (
            <Empty>No approved payroll in this tax year.</Empty>
          ) : (
            <table aria-label="Salary statement" className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Code</th>
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 text-right font-medium">Months</th>
                  <th className="py-2 pr-3 text-right font-medium">Pay and commission</th>
                  <th className="py-2 pr-3 text-right font-medium">Taxable</th>
                  <th className="py-2 text-right font-medium">Tax deducted</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.code}>
                    <td className="py-2 pr-3 font-medium">{row.code}</td>
                    <td className="py-2 pr-3">{row.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{row.months}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatAmount(row.pay)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatAmount(row.taxable)}</td>
                    <td className="py-2 text-right tabular-nums">{formatAmount(row.tax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
