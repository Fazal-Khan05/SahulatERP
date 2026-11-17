import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withTenant } from "@/db";
import { createCompany } from "@/modules/tenant/commands";
import type { TenantContext } from "@/modules/tenant/rules";
import { adminSql, deleteTenants, hasAdminDb, type AdminSql } from "../../../tests/support/admin-db";
import { importAttendance, saveEmployee, setPay, setStatutoryRate } from "./commands";
import { getEmployee, getPayrollTables, listAttendance, listEmployees, slabsOn, taxPreview } from "./queries";
import { slabProblem } from "./rules";

// Step 40 against a real database, through the app's own path (app_runtime, withTenant,
// row-level security): every company starts with the statutory tables; employees, their dated
// pay and their attendance; the acceptance (tax on Rs 150,000 a month); and who reads and keeps
// what. Skipped when the database URLs are absent.

const hasDb = hasAdminDb() && Boolean(process.env.DATABASE_URL);
const PREFIX = "zz-payroll-test";
const tenantA = randomUUID();
const roles = ["owner", "payroll_administrator", "accountant", "auditor", "salesperson"] as const;
const userIds = Object.fromEntries(roles.map((role) => [role, randomUUID()])) as Record<(typeof roles)[number], string>;
const karachi = randomUUID();
const lahore = randomUUID();
const lahoreClerk = randomUUID();
const ctx = (userId: string, role: TenantContext["role"], branchIds: string[] | null = null): TenantContext => ({ userId, email: `${role}-${userId.slice(0, 4)}@payroll.test`, tenantId: tenantA, tenantName: "x", role, branchIds });
const as = Object.fromEntries(roles.map((role) => [role, ctx(userIds[role], role)])) as Record<(typeof roles)[number], TenantContext>;
const branchClerk = ctx(lahoreClerk, "payroll_administrator", [lahore]);
const NOV = "2026-11-01";
const TODAY = "2026-11-15";

let admin: AdminSql;
let made: string | null = null;
let manager: string;
let picker: string;

