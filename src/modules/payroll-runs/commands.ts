import "server-only";
import Decimal from "decimal.js";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { audit, isUuid, withTenant, type Tx } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { AMOUNT_SCALE } from "@/lib/money";
import { cleanText } from "@/lib/text";
import { isIsoDate } from "@/modules/currencies/rules";
import { periodRefusal } from "@/modules/numbering/rules";
import { selectPayrollTables, slabsOn } from "@/modules/payroll/queries";
import { isMonth, type Component, type PayBasis, type PayRow, type Province } from "@/modules/payroll/rules";
import { employeeAttendance, employeePay, employees } from "@/modules/payroll/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { monthEnd, monthOf, NO_COMMISSION, runTotals, taxYearStart, workOutPayslip, type CommissionBasis, type Payslip } from "./rules";
import { payrollRuns, payslipLines, payslips } from "./schema";

// The commands behind the payroll run screens (Step 41). The app works a run out and writes it
// as a draft; reviewing, approving, paying and cancelling are the database's own acts
// (drizzle/0033_payroll_runs.sql), which put the run in the books and settle its commission.

const money = (value: Decimal) => value.toFixed(AMOUNT_SCALE);
const exact = (value: string) => new Decimal(value);
const NOT_HERE = "That payroll run is not in this company.";

function requireCompanyWide(ctx: TenantContext): void {
  if (ctx.branchIds !== null) throw new UserError("Payroll is run by someone who works across the whole company, not in some branches only.");
}

/** What the database refused, in words for the person, or null for anything unexpected. */
function refusal(error: unknown, date: string): UserError | null {
  const code = pgCode(error);
  const closed = periodRefusal(code, date);
  if (closed) return new UserError(closed);
  if (code === "SE015") return new UserError("That date is before the day the books were opened.");
  if (code === "SE064") return new UserError("The chart of accounts is missing an account that payroll posts to. Set the company up first.");
  if (code === "SE350") return new UserError("Someone's commission has changed since this run was worked out. Work the run out again, then review and approve it.");
  if (code === "SE353") return new UserError(NOT_HERE);
  if (code === "SE354") return new UserError("The run is not at that stage any more. Reload the page.");
  if (code === "SE355") return new UserError("That date cannot be used: a month is approved once it has begun, and salaries are paid on or after the day the run was approved, never on a day still to come.");
  if (code === "SE356") return new UserError("The run is out of date: an earlier month was approved since, or its figures no longer add up. Work it out again.");
  if (code === "SE357") return new UserError("A receipt, a cheque or a return is being recorded on a salesperson's invoice right now. Try again in a moment.");
  if (code === "SE358") return new UserError("Some of the commission was released after the run's date. Approve the run on or after that day.");
  if (code === "SE359") return new UserError("Choose a cash or bank account that is in use. An archived account cannot be used: restore it first under Chart of accounts.");
  if (code === "SE351" || code === "SE352" || code === "SE074") return new UserError("That could not be done as it stands. Reload the page and try again.");
  if (code === "42501") return new UserError("Your role does not permit this action.");
  return null;
}

export type WorkOutProblem = { code: string; name: string; reason: string };
export type WorkOutOutcome = { id: string } | { problems: WorkOutProblem[] };

type EmployeeRow = typeof employees.$inferSelect;

