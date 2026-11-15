import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { audit, isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { readCsvTable } from "@/lib/csv-table";
import { AMOUNT_SCALE } from "@/lib/money";
import { can, seesBranch, type TenantContext } from "@/modules/tenant/rules";
import { branches } from "@/modules/tenant/schema";
import {
  ATTENDANCE_COLUMNS,
  ATTENDANCE_MAX_ROWS,
  COMPONENT_LABELS,
  STATUTORY_LABELS,
  daysIn,
  isMonth,
  readAttendanceRows,
  readEmployee,
  readPayChange,
  readStatutoryRate,
  type AttendanceProblem,
  type PayBasis,
  type RawEmployee,
  type RawPayChange,
  type RawStatutoryRate,
} from "./rules";
import { employeeAttendance, employees } from "./schema";

// The commands behind the payroll screens (Step 40). Everything is written by the app under
// row-level security; the database's own checks stand behind each (drizzle/0030_payroll_employees.sql).
// Nothing here posts to the books: payroll runs are Step 41's.

function requireManager(ctx: TenantContext): void {
  if (!can(ctx.role, "payroll.manage")) throw new UserError("Only the owner or the payroll administrator keeps employees and their pay.");
}

const NOT_HERE = "That employee is not in this company.";
const STALE = "Someone changed this employee after you opened it. Reload the page and try again.";
const money = (value: { toFixed(scale: number): string }) => value.toFixed(AMOUNT_SCALE);

function employeeRefusal(error: unknown): UserError | null {
  const code = pgCode(error);
  if (code === "23505") return new UserError("Another employee already has this code, or is linked to that login.");
  if (code === "SE320") return new UserError("How this employee is paid cannot change: they have pay on record. Record them as having left, and add them again paid the other way.");
  if (code === "SE321") return new UserError("Choose a login of someone in this company, or none.");
  if (code === "SE322") return new UserError("A daily employee is paid a daily wage, and a monthly employee basic pay and allowances.");
  return null;
}

/** Adds an employee, or changes one. Returns its id. */
export async function saveEmployee(ctx: TenantContext, id: unknown, raw: RawEmployee, loadedAt?: unknown): Promise<{ id: string }> {
  requireManager(ctx);
  const read = readEmployee(raw);
  if (!read.ok) throw new UserError(read.reason);
  const input = read.employee;
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      if (input.branchId !== null) {
        if (!isUuid(input.branchId) || !seesBranch(ctx.branchIds, input.branchId)) throw new UserError("Choose one of your branches.");
        const [branch] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, ctx.tenantId), eq(branches.id, input.branchId)));
        if (!branch) throw new UserError("Choose one of your branches.");
      } else if (ctx.branchIds !== null) {
        throw new UserError("Choose the branch the employee works in.");
      }
      if (input.userId !== null && !isUuid(input.userId)) throw new UserError("Choose a login of someone in this company, or none.");
      // What the audit log keeps: who the employee is, never their CNIC.
      const describe = { code: input.code, name: input.name, province: input.province, payBasis: input.payBasis, joinedOn: input.joinedOn, leftOn: input.leftOn, eobi: input.eobi, socialSecurity: input.socialSecurity, cnic: input.cnic === null ? "none" : "given" };
      if (id === null || id === undefined || id === "") {
        const [row] = await tx
          .insert(employees)
          .values({ tenantId: ctx.tenantId, ...input, createdBy: ctx.userId, updatedBy: ctx.userId })
          .returning({ id: employees.id });
        await audit(tx, ctx, { action: "employee.create", entity: "employee", entityId: row.id, after: describe });
        return row;
      }
      if (!isUuid(id)) throw new UserError(NOT_HERE);
      const [stored] = await tx.select().from(employees).where(and(eq(employees.tenantId, ctx.tenantId), eq(employees.id, id))).for("update");
      if (!stored) throw new UserError(NOT_HERE);
      const loaded = loadedAt instanceof Date ? loadedAt.toISOString() : loadedAt;
      if (typeof loaded === "string" && loaded !== "" && loaded !== stored.updatedAt.toISOString()) throw new UserError(STALE);
      await tx
        .update(employees)
        .set({ ...input, updatedAt: sql`now()`, updatedBy: ctx.userId })
        .where(and(eq(employees.tenantId, ctx.tenantId), eq(employees.id, id)));
      await audit(tx, ctx, {
        action: "employee.update",
        entity: "employee",
        entityId: id,
        before: { code: stored.code, name: stored.name, province: stored.province, payBasis: stored.payBasis, joinedOn: stored.joinedOn, leftOn: stored.leftOn, eobi: stored.eobi, socialSecurity: stored.socialSecurity, cnic: stored.cnic === null ? "none" : "given" },
        after: describe,
      });
      return { id };
    });
  } catch (error) {
    throw employeeRefusal(error) ?? error;
  }
}