async function codeOf(who: TenantContext, statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await withTenant(who.userId, who.tenantId, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}
const employee = (over: Record<string, unknown>) => ({ province: "punjab", payBasis: "monthly", joinedOn: "2026-07-01", ...over });
const file = (text: string) => ({ name: "attendance.csv", text });

describe.skipIf(!hasDb)("payroll: employees, attendance and the statutory tables", () => {
  beforeAll(async () => {
    admin = adminSql();
    const stale = await admin<{ id: string }[]>`select id from public.tenants where name like ${PREFIX + "%"}`;
    await deleteTenants(admin, stale.map((r) => r.id));
    await admin`insert into public.tenants (id, name, created_by) values (${tenantA}, ${PREFIX + " A"}, ${userIds.owner})`;
    await admin`insert into public.branches (id, tenant_id, name, created_by) values (${karachi}, ${tenantA}, 'Karachi', ${userIds.owner}), (${lahore}, ${tenantA}, 'Lahore', ${userIds.owner})`;
    await admin`insert into public.memberships ${admin([
      ...roles.map((role) => ({ tenant_id: tenantA, user_id: userIds[role], email: as[role].email, role, branch_ids: null, created_by: userIds.owner })),
      { tenant_id: tenantA, user_id: lahoreClerk, email: branchClerk.email, role: "payroll_administrator", branch_ids: [lahore], created_by: userIds.owner },
    ])}`;
  }, 120_000);

  afterAll(async () => {
    await deleteTenants(admin, [tenantA, ...(made ? [made] : [])]);
    await admin.end();
    await closeDb();
  }, 120_000);

  it("gives every company the statutory tables read in a primary source, whole", async () => {
    const tables = await getPayrollTables(as.salesperson);
    expect(tables.slabs.length).toBe(14);
    expect(tables.rates.length).toBe(16);
    for (const from of ["2025-07-01", "2026-07-01"]) expect(slabProblem(tables.slabs.filter((s) => s.effectiveFrom === from)), from).toBeNull();
    expect(slabsOn(tables, TODAY)?.from).toBe("2026-07-01");
    expect(slabsOn(tables, "2026-06-30")?.from).toBe("2025-07-01");
    // A company made from now on gets them too, through the app's own way of making one.
    const owner = { id: randomUUID(), email: "new-owner@payroll.test" };
    made = await createCompany(owner, `${PREFIX} new company`);
    const [counts] = await admin<{ slabs: number; rates: number }[]>`
      select (select count(*)::int from public.salary_tax_slabs where tenant_id = ${made}) as slabs, (select count(*)::int from public.statutory_rates where tenant_id = ${made}) as rates`;
    expect(counts).toEqual({ slabs: 14, rates: 16 });
  });

  it("acceptance: tax on Rs 150,000 a month is Rs 6,000 a month, as worked by hand", async () => {
    const { id } = await saveEmployee(as.owner, null, employee({ code: "E-001", name: "Imran Qureshi", designation: "Sales manager" }));
    manager = id;
    await setPay(as.owner, id, { component: "basic", amount: "150000", effectiveFrom: "2026-07-01" });
    const found = (await getEmployee(as.payroll_administrator, id, TODAY))!;
    const preview = taxPreview(await getPayrollTables(as.payroll_administrator), found.payNow, TODAY);
    expect(preview.ok && [preview.annualIncome.toFixed(2), preview.annualTax.toFixed(2), preview.monthly.toFixed(2)]).toEqual(["1800000.00", "72000.00", "6000.00"]);
  });

  it("keeps pay as dated rows: a raise from a date, a correction on the same date, nil ends a part", async () => {
    await setPay(as.payroll_administrator, manager, { component: "medical", amount: "15000", effectiveFrom: "2026-07-01" });
    await setPay(as.payroll_administrator, manager, { component: "basic", amount: "160000", effectiveFrom: "2026-10-01" });
    await setPay(as.payroll_administrator, manager, { component: "basic", amount: "165000", effectiveFrom: "2026-10-01" });
    await setPay(as.payroll_administrator, manager, { component: "fixed_deduction", amount: "2,000", effectiveFrom: "2026-10-01" });
    const september = (await getEmployee(as.owner, manager, "2026-09-30"))!;
    const now = (await getEmployee(as.owner, manager, TODAY))!;
    expect(Object.fromEntries([...september.payNow].map(([k, v]) => [k, v.toFixed()]))).toEqual({ basic: "150000", medical: "15000" });
    expect(Object.fromEntries([...now.payNow].map(([k, v]) => [k, v.toFixed()]))).toEqual({ basic: "165000", medical: "15000", fixed_deduction: "2000" });
    expect(now.payRows.length).toBe(4);
    // 180,000 paid; 15,000 medical is under 10% of basic (16,500), so all of it is exempt: 165,000 taxed.
    // 1,980,000 a year: 6,000 + 11% of 780,000 = 91,800, or 7,650 a month.
    const preview = taxPreview(await getPayrollTables(as.owner), now.payNow, TODAY);
    expect(preview.ok && [preview.taxable.toFixed(2), preview.monthly.toFixed(2)]).toEqual(["165000.00", "7650.00"]);
    await setPay(as.payroll_administrator, manager, { component: "medical", amount: "0", effectiveFrom: "2026-11-01" });
    expect((await getEmployee(as.owner, manager, TODAY))!.payNow.has("medical")).toBe(false);
    const [audit] = await admin<{ after: { part: string; amount: string } }[]>`select after from public.audit_log where tenant_id = ${tenantA} and action = 'employee.pay' and after->>'part' = 'Basic pay' and after->>'from' = '2026-10-01' and before is not null`;
    expect(audit.after.amount).toBe("165000.0000");
  });

  it("pays a daily employee a daily wage, and nothing else", async () => {
    const { id } = await saveEmployee(as.payroll_administrator, null, employee({ code: "D-001", name: "Rashid Khan", designation: "Picker", payBasis: "daily", province: "sindh", branchId: lahore }));
    picker = id;
    await setPay(as.payroll_administrator, id, { component: "daily_wage", amount: "1600", effectiveFrom: "2026-07-01" });
    await expect(setPay(as.payroll_administrator, id, { component: "basic", amount: "40000", effectiveFrom: "2026-07-01" })).rejects.toThrow("A daily employee is paid a daily wage.");
    // Past the app, the database refuses it too; and how someone is paid does not change once they have pay.
    expect(await codeOf(as.payroll_administrator, sql`insert into public.employee_pay (tenant_id, employee_id, component, amount, effective_from, created_by, updated_by) values (${tenantA}, ${id}, 'basic', 40000, '2026-07-01', ${userIds.payroll_administrator}, ${userIds.payroll_administrator})`)).toBe("SE322");
    // A setting the app's role writes itself opens nothing: the guard asks who is writing, not a setting.
    expect(
      await codeOf(
        as.payroll_administrator,
        sql`insert into public.employee_pay (tenant_id, employee_id, component, amount, effective_from, created_by, updated_by)
            select ${tenantA}, ${id}, 'basic', 40000, '2026-07-02', ${userIds.payroll_administrator}, ${userIds.payroll_administrator} from (select set_config('app.payroll_seed', ${tenantA}::text, true)) as s(x)`,
      ),
    ).toBe("SE322");
    await expect(saveEmployee(as.payroll_administrator, id, employee({ code: "D-001", name: "Rashid Khan", payBasis: "monthly", province: "sindh", branchId: lahore }))).rejects.toThrow("How this employee is paid cannot change");
    expect((await getEmployee(as.auditor, picker, TODAY))!.payNow.get("daily_wage")?.toFixed()).toBe("1600");
    const rows = await listEmployees(as.accountant, { on: TODAY });
    expect(rows.map((r) => `${r.code} ${r.payBasis} ${r.pay.toFixed()}`)).toEqual(["D-001 daily 1600", "E-001 monthly 165000"]);
  });

  it("refuses what is typed wrong, in plain words", async () => {
    await expect(saveEmployee(as.owner, null, employee({ code: "E 1", name: "X Y" }))).rejects.toThrow("Enter the employee's code");
    await expect(saveEmployee(as.owner, null, employee({ code: "E-009", name: "Ali", cnic: "4210-1" }))).rejects.toThrow("Enter the CNIC as 13 digits");
    await expect(saveEmployee(as.owner, null, employee({ code: "E-009", name: "Ali", province: "" }))).rejects.toThrow("Choose the province");
    await expect(saveEmployee(as.owner, null, employee({ code: "E-009", name: "Ali", leftOn: "2026-06-01" }))).rejects.toThrow("cannot be before the day they joined");
    await expect(saveEmployee(as.owner, null, employee({ code: "e-001", name: "Someone Else" }))).rejects.toThrow("Another employee already has this code");
    await expect(setPay(as.owner, manager, { component: "basic", amount: "-5", effectiveFrom: TODAY })).rejects.toThrow("Enter the amount in rupees");
  });

  it("imports a month's attendance file, all or nothing", async () => {
    const bad = await importAttendance(as.payroll_administrator, NOV, file("Code,Days worked,Unpaid days\nE-001,,2\nD-001,24.5,1\nX-404,3,\nE-001,1,\nD-001,31,\n"));
    expect("problems" in bad && bad.problems.map((p) => `${p.row} ${p.name}: ${p.problems.join(" ")}`)).toEqual([
      "3 D-001: A daily employee is paid for the days worked; leave unpaid days empty.",
      "4 X-404: No employee has this code.",
      "5 E-001: This employee is in the file twice.",
      "6 D-001: This employee is in the file twice. Days worked: The month has 30 days.",
    ]);
    expect((await listAttendance(as.owner, NOV)).every((row) => row.daysWorked === null)).toBe(true);

    expect(await importAttendance(as.payroll_administrator, NOV, file("code,days worked,unpaid days\ne-001,,2\nD-001,24.5,\n"))).toEqual({ imported: 2 });
    expect((await listAttendance(as.auditor, NOV)).map((r) => `${r.code} ${r.daysWorked?.toFixed()} ${r.unpaidDays?.toFixed()}`)).toEqual(["D-001 24.5 0", "E-001 0 2"]);
    // Imported again, the file's rows replace what was there, and the audit log keeps what they replaced.
    expect(await importAttendance(as.payroll_administrator, NOV, file("Code,Days worked,Unpaid days\nE-001,,1.5\n"))).toEqual({ imported: 1 });
    expect((await listAttendance(as.owner, NOV)).map((r) => `${r.code} ${r.unpaidDays?.toFixed()}`)).toEqual(["D-001 0", "E-001 1.5"]);
    const [replaced] = await admin<{ before: { days: { code: string; unpaid: string }[] } }[]>`select before from public.audit_log where tenant_id = ${tenantA} and action = 'attendance.import' order by at desc limit 1`;
    expect(replaced.before.days.map((d) => `${d.code} ${Number(d.unpaid)}`)).toEqual(["E-001 2"]);
    // A file without both figures is refused whole, and a daily employee's days are always given.
    await expect(importAttendance(as.owner, NOV, file("Code,Unpaid days\nE-001,1\n"))).rejects.toThrow('The file needs three columns: "Code", "Days worked" and "Unpaid days".');
    const blank = await importAttendance(as.owner, NOV, file("Code,Days worked,Unpaid days\nD-001,,\n"));
    expect("problems" in blank && blank.problems[0].problems).toEqual(["Enter the days a daily employee worked, even if none."]);
    // Someone who joined on the 20th was employed for 11 days of November.
    await saveEmployee(as.owner, null, employee({ code: "E-003", name: "Late Joiner", joinedOn: "2026-11-20" }));
    const over = await importAttendance(as.owner, NOV, file("Code,Days worked,Unpaid days\nE-003,,12\n"));
    expect("problems" in over && over.problems[0].problems).toEqual(["This employee was employed for 11 days of this month; the days come to more."]);
    // Someone who had not joined, or had left, was not employed that month.
    await saveEmployee(as.owner, null, employee({ code: "E-002", name: "New Joiner", joinedOn: "2026-12-01" }));
    const late = await importAttendance(as.owner, NOV, file("Code,Days worked,Unpaid days\nE-002,,0\n"));
    expect("problems" in late && late.problems[0].problems).toEqual(["This employee was not employed in this month."]);
    await expect(importAttendance(as.owner, "2026-11-15", file("Code,Days worked,Unpaid days\nE-001,,\n"))).rejects.toThrow("Choose the month the file is for.");
    await expect(importAttendance(as.owner, NOV, file("Name,Days\nx,1\n"))).rejects.toThrow('The column "Name" is not one this import knows.');
  });

  it("shows salaries to the owner, the payroll administrator, the accountant and the auditor, and no one else", async () => {
    await expect(listEmployees(as.salesperson, { on: TODAY })).rejects.toThrow("Your role does not include payroll.");
    expect(await codeOf(as.salesperson, sql`select 1`)).toBeUndefined();
    const seen = await withTenant(userIds.salesperson, tenantA, (tx) => tx.execute<{ n: number }>(sql`select (select count(*)::int from public.employees) + (select count(*)::int from public.employee_pay) + (select count(*)::int from public.employee_attendance) as n`));
    expect(seen[0].n).toBe(0);
    for (const role of ["accountant", "auditor"] as const) {
      expect((await listEmployees(as[role], { on: TODAY })).length, role).toBe(4);
      await expect(saveEmployee(as[role], manager, employee({ code: "E-001", name: "Imran Qureshi" }))).rejects.toThrow("Only the owner or the payroll administrator");
      await expect(setPay(as[role], manager, { component: "basic", amount: "1", effectiveFrom: TODAY })).rejects.toThrow("Only the owner or the payroll administrator");
      expect(await codeOf(as[role], sql`update public.employee_pay set amount = 1 where employee_id = ${manager}`), role).toBeUndefined();
    }
    // The update above changed nothing: the policy hides the rows from them for writing.
    expect((await getEmployee(as.owner, manager, TODAY))!.payNow.get("basic")?.toFixed()).toBe("165000");
    // A payroll administrator of the Lahore branch sees Lahore's employees only.
    expect((await listEmployees(branchClerk, { on: TODAY })).map((r) => r.code)).toEqual(["D-001"]);
    expect(await getEmployee(branchClerk, manager, TODAY)).toBeNull();
    await expect(saveEmployee(branchClerk, null, employee({ code: "E-010", name: "Head Office" }))).rejects.toThrow("Choose the branch the employee works in.");
    // A linked login is a member of the company.
    await expect(saveEmployee(as.owner, manager, employee({ code: "E-001", name: "Imran Qureshi", userId: randomUUID() }))).rejects.toThrow("Choose a login of someone in this company");
    await saveEmployee(as.owner, manager, employee({ code: "E-001", name: "Imran Qureshi", userId: userIds.salesperson }));
    expect((await getEmployee(as.owner, manager, TODAY))!.userEmail).toBe(as.salesperson.email);
    // The payroll administrator cannot list the company's logins, and keeps the link as it is when saving.
    expect((await getEmployee(as.payroll_administrator, manager, TODAY))!.userEmail).toBeNull();
    await saveEmployee(as.payroll_administrator, manager, employee({ code: "E-001", name: "Imran Qureshi", designation: "Regional manager", userId: userIds.salesperson }));
    expect((await getEmployee(as.owner, manager, TODAY))!.userId).toBe(userIds.salesperson);
    // The CNIC is never written into the audit log.
    await saveEmployee(as.owner, manager, employee({ code: "E-001", name: "Imran Qureshi", cnic: "42101-1234567-1", userId: userIds.salesperson }));
    const logged = await admin<{ text: string }[]>`select coalesce(before::text, '') || after::text as text from public.audit_log where tenant_id = ${tenantA} and entity = 'employee'`;
    expect(logged.some((row) => row.text.includes("4210112345671"))).toBe(false);
  });

  it("says who changed a statutory row and when itself, whatever setting the app's role writes", async () => {
    // The guard used to let a row through when the setting app.payroll_seed named the company; the
    // app's role can write any setting. Now it asks who is writing: a change made with the setting
    // written by hand is still stamped with its own time, and a back-dated time is not kept.
    await withTenant(userIds.accountant, tenantA, (tx) =>
      tx.execute(sql`insert into public.statutory_rates (tenant_id, kind, province, effective_from, amount, legal_reference, created_by, updated_by)
        values (${tenantA}, 'minimum_wage', 'gilgit_baltistan', '2026-07-01', 38000, 'Test notification', ${userIds.accountant}, ${userIds.accountant})`),
    );
    await withTenant(userIds.accountant, tenantA, async (tx) => {
      await tx.execute(sql`select set_config('app.payroll_seed', ${tenantA}::text, true)`);
      await tx.execute(sql`update public.statutory_rates set amount = 39000, updated_at = '2001-01-01', updated_by = ${userIds.accountant} where tenant_id = ${tenantA} and province = 'gilgit_baltistan'`);
    });
    const [row] = await admin<{ amount: string; recent: boolean }[]>`
      select trim_scale(amount)::text as amount, updated_at > now() - interval '5 minutes' as recent from public.statutory_rates where tenant_id = ${tenantA} and province = 'gilgit_baltistan'`;
    expect(row).toEqual({ amount: "39000", recent: true });
    await admin`delete from public.statutory_rates where tenant_id = ${tenantA} and province = 'gilgit_baltistan'`;
  });

  it("lets the owner, an accountant and the payroll administrator add a statutory figure from a date, with its source", async () => {
    await setStatutoryRate(as.accountant, { kind: "minimum_wage", province: "balochistan", effectiveFrom: "2024-07-01", amount: "37000", legalReference: "Balochistan notification, to be confirmed" });
    await setStatutoryRate(as.payroll_administrator, { kind: "minimum_wage", province: "balochistan", effectiveFrom: "2024-07-01", amount: "37,500", legalReference: "Balochistan notification of 2024" });
    const rows = (await getPayrollTables(as.owner)).rates.filter((r) => r.kind === "minimum_wage" && r.province === "balochistan");
    expect(rows.map((r) => `${r.effectiveFrom} ${r.amount?.toFixed()} ${r.legalReference}`)).toEqual(["2024-07-01 37500 Balochistan notification of 2024"]);
    await expect(setStatutoryRate(as.salesperson, { kind: "eobi_employer", effectiveFrom: TODAY, rate: "6", legalReference: "x y" })).rejects.toThrow("Only the owner, an accountant or the payroll administrator");
    await expect(setStatutoryRate(as.owner, { kind: "minimum_wage", effectiveFrom: TODAY, amount: "1", legalReference: "x y" })).rejects.toThrow("Choose the province");
    await expect(setStatutoryRate(as.owner, { kind: "eobi_employer", effectiveFrom: TODAY, rate: "101", legalReference: "x y" })).rejects.toThrow("Enter the rate as a percentage");
    await expect(setStatutoryRate(as.owner, { kind: "eobi_employer", effectiveFrom: TODAY, rate: "5", legalReference: "" })).rejects.toThrow("Say where the figure comes from");
    // Past the app, the auditor cannot write one.
    expect(await codeOf(as.auditor, sql`insert into public.statutory_rates (tenant_id, kind, effective_from, rate, legal_reference, created_by, updated_by) values (${tenantA}, 'eobi_employer', ${TODAY}, 6, 'x y', ${userIds.auditor}, ${userIds.auditor})`)).toBe("42501");
  });
});