async function loadPayslips(tx: Tx, tenantId: string, month: string): Promise<{ payslips: Payslip[]; problems: WorkOutProblem[]; staff: EmployeeRow[] }> {
  const last = monthEnd(month);
  const staff = await tx
    .select()
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), sql`${employees.joinedOn} <= ${last}`, or(isNull(employees.leftOn), sql`${employees.leftOn} >= ${month}`)))
    .orderBy(asc(sql`lower(${employees.code})`));
  if (staff.length === 0) return { payslips: [], problems: [], staff };
  const ids = staff.map((e) => e.id);
  const payRows = await tx
    .select({ employeeId: employeePay.employeeId, component: employeePay.component, amount: employeePay.amount, effectiveFrom: employeePay.effectiveFrom })
    .from(employeePay)
    .where(and(eq(employeePay.tenantId, tenantId), inArray(employeePay.employeeId, ids)))
    .orderBy(asc(employeePay.effectiveFrom));
  const days = await tx
    .select({ employeeId: employeeAttendance.employeeId, daysWorked: employeeAttendance.daysWorked, unpaidDays: employeeAttendance.unpaidDays })
    .from(employeeAttendance)
    .where(and(eq(employeeAttendance.tenantId, tenantId), eq(employeeAttendance.month, month)));
  // What each person's approved payslips earlier in this tax year came to.
  const before = await tx
    .select({
      employeeId: payslips.employeeId,
      taxable: sql<string>`sum(${payslips.taxable})::text`,
      tax: sql<string>`sum(${payslips.tax})::text`,
      months: sql<number>`count(*)::int`,
    })
    .from(payslips)
    .innerJoin(payrollRuns, and(eq(payrollRuns.tenantId, payslips.tenantId), eq(payrollRuns.id, payslips.runId)))
    .where(
      and(
        eq(payslips.tenantId, tenantId),
        inArray(payrollRuns.status, ["approved", "paid"]),
        sql`${payrollRuns.month} >= ${taxYearStart(month)}`,
        sql`${payrollRuns.month} < ${month}`,
      ),
    )
    .groupBy(payslips.employeeId);
  const tables = await selectPayrollTables(tx, tenantId);
  const slabs = slabsOn(tables, last);

  const payslipsOut: Payslip[] = [];
  const problems: WorkOutProblem[] = [];
  for (const employee of staff) {
    let commission: CommissionBasis = NO_COMMISSION;
    if (employee.userId) {
      const [row] = await tx.execute<{ basis: CommissionBasis }>(sql`select app.payroll_commission_basis(${employee.userId}::uuid) as basis`);
      commission = row.basis;
    }
    const attendance = days.find((d) => d.employeeId === employee.id);
    const earlier = before.find((b) => b.employeeId === employee.id);
    const worked = workOutPayslip({
      month,
      employee: {
        id: employee.id,
        code: employee.code,
        name: employee.name,
        payBasis: employee.payBasis as PayBasis,
        province: employee.province as Province,
        joinedOn: employee.joinedOn,
        leftOn: employee.leftOn,
        eobi: employee.eobi,
        socialSecurity: employee.socialSecurity,
        userId: employee.userId,
      },
      pay: payRows.filter((r) => r.employeeId === employee.id).map((r): PayRow => ({ component: r.component as Component, amount: exact(r.amount), effectiveFrom: r.effectiveFrom })),
      attendance: attendance ? { daysWorked: exact(attendance.daysWorked), unpaidDays: exact(attendance.unpaidDays) } : null,
      slabs,
      rates: tables.rates,
      commission,
      before: earlier ? { taxable: exact(earlier.taxable), tax: exact(earlier.tax), months: earlier.months } : { taxable: new Decimal(0), tax: new Decimal(0), months: 0 },
    });
    if (worked.ok) payslipsOut.push(worked.payslip);
    else problems.push({ code: employee.code, name: employee.name, reason: worked.reason });
  }
  return { payslips: payslipsOut, problems, staff };
}

/**
 * Works a month's payroll out: one payslip for each person employed in the month. A month that
 * already has a draft or reviewed run is worked out again, and is a draft once more; one that has
 * been approved is not. Nothing is written when anyone's payslip cannot be worked out: the
 * problems are returned instead, each with who and why.
 */
