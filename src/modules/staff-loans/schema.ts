import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accounts, journals } from "../ledger/schema";
import { employees } from "../payroll/schema";
import { payrollRuns } from "../payroll-runs/schema";
import { tenants } from "../tenant/schema";

// Step 42: what the company lends its people and how it comes back, and the bank account each is
// paid into. A loan is paid out of a cash or bank account (SL-2627-00001), comes back by an
// instalment taken from each month's pay, and the rest in cash when they choose or when they
// leave. Everything but the bank details is written by the database's own functions
// (drizzle/0042_payroll_extras.sql).

/** The bank account a person's salary is paid into. */
export const employeeBankAccounts = pgTable(
  "employee_bank_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id").notNull(),
    bankName: text("bank_name").notNull(),
    accountTitle: text("account_title").notNull(),
    // A Pakistani IBAN: PK, two check digits, the bank's four letters, sixteen digits.
    iban: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("employee_bank_accounts_tenant_id_id_key").on(t.tenantId, t.id),
    unique("employee_bank_accounts_employee_key").on(t.tenantId, t.employeeId),
    foreignKey({ name: "employee_bank_accounts_employee_fk", columns: [t.tenantId, t.employeeId], foreignColumns: [employees.tenantId, employees.id] }),
    check("employee_bank_accounts_iban_format", sql`${t.iban} ~ '^PK[0-9]{2}[A-Z]{4}[0-9]{16}$'`),
    check("employee_bank_accounts_names_length", sql`char_length(btrim(${t.bankName})) between 2 and 80 and char_length(btrim(${t.accountTitle})) between 2 and 80`),
  ],
);

/** Money lent to someone on the payroll: SL-2627-00001. */
export const staffLoans = pgTable(
  "staff_loans",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    number: text().notNull(),
    employeeId: uuid("employee_id").notNull(),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    // What comes off each month's pay until it is back.
    instalment: numeric({ precision: 20, scale: 4 }).notNull(),
    accountId: uuid("account_id").notNull(),
    journalId: uuid("journal_id").notNull(),
    // What has come back: by instalments in approved payroll runs, and repaid in cash.
    recovered: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    note: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("staff_loans_tenant_id_id_key").on(t.tenantId, t.id),
    unique("staff_loans_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "staff_loans_employee_fk", columns: [t.tenantId, t.employeeId], foreignColumns: [employees.tenantId, employees.id] }),
    foreignKey({ name: "staff_loans_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "staff_loans_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("staff_loans_employee_idx").on(t.tenantId, t.employeeId),
    check("staff_loans_figures_sane", sql`${t.amount} > 0 and ${t.amount} < 1e12 and ${t.instalment} > 0 and ${t.instalment} <= ${t.amount} and ${t.recovered} >= 0 and ${t.recovered} <= ${t.amount}`),
    check("staff_loans_number_format", sql`${t.number} ~ '^SL-[0-9]{4}-[0-9]{5,}$'`),
    check("staff_loans_note_length", sql`char_length(btrim(${t.note})) between 1 and 300`),
  ],
);

/** Money that came back on a loan: an instalment from an approved run's pay, or repaid in cash (LR-2627-00001). */
export const staffLoanMovements = pgTable(
  "staff_loan_movements",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    loanId: uuid("loan_id").notNull(),
    // from_pay or repaid.
    kind: text().notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    movementDate: date("movement_date", { mode: "string" }).notNull(),
    runId: uuid("run_id"),
    number: text(),
    accountId: uuid("account_id"),
    journalId: uuid("journal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("staff_loan_movements_tenant_id_id_key").on(t.tenantId, t.id),
    unique("staff_loan_movements_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "staff_loan_movements_loan_fk", columns: [t.tenantId, t.loanId], foreignColumns: [staffLoans.tenantId, staffLoans.id] }),
    foreignKey({ name: "staff_loan_movements_run_fk", columns: [t.tenantId, t.runId], foreignColumns: [payrollRuns.tenantId, payrollRuns.id] }),
    foreignKey({ name: "staff_loan_movements_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("staff_loan_movements_loan_idx").on(t.tenantId, t.loanId),
    check("staff_loan_movements_kind_known", sql`${t.kind} in ('from_pay', 'repaid')`),
    check("staff_loan_movements_amount_sane", sql`${t.amount} > 0`),
    check(
      "staff_loan_movements_source_whole",
      sql`(${t.kind} = 'from_pay') = (${t.runId} is not null) and (${t.kind} = 'repaid') = (${t.journalId} is not null) and (${t.journalId} is null) = (${t.number} is null) and (${t.journalId} is null) = (${t.accountId} is null)`,
    ),
  ],
);
