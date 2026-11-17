import "server-only";
import Decimal from "decimal.js";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { isUuid, withTenant, type Tx } from "@/db";
import { UserError } from "@/lib/errors";
import { memberships } from "@/modules/tenant/schema";
import { branches } from "@/modules/tenant/schema";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { daysIn, monthlySalaryTax, payOn, statutoryOn, taxableMonthlyPay, type Component, type PayBasis, type PayRow, type Province, type Slab, type StatutoryKind, type StatutoryRow } from "./rules";
import { employeeAttendance, employeePay, employees, salaryTaxSlabs, statutoryRates } from "./schema";

export function requirePayroll(ctx: TenantContext): void {
  if (!can(ctx.role, "payroll.read")) throw new UserError("Your role does not include payroll.");
}

const exact = (value: string) => new Decimal(value);

export type EmployeeRow = {
  id: string;
  code: string;
  name: string;
  designation: string | null;
  province: Province;
  payBasis: PayBasis;
  joinedOn: string;
  leftOn: string | null;
  /** On the day asked: the month's pay before deductions for a monthly employee, the daily wage for a daily one. */
  pay: Decimal;
};

/** What a monthly employee's pay comes to before deductions, or a daily employee's wage. */
function payFigure(basis: PayBasis, pay: ReadonlyMap<Component, Decimal>): Decimal {
  if (basis === "daily") return pay.get("daily_wage") ?? new Decimal(0);
  let total = new Decimal(0);
  for (const [component, amount] of pay) if (component !== "fixed_deduction") total = total.plus(amount);
  return total;
}

async function selectPayRows(tx: Tx, tenantId: string, employeeId?: string): Promise<(PayRow & { employeeId: string })[]> {
  const rows = await tx
    .select({ employeeId: employeePay.employeeId, component: employeePay.component, amount: employeePay.amount, effectiveFrom: employeePay.effectiveFrom })
    .from(employeePay)
    .where(employeeId ? and(eq(employeePay.tenantId, tenantId), eq(employeePay.employeeId, employeeId)) : eq(employeePay.tenantId, tenantId))
    .orderBy(asc(employeePay.effectiveFrom));
  return rows.map((row) => ({ employeeId: row.employeeId, component: row.component as Component, amount: exact(row.amount), effectiveFrom: row.effectiveFrom }));
}

/** The company's employees, those still working first, with what each is paid on a day. */
export async function listEmployees(ctx: TenantContext, opts: { on: string; search?: string }): Promise<EmployeeRow[]> {
  requirePayroll(ctx);
  const typed = (opts.search ?? "").replace(/[^\P{Cc}]/gu, " ").trim().slice(0, 80);
  const pattern = `%${typed.replace(/[\\%_]/g, "\\$&")}%`;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(employees)
      .where(and(eq(employees.tenantId, ctx.tenantId), typed === "" ? undefined : or(sql`${employees.name} ilike ${pattern}`, sql`${employees.code} ilike ${pattern}`)))
      .orderBy(sql`${employees.leftOn} is not null`, asc(sql`lower(${employees.code})`))
      .limit(500);
    const pay = await selectPayRows(tx, ctx.tenantId);
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      designation: row.designation,
      province: row.province as Province,
      payBasis: row.payBasis as PayBasis,
      joinedOn: row.joinedOn,
      leftOn: row.leftOn,
      pay: payFigure(
        row.payBasis as PayBasis,
        payOn(
          pay.filter((p) => p.employeeId === row.id),
          opts.on,
        ),
      ),
    }));
  });
}

export type EmployeeDetail = {
  id: string;
  code: string;
  name: string;
  designation: string | null;
  cnic: string | null;
  province: Province;
  branchId: string | null;
  branchName: string | null;
  payBasis: PayBasis;
  joinedOn: string;
  leftOn: string | null;
  eobi: boolean;
  socialSecurity: boolean;
  userId: string | null;
  userEmail: string | null;
  updatedAt: Date;
  /** Every dated pay row, newest first. */
  payRows: PayRow[];
  /** Each component's amount on the day asked. */
  payNow: Map<Component, Decimal>;
  /** The last months' attendance, newest first. */
  attendance: { month: string; daysWorked: Decimal; unpaidDays: Decimal }[];
};

