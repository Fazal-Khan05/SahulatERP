import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { formatDateTime, todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getPayslip, getRun, listPayingAccounts, listRuns, type PayslipRow, type RunDetail } from "@/modules/payroll-runs/queries";
import { approvalJournal, monthEnd, RUN_STATUS_LABELS } from "@/modules/payroll-runs/rules";
import { getBankFile } from "@/modules/staff-loans/queries";
import { isMonth } from "@/modules/payroll/rules";
import { can } from "@/modules/tenant/rules";
import { approveRunAction, cancelRunAction, payRunAction, reviewRunAction, workOutRunAction } from "./run-actions";
import { closed, monthName, PayrollNav, Shut, thisMonth } from "./screens";

// Step 41: the payroll run screens. A month is worked out as a draft, reviewed, approved (which
// puts it in the books and settles the commission it carries) and paid.

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const amount = formatAmount;

// ── The runs ────────────────────────────────────────────────────────────────────────────────────

export async function RunsScreen() {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Payroll runs" why={why} />;
  const runs = await listRuns(session);
  const mayWorkOut = can(session.role, "payroll.manage") && session.branchIds === null;
  return (
    <>
      <PageHead title="Payroll runs" sub="Each month's payroll: worked out, reviewed, approved into the books, and paid." />
      <PayrollNav here="runs" />
      <div className="flex max-w-5xl flex-col gap-5">
        {mayWorkOut ? (
          <Card title="Work out a month">
            <p className="mb-3 text-sm text-muted-foreground">
              One payslip for each person employed in the month, from their pay, their attendance, the statutory rates in force, and the commission approved for them. A month already worked out and not yet
              approved is worked out again.
            </p>
            <ActionForm action={workOutRunAction} submitLabel="Work out">
              <Field label="Month" name="month" type="month" defaultValue={thisMonth().slice(0, 7)} max={thisMonth().slice(0, 7)} required />
            </ActionForm>
          </Card>
        ) : null}
        <Card>
          {runs.length === 0 ? (
            <Empty>No payroll has been worked out yet.</Empty>
          ) : (
            <table aria-label="Payroll runs" className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Month</th>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 text-right font-medium">People</th>
                  <th className="py-2 pr-4 text-right font-medium">Pay and commission</th>
                  <th className="py-2 text-right font-medium">Take home</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="py-2 pr-4 font-medium">
                      <Link href={`/payroll/runs/${run.id}`} className="underline-offset-4 hover:underline">
                        {monthName(run.month)}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{run.number ?? ""}</td>
                    <td className="py-2 pr-4">{RUN_STATUS_LABELS[run.status]}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{run.people}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{amount(run.earnings.plus(run.commission))}</td>
                    <td className="py-2 text-right tabular-nums">{amount(run.net)}</td>
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

// ── One run ─────────────────────────────────────────────────────────────────────────────────────

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function Totals({ run }: { run: RunDetail }) {
  return (
    <dl aria-label="Totals" className="divide-y">
      <Figure label="Pay" value={amount(run.earnings)} />
      <Figure label="Commission" value={amount(run.commission)} />
      <Figure label="Income tax deducted" value={amount(run.tax)} />
      <Figure label="EOBI, employees' share" value={amount(run.eobiEmployee)} />
      <Figure label="Fixed deductions" value={amount(run.deductions.minus(run.loanRecovery))} />
      <Figure label="Loan instalments" value={amount(run.loanRecovery)} />
      <Figure label="Take home" value={amount(run.net)} />
      <Figure label="EOBI, employer's share" value={amount(run.employerEobi)} />
      <Figure label="Social security, employer's share" value={amount(run.employerSocialSecurity)} />
    </dl>
  );
}

function Stage({ run }: { run: RunDetail }) {
  const lines = [`Worked out ${formatDateTime(run.workedOutAt)}`];
  if (run.reviewedAt) lines.push(`reviewed ${formatDateTime(run.reviewedAt)}`);
  if (run.approvedAt && run.journalDate) lines.push(`approved ${formatDateTime(run.approvedAt)}, in the books on ${formatIsoDate(run.journalDate)}`);
  if (run.paidOn) lines.push(`paid on ${formatIsoDate(run.paidOn)}${run.payAccount ? ` from ${run.payAccount}` : ""}${run.paymentNumber ? ` as ${run.paymentNumber}` : ""}`);
  if (run.cancelledAt) lines.push(`cancelled ${formatDateTime(run.cancelledAt)}: ${run.cancelReason ?? ""}`);
  return <p className="text-sm text-muted-foreground">{lines.join("; ")}.</p>;
}

export async function RunScreen({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Payroll run" why={why} />;
  const { id } = await params;
  const run = await getRun(session, id);
  if (!run) notFound();
  const wide = session.branchIds === null;
  const manage = can(session.role, "payroll.manage") && wide;
  const approve = can(session.role, "payroll_run.approve") && wide;
  const pay = can(session.role, "payroll_run.pay") && wide;
  const open = run.status === "draft" || run.status === "reviewed";
  const accounts = run.status === "approved" && pay ? await listPayingAccounts(session) : [];
  // Step 42: the bank file is for whoever prepares or makes the payment, across the whole company.
  const banker = (can(session.role, "payroll.manage") || pay) && wide;
  const bankFile = (run.status === "approved" || run.status === "paid") && banker ? await getBankFile(session, run.id) : null;
  const journal = approvalJournal(run);
  return (
    <>
      <PageHead title={`Payroll for ${monthName(run.month)}`} sub={`${RUN_STATUS_LABELS[run.status]}${run.number ? `, ${run.number}` : ""}`} />
      <PayrollNav here="runs" />
      <div className="flex max-w-6xl flex-col gap-5">
        <Stage run={run} />
        <div className="grid gap-5 md:grid-cols-2">
          <Card title="Totals">
            <Totals run={run} />
          </Card>
          <Card title={run.journalId ? "In the books" : "What approval puts in the books"}>
            <table aria-label="Journal" className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Account</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Debit</th>
                  <th className="py-1.5 text-right font-medium">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {journal.map((line) => (
                  <tr key={line.account}>
                    <td className="py-1.5 pr-3">{line.account}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{line.debit.isZero() ? "" : amount(line.debit)}</td>
                    <td className="py-1.5 text-right tabular-nums">{line.credit.isZero() ? "" : amount(line.credit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted-foreground">
              Commission was expensed when it was earned; here it moves from Commission payable to what the people are owed, and is never expensed again.
              {run.journalId ? (
                <>
                  {" "}
                  <Link href={`/journals/${run.journalId}`} className="underline underline-offset-4">
                    Open the journal
                  </Link>
                  {run.paymentJournalId ? (
                    <>
                      {" · "}
                      <Link href={`/journals/${run.paymentJournalId}`} className="underline underline-offset-4">
                        the payment
                      </Link>
                    </>
                  ) : null}
                </>
              ) : null}
            </p>
          </Card>
        </div>

        <Card title="Payslips">
          <div className="overflow-x-auto">
            <table aria-label="Payslips" className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Code</th>
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 text-right font-medium">Days paid</th>
                  <th className="py-2 pr-3 text-right font-medium">Pay</th>
                  <th className="py-2 pr-3 text-right font-medium">Commission</th>
                  <th className="py-2 pr-3 text-right font-medium">Income tax</th>
                  <th className="py-2 pr-3 text-right font-medium">EOBI</th>
                  <th className="py-2 pr-3 text-right font-medium">Deductions</th>
                  <th className="py-2 text-right font-medium">Take home</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {run.payslips.map((slip) => (
                  <tr key={slip.id}>
                    <td className="py-2 pr-3 font-medium">
                      <Link href={`/payroll/payslips/${slip.id}`} className="underline-offset-4 hover:underline">
                        {slip.code}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">{slip.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{slip.daysWorked.toFixed()}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{amount(slip.earnings)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{amount(slip.commission)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{amount(slip.tax)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{amount(slip.eobiEmployee)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{amount(slip.deductions)}</td>
                    <td className="py-2 text-right tabular-nums">{amount(slip.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {open && manage ? (
          <div className="grid gap-5 md:grid-cols-2">
            <Card title="Work it out again">
              <p className="mb-3 text-sm text-muted-foreground">After a change to someone&apos;s pay, attendance or commission. The run becomes a draft again and is reviewed again.</p>
              <ActionForm action={workOutRunAction} submitLabel="Work out again">
                <input type="hidden" name="month" value={run.month.slice(0, 7)} />
              </ActionForm>
            </Card>
            {run.status === "draft" ? (
              <Card title="Review">
                <p className="mb-3 text-sm text-muted-foreground">Say the payslips are right. The owner or an accountant approves the run next.</p>
                <ActionForm action={reviewRunAction.bind(null, run.id)} submitLabel="Mark as reviewed" />
              </Card>
            ) : null}
          </div>
        ) : null}
        {run.status === "reviewed" && approve ? (
          <Card title="Approve">
            <p className="mb-3 text-sm text-muted-foreground">
              Puts the run in the books, dated {formatIsoDate(monthEnd(run.month))} or today if sooner,
              and settles the commission it carries. Refused if anyone&apos;s commission has changed since the run was worked out.
            </p>
            <ActionForm action={approveRunAction.bind(null, run.id)} submitLabel="Approve" />
          </Card>
        ) : null}
        {run.status === "approved" && pay ? (
          <Card title="Pay the salaries">
            <ActionForm action={payRunAction.bind(null, run.id)} submitLabel="Record the payment">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Paid on" name="date" type="date" defaultValue={todayIso(new Date())} min={run.journalDate ?? undefined} max={todayIso(new Date())} required />
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="accountId">From</Label>
                  <select id="accountId" name="accountId" className={SELECT} required defaultValue="">
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
              </div>
            </ActionForm>
          </Card>
        ) : null}
        {bankFile ? (
          <Card title="Bank file">
            {"missing" in bankFile ? (
              <p className="text-sm text-muted-foreground" data-testid="bank-file-missing">
                The bank file pays each person to the IBAN on their page. None is on record for{" "}
                {bankFile.missing.map((m, index) => (
                  <span key={m.id}>
                    {index > 0 ? ", " : ""}
                    <Link href={`/payroll/employees/${m.id}`} className="underline underline-offset-4">
                      {m.code} {m.name}
                    </Link>
                  </span>
                ))}
                .
              </p>
            ) : "problems" in bankFile ? (
              <div className="text-sm" data-testid="bank-file-problems">
                <p className="mb-2 text-muted-foreground">A bank would refuse this file as the details stand. Put each right on the person&apos;s page:</p>
                <ul className="list-disc pl-5">
                  {bankFile.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <>
                <p className="mb-3 text-sm text-muted-foreground">One line for each person with pay to take home, to the IBAN on their page, to upload to the bank.</p>
                {bankFile.changed.length > 0 ? (
                  <div className="mb-3 rounded-lg border border-destructive/40 p-3 text-sm" data-testid="bank-file-changed">
                    <p className="mb-1 font-medium">Bank details changed after this run was approved. Check each with the person before uploading:</p>
                    <ul className="list-disc pl-5">
                      {bankFile.changed.map((c) => (
                        <li key={c.id}>
                          <Link href={`/payroll/employees/${c.id}`} className="underline underline-offset-4">
                            {c.code} {c.name}
                          </Link>
                          , {formatDateTime(new Date(c.at))}
                          {c.by ? `, by ${c.by}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <a href={`/payroll/runs/${run.id}/bank-file`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Download the bank file
                </a>
              </>
            )}
          </Card>
        ) : null}
        {open && manage ? (
          <Card title="Cancel the run">
            <ActionForm action={cancelRunAction.bind(null, run.id)} submitLabel="Cancel the run">
              <Field label="Why" name="reason" required minLength={3} maxLength={300} />
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}

// ── Payslips ────────────────────────────────────────────────────────────────────────────────────

export async function PayslipsScreen({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Payslips" why={why} />;
  const runs = (await listRuns(session)).filter((run) => run.status !== "cancelled");
  const asked = (await searchParams).month;
  const wanted = typeof asked === "string" && isMonth(`${asked}-01`) ? `${asked}-01` : (runs[0]?.month ?? null);
  const chosen = runs.find((run) => run.month === wanted) ?? null;
  const run = chosen ? await getRun(session, chosen.id) : null;
  return (
    <>
      <PageHead title="Payslips" sub="Each person's payslip for a month, to print or download as a PDF." />
      <PayrollNav here="payslips" />
      <div className="flex max-w-5xl flex-col gap-5">
        {runs.length === 0 ? (
          <Card>
            <Empty>No payroll has been worked out yet.</Empty>
          </Card>
        ) : (
          <>
            <form className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="month">Month</Label>
                <select id="month" name="month" className={SELECT} defaultValue={wanted?.slice(0, 7)}>
                  {runs.map((r) => (
                    <option key={r.id} value={r.month.slice(0, 7)}>
                      {monthName(r.month)} ({RUN_STATUS_LABELS[r.status]})
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className={buttonVariants({ variant: "outline" })}>
                Show
              </button>
            </form>
            <Card title={run ? `${monthName(run.month)}, ${RUN_STATUS_LABELS[run.status].toLowerCase()}` : undefined}>
              {!run || run.payslips.length === 0 ? (
                <Empty>No payslips for this month.</Empty>
              ) : (
                <ul className="divide-y text-sm" aria-label="Payslips">
                  {run.payslips.map((slip) => (
                    <li key={slip.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <Link href={`/payroll/payslips/${slip.id}`} className="font-medium underline-offset-4 hover:underline">
                        {slip.code} {slip.name}
                      </Link>
                      <span className="tabular-nums">Take home {amount(slip.net)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </>
  );
}

function SlipLines({ slip, kind, title }: { slip: PayslipRow; kind: "earning" | "deduction" | "employer"; title: string }) {
  const lines = slip.lines.filter((line) => line.kind === kind);
  return (
    <Card title={title}>
      {lines.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <dl className="divide-y">
          {lines.map((line) => (
            <Figure key={line.code} label={line.label} value={amount(line.amount)} />
          ))}
        </dl>
      )}
    </Card>
  );
}

export async function PayslipScreen({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Payslip" why={why} />;
  const { id } = await params;
  const found = await getPayslip(session, id);
  if (!found) notFound();
  const { run, payslip: slip } = found;
  const days = slip.payBasis === "daily" ? `${slip.daysWorked.toFixed()} days worked` : `${slip.daysWorked.toFixed()} of ${slip.daysInMonth} days paid${slip.unpaidDays.gt(0) ? `, ${slip.unpaidDays.toFixed()} unpaid` : ""}`;
  return (
    <>
      <PageHead title={`Payslip: ${slip.name}`} sub={`${monthName(run.month)} · ${slip.code}${slip.designation ? ` · ${slip.designation}` : ""} · ${RUN_STATUS_LABELS[run.status]}${run.number ? `, ${run.number}` : ""}`} />
      <PayrollNav here="payslips" />
      <div className="flex max-w-4xl flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/payroll/runs/${run.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            The month&apos;s run
          </Link>
          <a href={`/print/payslip/${slip.id}/pdf`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Download PDF
          </a>
        </div>
        <p className="text-sm text-muted-foreground">{days}.</p>
        <div className="grid gap-5 md:grid-cols-2">
          <SlipLines slip={slip} kind="earning" title="Pay" />
          <SlipLines slip={slip} kind="deduction" title="Deductions" />
        </div>
        <Card title="Take home">
          <p className="text-2xl font-semibold tabular-nums" data-testid="payslip-net">
            {amount(slip.net)}
          </p>
        </Card>
        <div className="grid gap-5 md:grid-cols-2">
          <SlipLines slip={slip} kind="employer" title="Paid by the employer on top" />
          <Card title="Income tax for the year (s.149)">
            <dl className="divide-y">
              <Figure label="Taxable pay earlier this tax year, run here" value={amount(slip.taxableBefore)} />
              {slip.assumedMonths > 0 ? <Figure label={`Taken as paid before payroll was run here (${slip.assumedMonths} ${slip.assumedMonths === 1 ? "month" : "months"})`} value={amount(slip.assumedTaxable)} /> : null}
              <Figure label="Taxable pay this month" value={amount(slip.taxable)} />
              <Figure label="Taxable pay expected for the year" value={amount(slip.annualTaxable)} />
              <Figure label="Tax on it for the year" value={amount(slip.annualTax)} />
              <Figure label="Deducted earlier this tax year, run here" value={amount(slip.taxBefore)} />
              {slip.assumedMonths > 0 ? <Figure label="Taken as deducted before payroll was run here" value={amount(slip.assumedTax)} /> : null}
              <Figure label="Months left, this one included" value={String(slip.monthsLeft)} />
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
