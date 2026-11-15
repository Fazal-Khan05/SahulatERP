import Decimal from "decimal.js";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ImportForm } from "@/app/(app)/_parties/import-form";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { PROVINCE_LABELS } from "@/modules/parties/rules";
import { getEmployee, getPayrollTables, listAttendance, listEmployees, listMembersForLink, listPayrollBranches, slabsOn, taxPreview, type EmployeeDetail } from "@/modules/payroll/queries";
import { COMPONENTS_FOR, COMPONENT_LABELS, PAY_BASES, PROVINCES, STATUTORY_KINDS, STATUTORY_LABELS, STATUTORY_SHAPE, isMonth, statutoryOn } from "@/modules/payroll/rules";
import { can } from "@/modules/tenant/rules";
import { importAttendanceAction, saveEmployeeAction, setPayAction, setStatutoryRateAction } from "./actions";

type Session = Awaited<ReturnType<typeof requireTenant>>;

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const BASIS_LABELS = { monthly: "Monthly salary", daily: "Daily wage" } as const;

/** Why this member cannot open the payroll screens, or null. */
function closed(session: Session, also: "statutory_rate.manage" | null = null): string | null {
  if (!session.modules.payroll) return "Payroll is switched off for this company. An owner switches it on under Settings, Modules.";
  if (!can(session.role, "payroll.read") && !(also && can(session.role, also))) return "Your role does not include payroll.";
  return null;
}

function Shut({ title, why }: { title: string; why: string }) {
  return (
    <>
      <PageHead title={title} />
      <p className="text-muted-foreground">{why}</p>
    </>
  );
}

