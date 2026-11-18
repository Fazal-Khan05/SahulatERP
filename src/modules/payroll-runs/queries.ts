import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { accounts } from "@/modules/ledger/schema";
import { requirePayroll } from "@/modules/payroll/queries";
import type { PayBasis } from "@/modules/payroll/rules";
import { employees } from "@/modules/payroll/schema";
import type { TenantContext } from "@/modules/tenant/rules";
import type { LineKind, RunStatus } from "./rules";
import { payrollRuns, payslipLines, payslips } from "./schema";

// What the payroll run screens read (Step 41). The database's policies let the owner, the payroll
// administrator, the accountant and the auditor who work in every branch read runs and payslips.

const exact = (value: string) => new Decimal(value);

export type RunFigures = {
  earnings: Decimal;
  commission: Decimal;
  tax: Decimal;
  eobiEmployee: Decimal;
  deductions: Decimal;
  loanRecovery: Decimal;
  net: Decimal;
  employerEobi: Decimal;
  employerSocialSecurity: Decimal;
};

export type RunRow = RunFigures & { id: string; month: string; status: RunStatus; number: string | null; people: number };

const figures = (row: typeof payrollRuns.$inferSelect): RunFigures => ({
  earnings: exact(row.earnings),
  commission: exact(row.commission),
  tax: exact(row.tax),
  eobiEmployee: exact(row.eobiEmployee),
  deductions: exact(row.deductions),
  loanRecovery: exact(row.loanRecovery),
  net: exact(row.net),
  employerEobi: exact(row.employerEobi),
  employerSocialSecurity: exact(row.employerSocialSecurity),
});

/** The company's runs, the latest month first. */
export async function listRuns(ctx: TenantContext): Promise<RunRow[]> {
  requirePayroll(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ run: payrollRuns, people: sql<number>`(select count(*)::int from public.payslips p where p.tenant_id = ${payrollRuns.tenantId} and p.run_id = ${payrollRuns.id})` })
      .from(payrollRuns)
      .where(eq(payrollRuns.tenantId, ctx.tenantId))
      .orderBy(desc(payrollRuns.month), desc(payrollRuns.createdAt))
      .limit(240);
    return rows.map(({ run, people }) => ({ id: run.id, month: run.month, status: run.status as RunStatus, number: run.number, people, ...figures(run) }));
  });
}

export type PayslipRow = {
  id: string;
  employeeId: string;
  code: string;
  name: string;
  designation: string | null;
  payBasis: PayBasis;
  daysInMonth: number;
  daysEmployed: number;
  daysWorked: Decimal;
  unpaidDays: Decimal;
  earnings: Decimal;
  commission: Decimal;
  commissionRecovered: Decimal;
  taxable: Decimal;
  tax: Decimal;
  eobiEmployee: Decimal;
  deductions: Decimal;
  net: Decimal;
  employerEobi: Decimal;
  employerSocialSecurity: Decimal;
  taxableBefore: Decimal;
  taxBefore: Decimal;
  assumedMonths: number;
  assumedTaxable: Decimal;
  assumedTax: Decimal;
  monthsLeft: number;
  annualTaxable: Decimal;
  annualTax: Decimal;
  lines: { kind: LineKind; code: string; label: string; amount: Decimal }[];
};

export type RunDetail = RunFigures & {
  id: string;
  month: string;
  status: RunStatus;
  number: string | null;
  workedOutAt: Date;
  reviewedAt: Date | null;
  approvedAt: Date | null;
  journalDate: string | null;
  journalId: string | null;
  paidOn: string | null;
  paymentNumber: string | null;
  paymentJournalId: string | null;
  payAccount: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  payslips: PayslipRow[];
};