/**
 * Sets one part of an employee's pay from a date: a new amount from then on, or nil to end it.
 * Saved again for the same part and day, it corrects that row.
 */
export async function setPay(ctx: TenantContext, employeeId: unknown, raw: RawPayChange): Promise<void> {
  requireManager(ctx);
  if (!isUuid(employeeId)) throw new UserError(NOT_HERE);
  try {
    await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [employee] = await tx
        .select({ name: employees.name, payBasis: employees.payBasis, joinedOn: employees.joinedOn })
        .from(employees)
        .where(and(eq(employees.tenantId, ctx.tenantId), eq(employees.id, employeeId)));
      if (!employee) throw new UserError(NOT_HERE);
      const read = readPayChange(raw, employee.payBasis as PayBasis);
      if (!read.ok) throw new UserError(read.reason);
      const change = read.change;
      // Written column by column: the app may name the employee, the part, the amount and the day.
      const [before] = await tx.execute<{ amount: string }>(sql`
        select amount::text from public.employee_pay where tenant_id = ${ctx.tenantId} and employee_id = ${employeeId} and component = ${change.component} and effective_from = ${change.effectiveFrom}`);
      await tx.execute(sql`
        insert into public.employee_pay (tenant_id, employee_id, component, amount, effective_from, created_by, updated_by)
        values (${ctx.tenantId}, ${employeeId}, ${change.component}, ${money(change.amount)}, ${change.effectiveFrom}, ${ctx.userId}, ${ctx.userId})
        on conflict (tenant_id, employee_id, component, effective_from) do update set amount = excluded.amount, updated_at = now(), updated_by = excluded.updated_by`);
      await audit(tx, ctx, {
        action: "employee.pay",
        entity: "employee",
        entityId: employeeId,
        before: before ? { part: COMPONENT_LABELS[change.component], from: change.effectiveFrom, amount: before.amount } : null,
        after: { part: COMPONENT_LABELS[change.component], from: change.effectiveFrom, amount: money(change.amount) },
      });
    });
  } catch (error) {
    throw employeeRefusal(error) ?? error;
  }
}

export type AttendanceOutcome = { imported: number } | { problems: AttendanceProblem[] };

/**
 * Imports a month's attendance file, all or nothing: for each employee by code, the days worked
 * and the unpaid days. A row for someone not employed that month, or a figure that does not fit
 * how they are paid, stops the import, and every bad row is returned. Rows already there for the
 * month are replaced by the file's.
 */