export async function workOutRun(ctx: TenantContext, rawMonth: unknown): Promise<WorkOutOutcome> {
  if (!can(ctx.role, "payroll.manage")) throw new UserError("Only the owner or the payroll administrator works out payroll.");
  requireCompanyWide(ctx);
  if (!isMonth(rawMonth)) throw new UserError("Choose the month.");
  const month = rawMonth;
  if (month > monthOf(todayIso(new Date()))) throw new UserError("That month has not begun yet.");
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.tenantId, ctx.tenantId), eq(payrollRuns.month, month), sql`${payrollRuns.status} <> 'cancelled'`))
      .for("update");
    if (existing && existing.status !== "draft" && existing.status !== "reviewed") {
      throw new UserError("This month's payroll has been approved. It stands as it is.");
    }
    const { payslips: worked, problems } = await loadPayslips(tx, ctx.tenantId, month);
    if (problems.length > 0) return { problems };
    if (worked.length === 0) throw new UserError("Nobody was employed in this month. Add employees under Payroll first.");
    const totals = runTotals(worked);
    const figures = {
      earnings: money(totals.earnings),
      commission: money(totals.commission),
      tax: money(totals.tax),
      eobi_employee: money(totals.eobiEmployee),
      deductions: money(totals.deductions),
      net: money(totals.net),
      employer_eobi: money(totals.employerEobi),
      employer_social_security: money(totals.employerSocialSecurity),
    };
    let runId: string;
    try {
      if (existing) {
        runId = existing.id;
        await tx.execute(sql`
          update public.payroll_runs set status = 'draft', earnings = ${figures.earnings}, commission = ${figures.commission}, tax = ${figures.tax},
            eobi_employee = ${figures.eobi_employee}, deductions = ${figures.deductions}, net = ${figures.net}, employer_eobi = ${figures.employer_eobi},
            employer_social_security = ${figures.employer_social_security}, updated_by = ${ctx.userId}
          where tenant_id = ${ctx.tenantId} and id = ${runId}`);
        const old = tx.select({ id: payslips.id }).from(payslips).where(and(eq(payslips.tenantId, ctx.tenantId), eq(payslips.runId, runId)));
        await tx.delete(payslipLines).where(and(eq(payslipLines.tenantId, ctx.tenantId), inArray(payslipLines.payslipId, old)));
        await tx.delete(payslips).where(and(eq(payslips.tenantId, ctx.tenantId), eq(payslips.runId, runId)));
      } else {
        const [row] = await tx.execute<{ id: string }>(sql`
          insert into public.payroll_runs (tenant_id, month, status, earnings, commission, tax, eobi_employee, deductions, net, employer_eobi, employer_social_security, created_by, updated_by)
          values (${ctx.tenantId}, ${month}, 'draft', ${figures.earnings}, ${figures.commission}, ${figures.tax}, ${figures.eobi_employee}, ${figures.deductions},
            ${figures.net}, ${figures.employer_eobi}, ${figures.employer_social_security}, ${ctx.userId}, ${ctx.userId})
          returning id`);
        runId = row.id;
      }
    } catch (error) {
      if (pgCode(error) === "23505") throw new UserError("Someone else has just worked this month out. Reload the page.");
      throw refusal(error, month) ?? error;
    }
    for (const slip of worked) {
      const [row] = await tx
        .insert(payslips)
        .values({
          tenantId: ctx.tenantId,
          runId,
          employeeId: slip.employeeId,
          userId: slip.userId,
          payBasis: slip.payBasis,
          daysInMonth: slip.daysInMonth,
          daysEmployed: slip.daysEmployed,
          daysWorked: slip.daysWorked.toFixed(1),
          unpaidDays: slip.unpaidDays.toFixed(1),
          earnings: money(slip.earnings),
          commission: money(slip.commission),
          commissionRecovered: money(slip.commissionRecovered),
          taxable: money(slip.taxable),
          tax: money(slip.tax),
          eobiEmployee: money(slip.eobiEmployee),
          deductions: money(slip.deductions),
          net: money(slip.net),
          employerEobi: money(slip.employerEobi),
          employerSocialSecurity: money(slip.employerSocialSecurity),
          taxableBefore: money(slip.taxableBefore),
          taxBefore: money(slip.taxBefore),
          assumedMonths: slip.assumedMonths,
          assumedTaxable: money(slip.assumedTaxable),
          assumedTax: money(slip.assumedTax),
          monthsLeft: slip.monthsLeft,
          annualTaxable: money(slip.annualTaxable),
          annualTax: money(slip.annualTax),
          commissionBasis: slip.commissionBasis,
          createdBy: ctx.userId,
        })
        .returning({ id: payslips.id });
      if (slip.lines.length > 0) {
        await tx.insert(payslipLines).values(
          slip.lines.map((line, index) => ({ tenantId: ctx.tenantId, payslipId: row.id, lineNo: index + 1, kind: line.kind, code: line.code, label: line.label, amount: money(line.amount) })),
        );
      }
    }
    await audit(tx, ctx, {
      action: "payroll_run.work_out",
      entity: "payroll_run",
      entityId: runId,
      before: existing ? { status: existing.status } : null,
      after: { month, people: worked.length, earnings: figures.earnings, commission: figures.commission, tax: figures.tax, net: figures.net },
    });
    return { id: runId };
  });
}