/** One run with its payslips, or null when it is not this company's. */
export async function getRun(ctx: TenantContext, id: string): Promise<RunDetail | null> {
  requirePayroll(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.tenantId, ctx.tenantId), eq(payrollRuns.id, id)));
    if (!run) return null;
    const slips = await tx
      .select({ slip: payslips, code: employees.code, name: employees.name, designation: employees.designation })
      .from(payslips)
      .innerJoin(employees, and(eq(employees.tenantId, payslips.tenantId), eq(employees.id, payslips.employeeId)))
      .where(and(eq(payslips.tenantId, ctx.tenantId), eq(payslips.runId, id)))
      .orderBy(asc(sql`lower(${employees.code})`));
    const lines =
      slips.length === 0
        ? []
        : await tx
            .select()
            .from(payslipLines)
            .where(and(eq(payslipLines.tenantId, ctx.tenantId), inArray(payslipLines.payslipId, slips.map((s) => s.slip.id))))
            .orderBy(asc(payslipLines.lineNo));
    const [account] = run.payAccountId
      ? await tx.select({ code: accounts.code, name: accounts.name }).from(accounts).where(and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.id, run.payAccountId)))
      : [];
    return {
      id: run.id,
      month: run.month,
      status: run.status as RunStatus,
      number: run.number,
      workedOutAt: run.workedOutAt,
      reviewedAt: run.reviewedAt,
      approvedAt: run.approvedAt,
      journalDate: run.journalDate,
      journalId: run.journalId,
      paidOn: run.paidOn,
      paymentNumber: run.paymentNumber,
      paymentJournalId: run.paymentJournalId,
      payAccount: account ? `${account.code} ${account.name}` : null,
      cancelledAt: run.cancelledAt,
      cancelReason: run.cancelReason,
      ...figures(run),
      payslips: slips.map(({ slip, code, name, designation }) => ({
        id: slip.id,
        employeeId: slip.employeeId,
        code,
        name,
        designation,
        payBasis: slip.payBasis as PayBasis,
        daysInMonth: slip.daysInMonth,
        daysEmployed: slip.daysEmployed,
        daysWorked: exact(slip.daysWorked),
        unpaidDays: exact(slip.unpaidDays),
        earnings: exact(slip.earnings),
        commission: exact(slip.commission),
        commissionRecovered: exact(slip.commissionRecovered),
        taxable: exact(slip.taxable),
        tax: exact(slip.tax),
        eobiEmployee: exact(slip.eobiEmployee),
        deductions: exact(slip.deductions),
        net: exact(slip.net),
        employerEobi: exact(slip.employerEobi),
        employerSocialSecurity: exact(slip.employerSocialSecurity),
        taxableBefore: exact(slip.taxableBefore),
        taxBefore: exact(slip.taxBefore),
        assumedMonths: slip.assumedMonths,
        assumedTaxable: exact(slip.assumedTaxable),
        assumedTax: exact(slip.assumedTax),
        monthsLeft: slip.monthsLeft,
        annualTaxable: exact(slip.annualTaxable),
        annualTax: exact(slip.annualTax),
        lines: lines
          .filter((line) => line.payslipId === slip.id)
          .map((line) => ({ kind: line.kind as LineKind, code: line.code, label: line.label, amount: exact(line.amount) })),
      })),
    };
  });
}

/** One payslip with its run, or null when it is not this company's. */
export async function getPayslip(ctx: TenantContext, id: string): Promise<{ run: Omit<RunDetail, "payslips">; payslip: PayslipRow } | null> {
  requirePayroll(ctx);
  if (!isUuid(id)) return null;
  const runId = await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [row] = await tx.select({ runId: payslips.runId }).from(payslips).where(and(eq(payslips.tenantId, ctx.tenantId), eq(payslips.id, id)));
    return row?.runId ?? null;
  });
  if (!runId) return null;
  const run = await getRun(ctx, runId);
  const payslip = run?.payslips.find((p) => p.id === id);
  if (!run || !payslip) return null;
  return { run, payslip };
}

/** The cash and bank accounts salaries can be paid from. */
export async function listPayingAccounts(ctx: TenantContext): Promise<{ id: string; label: string }[]> {
  requirePayroll(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.tenantId, ctx.tenantId), inArray(accounts.controlType, ["cash", "bank"]), eq(accounts.isGroup, false), sql`${accounts.archivedAt} is null`))
      .orderBy(asc(accounts.code));
    return rows.map((r) => ({ id: r.id, label: `${r.code} ${r.name}` }));
  });
}

/** A payslip's PDF file name: payslip-E-001-2026-11.pdf. */
export function payslipFileName(code: string, month: string): string {
  return `payslip-${code.replace(/[^A-Za-z0-9._-]/g, "-")}-${month.slice(0, 7)}.pdf`;
}