export async function importAttendance(ctx: TenantContext, month: unknown, file: { name: string; text: string }): Promise<AttendanceOutcome> {
  requireManager(ctx);
  if (!isMonth(month)) throw new UserError("Choose the month the file is for.");
  const table = readCsvTable(file.text, ATTENDANCE_COLUMNS, "code", ATTENDANCE_MAX_ROWS);
  if (!table.ok) throw new UserError(table.reason);
  const { lines, problems } = readAttendanceRows(table.rows, month);
  const last = `${month.slice(0, 8)}${String(daysIn(month)).padStart(2, "0")}`;
  return withTenant(ctx.userId, ctx.tenantId, async (tx): Promise<AttendanceOutcome> => {
    const staff = await tx
      .select({ id: employees.id, code: employees.code, payBasis: employees.payBasis, joinedOn: employees.joinedOn, leftOn: employees.leftOn })
      .from(employees)
      .where(eq(employees.tenantId, ctx.tenantId));
    const byCode = new Map(staff.map((e) => [e.code.toLowerCase(), e]));
    const all = [...problems];
    const ready: { id: string; line: (typeof lines)[number] }[] = [];
    for (const line of lines) {
      const employee = byCode.get(line.code.toLowerCase());
      const found: string[] = [];
      if (!employee) found.push("No employee has this code.");
      else {
        if (employee.joinedOn > last || (employee.leftOn !== null && employee.leftOn < month)) found.push("This employee was not employed in this month.");
        if (employee.payBasis === "daily" && line.unpaidDays.gt(0)) found.push("A daily employee is paid for the days worked; leave unpaid days empty.");
        if (employee.payBasis === "monthly" && line.daysWorked.gt(0) && line.daysWorked.plus(line.unpaidDays).gt(daysIn(month))) found.push("Days worked and unpaid days come to more than the month has.");
      }
      if (found.length > 0) all.push({ row: line.row, name: line.code, problems: found });
      else ready.push({ id: employee!.id, line });
    }
    if (all.length > 0) return { problems: all.sort((a, b) => a.row - b.row) };
    for (const { id, line } of ready) {
      await tx.execute(sql`
        insert into public.employee_attendance (tenant_id, employee_id, month, days_worked, unpaid_days, created_by, updated_by)
        values (${ctx.tenantId}, ${id}, ${month}, ${line.daysWorked.toFixed(1)}, ${line.unpaidDays.toFixed(1)}, ${ctx.userId}, ${ctx.userId})
        on conflict (tenant_id, employee_id, month) do update set days_worked = excluded.days_worked, unpaid_days = excluded.unpaid_days, updated_at = now(), updated_by = excluded.updated_by`);
    }
    await audit(tx, ctx, {
      action: "attendance.import",
      entity: "employee_attendance",
      after: { month, rows: ready.length, file: file.name.replace(/[\u0000-\u001f]/g, "").slice(0, 120) },
    });
    return { imported: ready.length };
  });
}

function requireRates(ctx: TenantContext): void {
  if (!can(ctx.role, "statutory_rate.manage")) throw new UserError("Only the owner, an accountant or the payroll administrator keeps the statutory rates.");
}

/**
 * Adds a statutory figure from a date, with where it comes from. A change in the law is a new
 * dated row; saved again for the same figure and day, it corrects that row.
 */
export async function setStatutoryRate(ctx: TenantContext, raw: RawStatutoryRate): Promise<void> {
  requireRates(ctx);
  const read = readStatutoryRate(raw);
  if (!read.ok) throw new UserError(read.reason);
  const row = read.row;
  await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
    const [before] = await tx.execute<{ rate: string | null; amount: string | null; legal_reference: string }>(sql`
      select rate::text, amount::text, legal_reference from public.statutory_rates
      where tenant_id = ${ctx.tenantId} and kind = ${row.kind} and province is not distinct from ${row.province}::public.province and effective_from = ${row.effectiveFrom}`);
    await tx.execute(sql`
      insert into public.statutory_rates (tenant_id, kind, province, effective_from, rate, amount, legal_reference, created_by, updated_by)
      values (${ctx.tenantId}, ${row.kind}, ${row.province}::public.province, ${row.effectiveFrom}, ${row.rate?.toFixed(4) ?? null}, ${row.amount === null ? null : money(row.amount)}, ${row.legalReference}, ${ctx.userId}, ${ctx.userId})
      on conflict (tenant_id, kind, province, effective_from) do update set rate = excluded.rate, amount = excluded.amount, legal_reference = excluded.legal_reference, updated_at = now(), updated_by = excluded.updated_by`);
    await audit(tx, ctx, {
      action: "statutory_rate.set",
      entity: "statutory_rate",
      before: before ? { rate: before.rate, amount: before.amount, legalReference: before.legal_reference } : null,
      after: { what: STATUTORY_LABELS[row.kind], province: row.province, from: row.effectiveFrom, rate: row.rate?.toFixed(4) ?? null, amount: row.amount === null ? null : money(row.amount), legalReference: row.legalReference },
    });
  });
}

export { employeeAttendance };
