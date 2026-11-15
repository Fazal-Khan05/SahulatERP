import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { province } from "../parties/schema";
import { branches, tenants } from "../tenant/schema";

// Step 40: the people a company pays, what it pays them, the days they worked, and the dated
// statutory tables payroll reads. Payroll runs and payslips are Step 41's.
//
// Salaries are read by the owner, the payroll administrator, the accountant and the auditor, and
// kept by the owner and the payroll administrator (drizzle/0030_payroll_employees.sql).

/** Someone the company pays: monthly, or by the day. Linked to a login when they have one; most do not. */
export const employees = pgTable(
  "employees",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // The company's own number for them, such as E-001.
    code: text().notNull(),
    name: text().notNull(),
    designation: text(),
    // 13 digits, no dashes; for EOBI and the yearly salary statement.
    cnic: text(),
    // Where they work: decides the minimum wage and the social security institution.
    province: province().notNull(),
    branchId: uuid("branch_id"),
    // monthly or daily.
    payBasis: text("pay_basis").notNull(),
    joinedOn: date("joined_on", { mode: "string" }).notNull(),
    leftOn: date("left_on", { mode: "string" }),
    // Registered with EOBI, and with the province's social security institution, by the company.
    eobi: boolean().notNull().default(false),
    socialSecurity: boolean("social_security").notNull().default(false),
    // The member of the company this person is, if they sign in; null for most.
    userId: uuid("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("employees_tenant_id_id_key").on(t.tenantId, t.id),
    unique("employees_tenant_user_key").on(t.tenantId, t.userId),
    uniqueIndex("employees_tenant_code_key").on(t.tenantId, sql`lower(${t.code})`),
    foreignKey({ name: "employees_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    check("employees_code_format", sql`${t.code} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$'`),
    check("employees_name_length", sql`char_length(btrim(${t.name})) between 2 and 120 and ${t.name} = btrim(${t.name})`),
    check("employees_designation_length", sql`char_length(btrim(${t.designation})) between 1 and 80`),
    check("employees_cnic_format", sql`${t.cnic} ~ '^[0-9]{13}$'`),
    check("employees_pay_basis_known", sql`${t.payBasis} in ('monthly', 'daily')`),
    check("employees_dates_in_order", sql`${t.leftOn} is null or ${t.leftOn} >= ${t.joinedOn}`),
  ],
);

/**
 * One component of an employee's pay from a date until the next row of the same component: a
 * monthly amount, or for a daily employee the wage for one day. A change is a new dated row;
 * nil ends the component. A row is corrected by saving the same component on the same date.
 */
export const employeePay = pgTable(
  "employee_pay",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id").notNull(),
    component: text().notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("employee_pay_tenant_id_id_key").on(t.tenantId, t.id),
    unique("employee_pay_component_from_key").on(t.tenantId, t.employeeId, t.component, t.effectiveFrom),
    foreignKey({ name: "employee_pay_employee_fk", columns: [t.tenantId, t.employeeId], foreignColumns: [employees.tenantId, employees.id] }),
    check("employee_pay_component_known", sql`${t.component} in ('basic', 'house_rent', 'medical', 'conveyance', 'utilities', 'other_allowance', 'fixed_deduction', 'daily_wage')`),
    check("employee_pay_amount_sane", sql`${t.amount} >= 0 and ${t.amount} < 1e12`),
  ],
);

/**
 * An employee's days for one month, as imported from the attendance file or typed: the days
 * worked (what a daily employee is paid for) and the unpaid days off (what comes off a monthly
 * salary). One row per employee per month; a new import replaces it.
 */
export const employeeAttendance = pgTable(
  "employee_attendance",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id").notNull(),
    // The first day of the month.
    month: date({ mode: "string" }).notNull(),
    daysWorked: numeric("days_worked", { precision: 4, scale: 1 }).notNull().default("0"),
    unpaidDays: numeric("unpaid_days", { precision: 4, scale: 1 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("employee_attendance_tenant_id_id_key").on(t.tenantId, t.id),
    unique("employee_attendance_month_key").on(t.tenantId, t.employeeId, t.month),
    foreignKey({ name: "employee_attendance_employee_fk", columns: [t.tenantId, t.employeeId], foreignColumns: [employees.tenantId, employees.id] }),
    index("employee_attendance_tenant_month_idx").on(t.tenantId, t.month),
    check("employee_attendance_month_first", sql`extract(day from ${t.month}) = 1`),
    check(
      "employee_attendance_days_sane",
      sql`${t.daysWorked} >= 0 and ${t.unpaidDays} >= 0 and ${t.daysWorked} * 2 = trunc(${t.daysWorked} * 2) and ${t.unpaidDays} * 2 = trunc(${t.unpaidDays} * 2)
        and ${t.daysWorked} + ${t.unpaidDays} <= extract(day from (${t.month} + interval '1 month' - interval '1 day'))`,
    ),
  ],
);

/**
 * One slab of the income tax table for salaried individuals (First Schedule, Part I, Division I),
 * from the first day of the tax year it was enacted for until the next table. A table is the
 * rows sharing one `effective_from`. Shipped with each tax year; a company may correct a row.
 */
export const salaryTaxSlabs = pgTable(
  "salary_tax_slabs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    // Taxable income a year over which the slab starts, and up to which it goes (null: no limit).
    over: numeric({ precision: 20, scale: 4 }).notNull(),
    upTo: numeric("up_to", { precision: 20, scale: 4 }),
    fixed: numeric({ precision: 20, scale: 4 }).notNull(),
    rate: numeric({ precision: 7, scale: 4 }).notNull(),
    legalReference: text("legal_reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("salary_tax_slabs_tenant_id_id_key").on(t.tenantId, t.id),
    unique("salary_tax_slabs_from_over_key").on(t.tenantId, t.effectiveFrom, t.over),
    check("salary_tax_slabs_figures_sane", sql`${t.over} >= 0 and (${t.upTo} is null or ${t.upTo} > ${t.over}) and ${t.fixed} >= 0 and ${t.rate} between 0 and 100`),
    check("salary_tax_slabs_legal_reference_length", sql`char_length(btrim(${t.legalReference})) between 2 and 200`),
  ],
);

/**
 * One statutory figure from a date until the next row of the same kind (and province, where it
 * goes by province): minimum wages, the wage EOBI is worked out on, EOBI and social security
 * shares, the exempt share of a medical allowance, the surcharge on salary tax. Shipped where a
 * primary source was read; a company adds what is missing and corrects what changes.
 */
export const statutoryRates = pgTable(
  "statutory_rates",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: text().notNull(),
    // Null for a figure that holds in every province.
    province: province(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    // A percentage, for the kinds that are one.
    rate: numeric({ precision: 7, scale: 4 }),
    // Rupees a month, for the kinds that are an amount; for the surcharge, the yearly income above which it applies.
    amount: numeric({ precision: 20, scale: 4 }),
    legalReference: text("legal_reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("statutory_rates_tenant_id_id_key").on(t.tenantId, t.id),
    unique("statutory_rates_kind_from_key").on(t.tenantId, t.kind, t.province, t.effectiveFrom).nullsNotDistinct(),
    check("statutory_rates_kind_known", sql`${t.kind} in ('minimum_wage', 'eobi_wage', 'eobi_employer', 'eobi_employee', 'social_security_employer', 'medical_allowance_exempt', 'salary_surcharge')`),
    // Each kind has the figures it needs, and goes by province or not.
    check(
      "statutory_rates_shape",
      sql`(${t.rate} is not null) = (${t.kind} in ('eobi_employer', 'eobi_employee', 'social_security_employer', 'medical_allowance_exempt', 'salary_surcharge'))
        and (${t.amount} is not null) = (${t.kind} in ('minimum_wage', 'eobi_wage', 'salary_surcharge'))
        and (${t.province} is not null) = (${t.kind} in ('minimum_wage', 'social_security_employer'))`,
    ),
    check("statutory_rates_figures_sane", sql`(${t.rate} is null or ${t.rate} between 0 and 100) and (${t.amount} is null or (${t.amount} > 0 and ${t.amount} < 1e12))`),
    check("statutory_rates_legal_reference_length", sql`char_length(btrim(${t.legalReference})) between 2 and 200`),
  ],
);