export async function getEmployee(ctx: TenantContext, id: string, on: string): Promise<EmployeeDetail | null> {
  requirePayroll(ctx);
  if (!isUuid(id)) return null;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ employee: employees, branchName: branches.name })
      .from(employees)
      .leftJoin(branches, and(eq(branches.tenantId, employees.tenantId), eq(branches.id, employees.branchId)))
      .where(and(eq(employees.tenantId, ctx.tenantId), eq(employees.id, id)));
    if (!row) return null;
    const e = row.employee;
    const payRows = await selectPayRows(tx, ctx.tenantId, id);
    const [member] = e.userId ? await tx.select({ email: memberships.email }).from(memberships).where(and(eq(memberships.tenantId, ctx.tenantId), eq(memberships.userId, e.userId))) : [];
    const attendance = await tx
      .select({ month: employeeAttendance.month, daysWorked: employeeAttendance.daysWorked, unpaidDays: employeeAttendance.unpaidDays })
      .from(employeeAttendance)
      .where(and(eq(employeeAttendance.tenantId, ctx.tenantId), eq(employeeAttendance.employeeId, id)))
      .orderBy(desc(employeeAttendance.month))
      .limit(12);
    return {
      id: e.id,
      code: e.code,
      name: e.name,
      designation: e.designation,
      cnic: e.cnic,
      province: e.province as Province,
      branchId: e.branchId,
      branchName: row.branchName,
      payBasis: e.payBasis as PayBasis,
      joinedOn: e.joinedOn,
      leftOn: e.leftOn,
      eobi: e.eobi,
      socialSecurity: e.socialSecurity,
      userId: e.userId,
      userEmail: member?.email ?? null,
      updatedAt: e.updatedAt,
      payRows: [...payRows].reverse().map(({ component, amount, effectiveFrom }) => ({ component, amount, effectiveFrom })),
      payNow: payOn(payRows, on),
      attendance: attendance.map((a) => ({ month: a.month, daysWorked: exact(a.daysWorked), unpaidDays: exact(a.unpaidDays) })),
    };
  });
}

export type PayrollTables = { slabs: (Slab & { effectiveFrom: string; legalReference: string })[]; rates: StatutoryRow[] };

export async function selectPayrollTables(tx: Tx, tenantId: string): Promise<PayrollTables> {
  const slabs = await tx.select().from(salaryTaxSlabs).where(eq(salaryTaxSlabs.tenantId, tenantId)).orderBy(desc(salaryTaxSlabs.effectiveFrom), asc(salaryTaxSlabs.over));
  const rates = await tx.select().from(statutoryRates).where(eq(statutoryRates.tenantId, tenantId)).orderBy(asc(statutoryRates.kind), asc(statutoryRates.province), desc(statutoryRates.effectiveFrom));
  return {
    slabs: slabs.map((s) => ({ effectiveFrom: s.effectiveFrom, over: exact(s.over), upTo: s.upTo === null ? null : exact(s.upTo), fixed: exact(s.fixed), rate: exact(s.rate), legalReference: s.legalReference })),
    rates: rates.map((r) => ({
      kind: r.kind as StatutoryKind,
      province: (r.province as Province | null) ?? null,
      effectiveFrom: r.effectiveFrom,
      rate: r.rate === null ? null : exact(r.rate),
      amount: r.amount === null ? null : exact(r.amount),
      legalReference: r.legalReference,
    })),
  };
}

/** The statutory tables: every member reads them, as they read the tax rates. */
export async function getPayrollTables(ctx: TenantContext): Promise<PayrollTables> {
  return withTenant(ctx.userId, ctx.tenantId, (tx) => selectPayrollTables(tx, ctx.tenantId));
}