function PayrollNav({ here }: { here: "employees" | "attendance" | "rates" }) {
  const tab = (key: typeof here, href: string, label: string) => (
    <Link
      href={href}
      aria-current={key === here ? "page" : undefined}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium ${key === here ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Payroll" className="mb-4 flex flex-wrap gap-1">
      {tab("employees", "/payroll/employees", "Employees")}
      {tab("attendance", "/payroll/attendance", "Attendance")}
      {tab("rates", "/payroll/rates", "Statutory rates")}
    </nav>
  );
}

// ── Employees ───────────────────────────────────────────────────────────────────────────────────

export async function EmployeesScreen({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Employees" why={why} />;
  const query = await searchParams;
  const search = typeof query.q === "string" ? query.q : "";
  const today = todayIso(new Date());
  const rows = await listEmployees(session, { on: today, search });
  return (
    <>
      <PageHead title="Employees" sub="Who the company pays, how, and from when. Payroll runs and payslips come next." />
      <PayrollNav here="employees" />
      <Card className="max-w-5xl">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <form className="flex max-w-sm gap-2" role="search">
            <Input name="q" defaultValue={search} placeholder="Find by code or name" aria-label="Find by code or name" />
            <button type="submit" className={buttonVariants({ variant: "outline" })}>
              Find
            </button>
          </form>
          {can(session.role, "payroll.manage") ? (
            <Link href="/payroll/employees/new" className={buttonVariants({ className: "ml-auto" })}>
              New employee
            </Link>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <Empty>{search === "" ? "No employees yet." : "Nothing matches."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Employees" className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Code</th>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Works in</th>
                  <th className="py-2 pr-4 font-medium">Paid</th>
                  <th className="py-2 pr-4 text-right font-medium">Pay today</th>
                  <th className="py-2 font-medium">Since</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id} className={row.leftOn !== null && row.leftOn < today ? "text-muted-foreground" : undefined}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/payroll/employees/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.code}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      {row.name}
                      {row.designation ? <span className="text-muted-foreground">, {row.designation}</span> : null}
                    </td>
                    <td className="py-2 pr-4">{PROVINCE_LABELS[row.province]}</td>
                    <td className="py-2 pr-4">{row.payBasis === "daily" ? "By the day" : "Monthly"}</td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">
                      {formatAmount(row.pay)}
                      {row.payBasis === "daily" ? " a day" : ""}
                    </td>
                    <td className="py-2 whitespace-nowrap">{row.leftOn !== null && row.leftOn < today ? `Left ${formatIsoDate(row.leftOn)}` : formatIsoDate(row.joinedOn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/** The employee's own details, as a form: empty for a new one. */
async function EmployeeFields({ session, employee }: { session: Session; employee: EmployeeDetail | null }) {
  const [branches, members] = await Promise.all([listPayrollBranches(session), listMembersForLink(session)]);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]">
        <Field label="Code" name="code" defaultValue={employee?.code ?? ""} maxLength={20} autoComplete="off" required />
        <Field label="Name" name="name" defaultValue={employee?.name ?? ""} maxLength={120} autoComplete="off" required />
        <Field label="Designation" name="designation" defaultValue={employee?.designation ?? ""} maxLength={80} autoComplete="off" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="payBasis">Paid</Label>
          <select id="payBasis" name="payBasis" defaultValue={employee?.payBasis ?? "monthly"} className={SELECT}>
            {PAY_BASES.map((basis) => (
              <option key={basis} value={basis}>
                {BASIS_LABELS[basis]}
              </option>
            ))}
          </select>
        </div>
        <Field label="Joined on" name="joinedOn" type="date" defaultValue={employee?.joinedOn ?? todayIso(new Date())} required />
        <Field label="Left on" name="leftOn" type="date" defaultValue={employee?.leftOn ?? ""} hint="Empty while they still work here." />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="province">Works in (province)</Label>
          <select id="province" name="province" defaultValue={employee?.province ?? ""} required className={SELECT}>
            <option value="">Choose</option>
            {PROVINCES.map((province) => (
              <option key={province} value={province}>
                {PROVINCE_LABELS[province]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="branchId">Branch</Label>
          <select id="branchId" name="branchId" defaultValue={employee?.branchId ?? ""} className={SELECT}>
            <option value="">The whole company</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </div>
        <Field label="CNIC" name="cnic" defaultValue={employee?.cnic ?? ""} maxLength={15} inputMode="numeric" autoComplete="off" hint="13 digits. For EOBI and the yearly salary statement." />
      </div>
      <div className="flex flex-wrap gap-6 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="eobi" defaultChecked={employee?.eobi ?? false} />
          Registered with EOBI
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="socialSecurity" defaultChecked={employee?.socialSecurity ?? false} />
          Registered for social security
        </label>
      </div>
      <div className="flex max-w-sm flex-col gap-1.5">
        <Label htmlFor="userId">Signs in as</Label>
        <select id="userId" name="userId" defaultValue={employee?.userId ?? ""} className={SELECT}>
          <option value="">Does not sign in</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.email}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

export async function NewEmployeeScreen() {
  const session = await requireTenant();
  const why = closed(session) ?? (can(session.role, "payroll.manage") ? null : "Only the owner or the payroll administrator adds employees.");
  if (why) return <Shut title="New employee" why={why} />;
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/payroll/employees" className="text-muted-foreground underline-offset-4 hover:underline">
          Employees
        </Link>
      </p>
      <PageHead title="New employee" sub="Their pay is set on their page once they are added." />
      <Card className="max-w-4xl">
        <ActionForm action={saveEmployeeAction.bind(null, null, "")} submitLabel="Add employee">
          <EmployeeFields session={session} employee={null} />
        </ActionForm>
      </Card>
    </>
  );
}

export async function EmployeeScreen({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Employee" why={why} />;
  const { id } = await params;
  const today = todayIso(new Date());
  const [employee, tables] = await Promise.all([getEmployee(session, id, today), getPayrollTables(session)]);
  if (!employee) notFound();
  const manager = can(session.role, "payroll.manage");
  const monthly = employee.payBasis === "monthly";
  const preview = monthly ? taxPreview(tables, employee.payNow, today) : null;
  const deductions = employee.payNow.get("fixed_deduction");
  const gross = [...employee.payNow].filter(([component]) => component !== "fixed_deduction").reduce((sum, [, amount]) => sum.plus(amount), new Decimal(0));
  const minimum = statutoryOn(tables.rates, "minimum_wage", today, employee.province);
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/payroll/employees" className="text-muted-foreground underline-offset-4 hover:underline">
          Employees
        </Link>
      </p>
      <PageHead title={`${employee.code} ${employee.name}`} sub={`${employee.designation ? `${employee.designation}, ` : ""}${PROVINCE_LABELS[employee.province]}. ${BASIS_LABELS[employee.payBasis]}, joined ${formatIsoDate(employee.joinedOn)}${employee.leftOn ? `, left ${formatIsoDate(employee.leftOn)}` : ""}.`} />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card title="Pay today">
          {employee.payNow.size === 0 ? (
            <Empty>No pay is set yet.</Empty>
          ) : (
            <table aria-label="Pay today" className="w-full max-w-lg text-left text-sm">
              <tbody className="divide-y">
                {[...employee.payNow].map(([component, amount]) => (
                  <tr key={component}>
                    <td className="py-2 pr-4">{COMPONENT_LABELS[component]}</td>
                    <td className="py-2 text-right tabular-nums">{component === "fixed_deduction" ? `(${formatAmount(amount)})` : formatAmount(amount)}</td>
                  </tr>
                ))}
                {monthly ? (
                  <tr className="font-semibold">
                    <td className="py-2 pr-4">A month, before tax and deductions</td>
                    <td className="py-2 text-right tabular-nums" data-testid="employee-gross">
                      {formatAmount(gross)}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
          {monthly && preview ? (
            preview.ok ? (
              <p className="mt-3 text-sm" data-testid="employee-tax">
                Income tax on this pay: {formatAmount(preview.monthly)} a month ({formatAmount(preview.annualTax)} on {formatAmount(preview.annualIncome)} a year
                {preview.medicalExempt && employee.payNow.has("medical") ? ", the medical allowance exempt up to 10% of basic pay" : ""}), from the table in force since {formatIsoDate(preview.tableFrom)}.
                {deductions ? ` The fixed deduction of ${formatAmount(deductions)} comes off the pay, not off what is taxed.` : ""}
              </p>
            ) : (
              <p className="mt-3 text-sm text-destructive">{preview.reason}</p>
            )
          ) : null}
          {minimum?.amount ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Minimum wage in {PROVINCE_LABELS[employee.province]}: {formatAmount(minimum.amount)} a month, from {formatIsoDate(minimum.effectiveFrom)}.
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">No minimum wage is entered for {PROVINCE_LABELS[employee.province]} yet: add it under Statutory rates.</p>
          )}
        </Card>

        {manager ? (
          <Card title="Change pay from a date">
            <ActionForm action={setPayAction.bind(null, employee.id)} submitLabel="Save pay">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="component">Part of the pay</Label>
                  <select id="component" name="component" className={SELECT}>
                    {COMPONENTS_FOR[employee.payBasis].map((component) => (
                      <option key={component} value={component}>
                        {COMPONENT_LABELS[component]}
                      </option>
                    ))}
                  </select>
                </div>
                <Field label={monthly ? "Amount a month" : "Amount a day"} name="amount" inputMode="decimal" autoComplete="off" required hint="Nil ends this part of the pay." />
                <Field label="From" name="effectiveFrom" type="date" defaultValue={today} required />
              </div>
            </ActionForm>
          </Card>
        ) : null}

        <Card title="Pay history">
          {employee.payRows.length === 0 ? (
            <Empty>Nothing yet.</Empty>
          ) : (
            <table aria-label="Pay history" className="w-full max-w-2xl text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">From</th>
                  <th className="py-2 pr-4 font-medium">Part</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {employee.payRows.map((row) => (
                  <tr key={`${row.component}-${row.effectiveFrom}`}>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.effectiveFrom)}</td>
                    <td className="py-2 pr-4">{COMPONENT_LABELS[row.component]}</td>
                    <td className="py-2 text-right tabular-nums">{row.amount.isZero() ? "Ended" : formatAmount(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Attendance">
          {employee.attendance.length === 0 ? (
            <Empty>No attendance entered yet.</Empty>
          ) : (
            <table aria-label="Attendance by month" className="w-full max-w-lg text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Month</th>
                  <th className="py-2 pr-4 text-right font-medium">Days worked</th>
                  <th className="py-2 text-right font-medium">Unpaid days</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {employee.attendance.map((row) => (
                  <tr key={row.month}>
                    <td className="py-2 pr-4">{monthName(row.month)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.daysWorked.toFixed()}</td>
                    <td className="py-2 text-right tabular-nums">{row.unpaidDays.toFixed()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {manager ? (
          <Card title="Details">
            <ActionForm action={saveEmployeeAction.bind(null, employee.id, employee.updatedAt.toISOString())} submitLabel="Save details">
              <EmployeeFields session={session} employee={employee} />
            </ActionForm>
          </Card>
        ) : (
          <Card title="Details">
            <dl className="grid max-w-2xl grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">CNIC</dt>
              <dd>{employee.cnic ?? "Not given"}</dd>
              <dt className="text-muted-foreground">Branch</dt>
              <dd>{employee.branchName ?? "The whole company"}</dd>
              <dt className="text-muted-foreground">EOBI</dt>
              <dd>{employee.eobi ? "Registered" : "Not registered"}</dd>
              <dt className="text-muted-foreground">Social security</dt>
              <dd>{employee.socialSecurity ? "Registered" : "Not registered"}</dd>
              <dt className="text-muted-foreground">Signs in as</dt>
              <dd>{employee.userEmail ?? "Does not sign in"}</dd>
            </dl>
          </Card>
        )}
      </div>
    </>
  );
}

// ── Attendance ──────────────────────────────────────────────────────────────────────────────────

const monthName = (month: string) => new Date(`${month}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const thisMonth = () => `${todayIso(new Date()).slice(0, 8)}01`;
const shiftMonth = (month: string, by: number) => {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1 + by, 1)).toISOString().slice(0, 10);
};

export async function AttendanceScreen({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Attendance" why={why} />;
  const asked = (await searchParams).month;
  const month = typeof asked === "string" && isMonth(`${asked}-01`) ? `${asked}-01` : thisMonth();
  const rows = await listAttendance(session, month);
  const link = (to: string, label: string) => (
    <Link href={`/payroll/attendance?month=${to.slice(0, 7)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
      {label}
    </Link>
  );
  return (
    <>
      <PageHead title="Attendance" sub="Each employee's days for a month, from the attendance file: days worked for those paid by the day, unpaid days off for those on a monthly salary." />
      <PayrollNav here="attendance" />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {link(shiftMonth(month, -1), "Previous month")}
        <h2 className="px-2 text-lg font-semibold" data-testid="attendance-month">
          {monthName(month)}
        </h2>
        {link(shiftMonth(month, 1), "Next month")}
      </div>
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          {rows.length === 0 ? (
            <Empty>Nobody was employed in this month.</Empty>
          ) : (
            <table aria-label="Attendance" className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Code</th>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Paid</th>
                  <th className="py-2 pr-4 text-right font-medium">Days worked</th>
                  <th className="py-2 text-right font-medium">Unpaid days</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.employeeId}>
                    <td className="py-2 pr-4 font-medium">
                      <Link href={`/payroll/employees/${row.employeeId}`} className="underline-offset-4 hover:underline">
                        {row.code}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{row.name}</td>
                    <td className="py-2 pr-4">{row.payBasis === "daily" ? "By the day" : "Monthly"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.daysWorked?.toFixed() ?? "Not entered"}</td>
                    <td className="py-2 text-right tabular-nums">{row.unpaidDays?.toFixed() ?? "Not entered"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        {can(session.role, "payroll.manage") ? (
          <Card title={`Import the attendance file for ${monthName(month)}`}>
            <p className="mb-3 text-sm text-muted-foreground">
              A CSV file with the columns <strong>Code</strong>, <strong>Days worked</strong> and <strong>Unpaid days</strong>, one row per employee, in whole or half days. If any row is wrong, nothing is
              imported and every wrong row is listed. A month imported again replaces what was there for the employees in the file.
            </p>
            <ImportForm action={importAttendanceAction.bind(null, month)} many="rows" maxBytes={800 * 1024} />
          </Card>
        ) : null}
      </div>
    </>
  );
}

// ── Statutory rates ─────────────────────────────────────────────────────────────────────────────

export async function RatesScreen() {
  const session = await requireTenant();
  const why = closed(session, "statutory_rate.manage");
  if (why) return <Shut title="Statutory rates" why={why} />;
  const today = todayIso(new Date());
  const tables = await getPayrollTables(session);
  const current = slabsOn(tables, today);
  const tableStarts = [...new Set(tables.slabs.map((s) => s.effectiveFrom))];
  return (
    <>
      <PageHead title="Statutory rates" sub="What payroll works out tax, EOBI and social security from, each from a date, with where it comes from. Checked by Claude, not an accountant: confirm them with your tax adviser." />
      <PayrollNav here="rates" />
      <div className="flex max-w-5xl flex-col gap-5">
        {tableStarts.map((from) => (
          <Card key={from} title={`Income tax on salary, from ${formatIsoDate(from)}${current?.from === from ? " (in force)" : ""}`}>
            <table aria-label={`Salary tax slabs from ${from}`} className="w-full min-w-[520px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 text-right font-medium">Taxable income a year over</th>
                  <th className="py-2 pr-4 text-right font-medium">Up to</th>
                  <th className="py-2 text-right font-medium">Tax</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {tables.slabs
                  .filter((s) => s.effectiveFrom === from)
                  .map((s) => (
                    <tr key={s.over.toFixed()}>
                      <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(s.over)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{s.upTo === null ? "No limit" : formatAmount(s.upTo)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {s.fixed.isZero() ? "" : `${formatAmount(s.fixed)} + `}
                        {s.rate.toFixed()}% of the amount over {formatAmount(s.over)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">{tables.slabs.find((s) => s.effectiveFrom === from)?.legalReference}</p>
          </Card>
        ))}
        <Card title="EOBI, social security, minimum wages and the rest">
          {tables.rates.length === 0 ? (
            <Empty>None yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Statutory rates" className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">What</th>
                    <th className="py-2 pr-4 font-medium">Province</th>
                    <th className="py-2 pr-4 font-medium">From</th>
                    <th className="py-2 pr-4 text-right font-medium">Figure</th>
                    <th className="py-2 font-medium">Where it comes from</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {tables.rates.map((row) => (
                    <tr key={`${row.kind}-${row.province}-${row.effectiveFrom}`}>
                      <td className="py-2 pr-4">{STATUTORY_LABELS[row.kind]}</td>
                      <td className="py-2 pr-4">{row.province ? PROVINCE_LABELS[row.province] : "All"}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.effectiveFrom)}</td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">
                        {row.rate !== null ? `${row.rate.toFixed()}%` : ""}
                        {row.rate !== null && row.amount !== null ? " above " : ""}
                        {row.amount !== null ? formatAmount(row.amount) : ""}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">{row.legalReference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {can(session.role, "statutory_rate.manage") ? (
          <Card title="Add a figure from a date">
            <ActionForm action={setStatutoryRateAction} submitLabel="Save figure">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kind">What</Label>
                  <select id="kind" name="kind" className={SELECT}>
                    {STATUTORY_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {STATUTORY_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="province">Province (for a minimum wage or social security)</Label>
                  <select id="province" name="province" className={SELECT}>
                    <option value="">All of Pakistan</option>
                    {PROVINCES.map((province) => (
                      <option key={province} value={province}>
                        {PROVINCE_LABELS[province]}
                      </option>
                    ))}
                  </select>
                </div>
                <Field label="From" name="effectiveFrom" type="date" defaultValue={today} required />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Rate %" name="rate" inputMode="decimal" autoComplete="off" hint={`For ${STATUTORY_KINDS.filter((k) => STATUTORY_SHAPE[k].rate).length} of the kinds: a share or a percentage.`} />
                <Field label="Amount (Rs)" name="amount" inputMode="decimal" autoComplete="off" hint="A wage a month; for the surcharge, the yearly income above which it applies." />
                <Field label="Where it comes from" name="legalReference" maxLength={200} autoComplete="off" required hint="The Act and section, or the notification's number and date." />
              </div>
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}