async function act<T>(ctx: TenantContext, id: unknown, date: string, call: (tx: Tx, id: string) => Promise<T>): Promise<T> {
  requireCompanyWide(ctx);
  if (!isUuid(id)) throw new UserError(NOT_HERE);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    try {
      return await call(tx, id);
    } catch (error) {
      throw refusal(error, date) ?? error;
    }
  });
}

/** The owner or the payroll administrator says a draft is right. */
export async function reviewRun(ctx: TenantContext, id: unknown): Promise<void> {
  if (!can(ctx.role, "payroll.manage")) throw new UserError("A run is reviewed by the owner or the payroll administrator.");
  await act(ctx, id, todayIso(new Date()), async (tx, run) => {
    await tx.execute(sql`select app.review_payroll_run(${run}::uuid)`);
  });
}

/** The owner or an accountant approves a reviewed run: it goes into the books, and its commission is settled. Returns its number. */
export async function approveRun(ctx: TenantContext, id: unknown): Promise<{ number: string }> {
  if (!can(ctx.role, "payroll_run.approve")) throw new UserError("A run is approved by the owner or an accountant.");
  return act(ctx, id, todayIso(new Date()), async (tx, run) => {
    const [row] = await tx.execute<{ number: string }>(sql`select app.approve_payroll_run(${run}::uuid) as number`);
    return { number: row.number };
  });
}

/** The owner or an accountant pays an approved run out of a cash or bank account. */
export async function payRun(ctx: TenantContext, id: unknown, raw: { date?: unknown; accountId?: unknown }): Promise<void> {
  if (!can(ctx.role, "payroll_run.pay")) throw new UserError("A run is paid by the owner or an accountant.");
  if (!isIsoDate(raw.date)) throw new UserError("Enter the date the salaries were paid.");
  const date = raw.date;
  if (date > todayIso(new Date())) throw new UserError("That date has not come yet. Nothing is recorded before it happens.");
  if (!isUuid(raw.accountId)) throw new UserError("Choose the cash or bank account the salaries are paid from.");
  const account = raw.accountId;
  await act(ctx, id, date, async (tx, run) => {
    await tx.execute(sql`select app.pay_payroll_run(${run}::uuid, ${account}::uuid, ${date}::date)`);
  });
}

/** The owner or the payroll administrator cancels a run before it is approved, saying why. */
export async function cancelRun(ctx: TenantContext, id: unknown, rawReason: unknown): Promise<void> {
  if (!can(ctx.role, "payroll.manage")) throw new UserError("A run is cancelled by the owner or the payroll administrator.");
  const reason = cleanText(rawReason);
  if (reason.length < 3) throw new UserError("Say why the run is cancelled.");
  if (reason.length > 300) throw new UserError("Reason: use at most 300 characters.");
  await act(ctx, id, todayIso(new Date()), async (tx, run) => {
    await tx.execute(sql`select app.cancel_payroll_run(${run}::uuid, ${reason})`);
  });
}