/** The salary tax table in force on a day: the rows sharing the latest start on or before it. */
export function slabsOn(tables: PayrollTables, on: string): { from: string; slabs: Slab[] } | null {
  const from = tables.slabs.map((s) => s.effectiveFrom).filter((d) => d <= on).sort().pop();
  if (!from) return null;
  return { from, slabs: tables.slabs.filter((s) => s.effectiveFrom === from) };
}

export type TaxPreview =
  | { ok: true; taxable: Decimal; annualIncome: Decimal; annualTax: Decimal; monthly: Decimal; tableFrom: string; medicalExempt: Decimal | null }
  | { ok: false; reason: string };

/**
 * The income tax a month on a monthly employee's pay as it stands on a day, if the pay were the
 * same all year: what Step 41 deducts before it adjusts for months that differ.
 */
export function taxPreview(tables: PayrollTables, pay: ReadonlyMap<Component, Decimal>, on: string): TaxPreview {
  const table = slabsOn(tables, on);
  if (!table) return { ok: false, reason: "There is no salary tax table in force on this day." };
  const medical = statutoryOn(tables.rates, "medical_allowance_exempt", on);
  const surcharge = statutoryOn(tables.rates, "salary_surcharge", on);
  const taxable = taxableMonthlyPay(pay, medical?.rate ?? null);
  const worked = monthlySalaryTax(taxable, table.slabs, surcharge && surcharge.rate && surcharge.amount ? { rate: surcharge.rate, threshold: surcharge.amount } : null);
  if (!worked) return { ok: false, reason: "The salary tax table in force has a gap. Check it under Statutory rates." };
  return { ok: true, taxable, ...worked, tableFrom: table.from, medicalExempt: medical?.rate ?? null };
}

export type AttendanceRow = { employeeId: string; code: string; name: string; payBasis: PayBasis; daysWorked: Decimal | null; unpaidDays: Decimal | null };

/** Everyone employed in a month (joined by its last day, not left before its first), with their days if any were entered. */
export async function listAttendance(ctx: TenantContext, month: string): Promise<AttendanceRow[]> {
  requirePayroll(ctx);
  const last = `${month.slice(0, 8)}${String(daysIn(month)).padStart(2, "0")}`;
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: employees.id, code: employees.code, name: employees.name, payBasis: employees.payBasis, daysWorked: employeeAttendance.daysWorked, unpaidDays: employeeAttendance.unpaidDays })
      .from(employees)
      .leftJoin(employeeAttendance, and(eq(employeeAttendance.tenantId, employees.tenantId), eq(employeeAttendance.employeeId, employees.id), eq(employeeAttendance.month, month)))
      .where(and(eq(employees.tenantId, ctx.tenantId), sql`${employees.joinedOn} <= ${last}`, or(isNull(employees.leftOn), sql`${employees.leftOn} >= ${month}`)))
      .orderBy(asc(sql`lower(${employees.code})`));
    return rows.map((r) => ({
      employeeId: r.id,
      code: r.code,
      name: r.name,
      payBasis: r.payBasis as PayBasis,
      daysWorked: r.daysWorked === null ? null : exact(r.daysWorked),
      unpaidDays: r.unpaidDays === null ? null : exact(r.unpaidDays),
    }));
  });
}

/** The company's members, to link an employee to the login they sign in with. */
export async function listMembersForLink(ctx: TenantContext): Promise<{ userId: string; email: string }[]> {
  requirePayroll(ctx);
  return withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const rows = await tx.select({ userId: memberships.userId, email: memberships.email }).from(memberships).where(eq(memberships.tenantId, ctx.tenantId)).orderBy(asc(memberships.email));
    return rows;
  });
}

/** The company's branches, for where an employee works. */
export async function listPayrollBranches(ctx: TenantContext): Promise<{ id: string; name: string }[]> {
  requirePayroll(ctx);
  return withTenant(ctx.userId, ctx.tenantId, (tx) => tx.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.tenantId, ctx.tenantId)).orderBy(asc(branches.name)));
}
