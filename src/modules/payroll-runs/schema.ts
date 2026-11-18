import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts, journals } from "../ledger/schema";
import { employees } from "../payroll/schema";
import { tenants } from "../tenant/schema";

// Step 41: a month's payroll. A run is worked out by the app as a draft, one payslip for each
// person employed in the month: their pay for the days, the commission approved for them, the
// tax, EOBI and social security, and what they take home. It is reviewed, then approved, which
// puts it in the books and settles the commission it carries (commission was expensed when it was
// earned: approving moves it from Commission payable to Salaries payable, never into an expense
// again), then paid out of a cash or bank account. Before approval it can be worked out again or
// cancelled. Statuses after a draft, numbers and journals are the database's own answers
// (drizzle/0033_payroll_runs.sql).

/** A month's payroll for the company: PR-2627-00001 once approved. */
export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // The first day of the month it pays.
    month: date({ mode: "string" }).notNull(),
    // draft, reviewed, approved, paid or cancelled.
    status: text().notNull().default("draft"),
    number: text(),
    workedOutAt: timestamp("worked_out_at", { withTimezone: true }).notNull().defaultNow(),
    // What the payslips add up to.
    earnings: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    commission: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    tax: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    eobiEmployee: numeric("eobi_employee", { precision: 20, scale: 4 }).notNull().default("0"),
    deductions: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    net: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    employerEobi: numeric("employer_eobi", { precision: 20, scale: 4 }).notNull().default("0"),
    employerSocialSecurity: numeric("employer_social_security", { precision: 20, scale: 4 }).notNull().default("0"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    // The day the run is in the books: the month's last day, or the day it was approved if sooner.
    journalDate: date("journal_date", { mode: "string" }),
    journalId: uuid("journal_id"),
    paidOn: date("paid_on", { mode: "string" }),
    payAccountId: uuid("pay_account_id"),
    paymentJournalId: uuid("payment_journal_id"),
    // The salary payment's own number, SP-2627-00001: none when nobody had anything to take home.
    paymentNumber: text("payment_number"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidBy: uuid("paid_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("payroll_runs_tenant_id_id_key").on(t.tenantId, t.id),
    unique("payroll_runs_number_key").on(t.tenantId, t.number),
    unique("payroll_runs_payment_number_key").on(t.tenantId, t.paymentNumber),
    // One run a month that stands.
    uniqueIndex("payroll_runs_month_key").on(t.tenantId, t.month).where(sql`${t.status} <> 'cancelled'`),
    foreignKey({ name: "payroll_runs_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    foreignKey({ name: "payroll_runs_payment_journal_fk", columns: [t.tenantId, t.paymentJournalId], foreignColumns: [journals.tenantId, journals.id] }),
    foreignKey({ name: "payroll_runs_pay_account_fk", columns: [t.tenantId, t.payAccountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    check("payroll_runs_month_first", sql`extract(day from ${t.month}) = 1`),
    check("payroll_runs_status_known", sql`${t.status} in ('draft', 'reviewed', 'approved', 'paid', 'cancelled')`),
    check("payroll_runs_number_format", sql`${t.number} ~ '^PR-[0-9]{4}-[0-9]{5,}$' and ${t.paymentNumber} ~ '^SP-[0-9]{4}-[0-9]{5,}$'`),
    check(
      "payroll_runs_figures_add_up",
      sql`${t.earnings} >= 0 and ${t.commission} >= 0 and ${t.tax} >= 0 and ${t.eobiEmployee} >= 0 and ${t.deductions} >= 0 and ${t.net} >= 0
        and ${t.employerEobi} >= 0 and ${t.employerSocialSecurity} >= 0 and ${t.net} = ${t.earnings} + ${t.commission} - ${t.tax} - ${t.eobiEmployee} - ${t.deductions}`,
    ),
    check("payroll_runs_approved_is_whole", sql`(${t.status} in ('approved', 'paid')) = (${t.journalId} is not null) and (${t.journalId} is null) = (${t.number} is null) and (${t.journalId} is null) = (${t.approvedAt} is null)`),
    check("payroll_runs_paid_is_whole", sql`(${t.status} = 'paid') = (${t.paidOn} is not null) and (${t.status} = 'paid') = (${t.paidBy} is not null) and (${t.paymentJournalId} is null or ${t.status} = 'paid') and (${t.paymentJournalId} is null) = (${t.paymentNumber} is null)`),
    check("payroll_runs_cancelled_is_whole", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.status} = 'cancelled') = (${t.cancelReason} is not null)`),
  ],
);

/** One person's pay for the run's month, with what it is worked out from. */
export const payslips = pgTable(
  "payslips",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    runId: uuid("run_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    // The login whose commission the payslip carries, as it stood when worked out.
    userId: uuid("user_id"),
    payBasis: text("pay_basis").notNull(),
    daysInMonth: integer("days_in_month").notNull(),
    daysEmployed: integer("days_employed").notNull(),
    daysWorked: numeric("days_worked", { precision: 4, scale: 1 }).notNull(),
    unpaidDays: numeric("unpaid_days", { precision: 4, scale: 1 }).notNull(),
    earnings: numeric({ precision: 20, scale: 4 }).notNull(),
    // Commission approved for payment, less what the person owed back from earlier commission.
    commission: numeric({ precision: 20, scale: 4 }).notNull(),
    commissionRecovered: numeric("commission_recovered", { precision: 20, scale: 4 }).notNull(),
    taxable: numeric({ precision: 20, scale: 4 }).notNull(),
    tax: numeric({ precision: 20, scale: 4 }).notNull(),
    eobiEmployee: numeric("eobi_employee", { precision: 20, scale: 4 }).notNull(),
    deductions: numeric({ precision: 20, scale: 4 }).notNull(),
    net: numeric({ precision: 20, scale: 4 }).notNull(),
    employerEobi: numeric("employer_eobi", { precision: 20, scale: 4 }).notNull(),
    employerSocialSecurity: numeric("employer_social_security", { precision: 20, scale: 4 }).notNull(),
    // The year's tax worked out on what the person is expected to earn in the tax year (s.149):
    // what their approved payslips earlier in the tax year came to, and for the months before
    // that in which they were employed and nothing was run here, their regular pay and the tax
    // on it, assumed.
    taxableBefore: numeric("taxable_before", { precision: 20, scale: 4 }).notNull(),
    taxBefore: numeric("tax_before", { precision: 20, scale: 4 }).notNull(),
    // How many months of the tax year before this one had an approved payslip: what taxable_before and tax_before add up.
    monthsBefore: integer("months_before").notNull().default(0),
    assumedMonths: integer("assumed_months").notNull().default(0),
    assumedTaxable: numeric("assumed_taxable", { precision: 20, scale: 4 }).notNull().default("0"),
    assumedTax: numeric("assumed_tax", { precision: 20, scale: 4 }).notNull().default("0"),
    monthsLeft: integer("months_left").notNull(),
    annualTaxable: numeric("annual_taxable", { precision: 20, scale: 4 }).notNull(),
    annualTax: numeric("annual_tax", { precision: 20, scale: 4 }).notNull(),
    // The commission it was worked out with: the approved commission and what is owed back, in all,
    // and a fingerprint of the accrual-by-accrual figures (app.commission_summary); {} with no login.
    commissionBasis: jsonb("commission_basis").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("payslips_tenant_id_id_key").on(t.tenantId, t.id),
    unique("payslips_employee_key").on(t.tenantId, t.runId, t.employeeId),
    foreignKey({ name: "payslips_run_fk", columns: [t.tenantId, t.runId], foreignColumns: [payrollRuns.tenantId, payrollRuns.id] }),
    foreignKey({ name: "payslips_employee_fk", columns: [t.tenantId, t.employeeId], foreignColumns: [employees.tenantId, employees.id] }),
    index("payslips_tenant_employee_idx").on(t.tenantId, t.employeeId),
    check("payslips_pay_basis_known", sql`${t.payBasis} in ('monthly', 'daily')`),
    // Commission is carried only for someone who signs in: it is that login's.
    check("payslips_commission_needs_login", sql`${t.userId} is not null or (${t.commission} = 0 and ${t.commissionRecovered} = 0 and ${t.commissionBasis} = '{}'::jsonb)`),
    check(
      "payslips_figures_add_up",
      sql`${t.earnings} >= 0 and ${t.commission} >= 0 and ${t.commissionRecovered} >= 0 and ${t.tax} >= 0 and ${t.eobiEmployee} >= 0 and ${t.deductions} >= 0
        and ${t.net} >= 0 and ${t.employerEobi} >= 0 and ${t.employerSocialSecurity} >= 0
        and ${t.net} = ${t.earnings} + ${t.commission} - ${t.tax} - ${t.eobiEmployee} - ${t.deductions}`,
    ),
    check(
      "payslips_days_sane",
      sql`${t.daysInMonth} between 28 and 31 and ${t.daysEmployed} between 1 and ${t.daysInMonth} and ${t.monthsLeft} between 1 and 12
        and ${t.assumedMonths} between 0 and 11 and ${t.monthsBefore} between 0 and 11 and ${t.assumedMonths} + ${t.monthsBefore} + ${t.monthsLeft} <= 12 and ${t.assumedTaxable} >= 0 and ${t.assumedTax} >= 0`,
    ),
  ],
);

/** The lines a payslip shows: each part of the pay, each deduction, and what the employer pays on top. */
export const payslipLines = pgTable(
  "payslip_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    payslipId: uuid("payslip_id").notNull(),
    lineNo: integer("line_no").notNull(),
    // earning, deduction or employer.
    kind: text().notNull(),
    code: text().notNull(),
    label: text().notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
  },
  (t) => [
    unique("payslip_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("payslip_lines_line_key").on(t.tenantId, t.payslipId, t.lineNo),
    foreignKey({ name: "payslip_lines_payslip_fk", columns: [t.tenantId, t.payslipId], foreignColumns: [payslips.tenantId, payslips.id] }),
    check("payslip_lines_kind_known", sql`${t.kind} in ('earning', 'deduction', 'employer')`),
    check("payslip_lines_amount_sane", sql`${t.amount} >= 0 and ${t.amount} < 1e16 and ${t.lineNo} between 1 and 40`),
  ],
);
