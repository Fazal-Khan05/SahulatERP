import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accounts, journals } from "../ledger/schema";
import { suppliers } from "../parties/schema";
import { branches, tenants } from "../tenant/schema";

// Step 34: the company's cash and bank accounts, money moved between them, and what it spends
// out of them. A cash or bank account is an account of the chart under Cash accounts (1110) or
// Bank accounts (1120); petty cash is one more cash account. Transfers and expenses are written
// only by the database's own functions, each with its journal, in one act
// (drizzle/0038_cash_bank.sql); the app's role reads them.

/** What the chart does not say about a bank account: the bank, and the account's number or IBAN. */
export const cashBankAccounts = pgTable(
  "cash_bank_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    accountId: uuid("account_id").notNull(),
    bankName: text("bank_name"),
    accountNumber: text("account_number"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("cash_bank_accounts_tenant_id_id_key").on(t.tenantId, t.id),
    unique("cash_bank_accounts_account_key").on(t.tenantId, t.accountId),
    foreignKey({ name: "cash_bank_accounts_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    check("cash_bank_accounts_bank_name_length", sql`char_length(btrim(${t.bankName})) between 2 and 80`),
    check("cash_bank_accounts_number_format", sql`${t.accountNumber} ~ '^[A-Za-z0-9][A-Za-z0-9 -]{3,33}$'`),
  ],
);

/** Money moved from one cash or bank account to another: TR-2627-00001. Cancelled by a reversal, never changed. */
export const cashTransfers = pgTable(
  "cash_transfers",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    number: text().notNull(),
    transferDate: date("transfer_date", { mode: "string" }).notNull(),
    fromAccountId: uuid("from_account_id").notNull(),
    toAccountId: uuid("to_account_id").notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    reference: text(),
    memo: text(),
    // posted or cancelled.
    status: text().notNull(),
    journalId: uuid("journal_id").notNull(),
    reversalJournalId: uuid("reversal_journal_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("cash_transfers_tenant_id_id_key").on(t.tenantId, t.id),
    unique("cash_transfers_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "cash_transfers_from_fk", columns: [t.tenantId, t.fromAccountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "cash_transfers_to_fk", columns: [t.tenantId, t.toAccountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "cash_transfers_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    foreignKey({ name: "cash_transfers_reversal_fk", columns: [t.tenantId, t.reversalJournalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("cash_transfers_tenant_date_idx").on(t.tenantId, t.transferDate),
    check("cash_transfers_accounts_differ", sql`${t.fromAccountId} <> ${t.toAccountId}`),
    check("cash_transfers_amount_sane", sql`${t.amount} > 0 and ${t.amount} < 1e16`),
    check("cash_transfers_status_known", sql`${t.status} in ('posted', 'cancelled')`),
    check("cash_transfers_number_format", sql`${t.number} ~ '^TR-[0-9]{4}-[0-9]{5,}$'`),
    check(
      "cash_transfers_cancelled_is_whole",
      sql`(${t.status} = 'cancelled') = (${t.reversalJournalId} is not null) and (${t.status} = 'cancelled') = (${t.cancelledAt} is not null)
        and (${t.status} = 'cancelled') = (${t.cancelledBy} is not null) and (${t.status} = 'cancelled') = (${t.cancelReason} is not null)`,
    ),
    check("cash_transfers_text_length", sql`char_length(btrim(${t.reference})) between 1 and 60 and char_length(btrim(${t.memo})) between 1 and 300`),
  ],
);

/**
 * Money spent out of a cash or bank account on one or more expense lines: EX-2627-00001. Paid to a
 * supplier on the list (needed when tax is withheld) or to a payee named in words. The province's
 * tax on services is added to the lines and withheld whole; income tax is withheld at the
 * supplier's rate; what is left is what left the account. Cancelled by a reversal, never changed.
 */
export const expenses = pgTable(
  "expenses",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    number: text().notNull(),
    expenseDate: date("expense_date", { mode: "string" }).notNull(),
    // The cash or bank account the money left.
    accountId: uuid("account_id").notNull(),
    supplierId: uuid("supplier_id"),
    payee: text(),
    branchId: uuid("branch_id"),
    reference: text(),
    memo: text(),
    // The lines before the province's tax; the province's tax; the two together.
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    provincialTax: numeric("provincial_tax", { precision: 20, scale: 4 }).notNull(),
    total: numeric({ precision: 20, scale: 4 }).notNull(),
    withheld: numeric({ precision: 20, scale: 4 }).notNull(),
    // What left the account: the total less what was withheld.
    paid: numeric({ precision: 20, scale: 4 }).notNull(),
    // posted or cancelled.
    status: text().notNull(),
    journalId: uuid("journal_id").notNull(),
    reversalJournalId: uuid("reversal_journal_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("expenses_tenant_id_id_key").on(t.tenantId, t.id),
    unique("expenses_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "expenses_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "expenses_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ name: "expenses_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "expenses_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    foreignKey({ name: "expenses_reversal_fk", columns: [t.tenantId, t.reversalJournalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("expenses_tenant_date_idx").on(t.tenantId, t.expenseDate),
    check("expenses_paid_to_someone", sql`(${t.supplierId} is null) <> (${t.payee} is null)`),
    check("expenses_figures_add_up", sql`${t.amount} > 0 and ${t.provincialTax} >= 0 and ${t.total} = ${t.amount} + ${t.provincialTax} and ${t.withheld} >= 0 and ${t.paid} = ${t.total} - ${t.withheld} and ${t.paid} >= 0 and ${t.total} < 1e16`),
    check("expenses_status_known", sql`${t.status} in ('posted', 'cancelled')`),
    check("expenses_number_format", sql`${t.number} ~ '^EX-[0-9]{4}-[0-9]{5,}$'`),
    check(
      "expenses_cancelled_is_whole",
      sql`(${t.status} = 'cancelled') = (${t.reversalJournalId} is not null) and (${t.status} = 'cancelled') = (${t.cancelledAt} is not null)
        and (${t.status} = 'cancelled') = (${t.cancelledBy} is not null) and (${t.status} = 'cancelled') = (${t.cancelReason} is not null)`,
    ),
    check("expenses_text_length", sql`char_length(btrim(${t.payee})) between 2 and 120 and char_length(btrim(${t.reference})) between 1 and 60 and char_length(btrim(${t.memo})) between 1 and 300`),
  ],
);

/** One line of an expense: an expense or asset account, what it was for, the amount, and its share of the province's tax. */
export const expenseLines = pgTable(
  "expense_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    expenseId: uuid("expense_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id").notNull(),
    description: text().notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    provincialShare: numeric("provincial_share", { precision: 20, scale: 4 }).notNull(),
  },
  (t) => [
    unique("expense_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("expense_lines_line_key").on(t.tenantId, t.expenseId, t.lineNo),
    foreignKey({ name: "expense_lines_expense_fk", columns: [t.tenantId, t.expenseId], foreignColumns: [expenses.tenantId, expenses.id] }),
    foreignKey({ name: "expense_lines_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    check("expense_lines_figures_sane", sql`${t.amount} > 0 and ${t.amount} < 1e16 and ${t.provincialShare} >= 0 and ${t.lineNo} between 1 and 50`),
    check("expense_lines_description_length", sql`char_length(btrim(${t.description})) between 2 and 200`),
  ],
);

/**
 * The tax withheld from an expense, one row of each kind, from its line of the withholding
 * tables: what it was worked out on, at what rate, and the law. Step 29's withholding register
 * reads these with Step 25's bill rows; a cancelled expense's rows stay, beside its reversal.
 */
export const expenseWithholdings = pgTable(
  "expense_withholdings",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    expenseId: uuid("expense_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    // income_tax or provincial_sales_tax.
    kind: text().notNull(),
    ruleId: uuid("rule_id").notNull(),
    code: text().notNull(),
    legalReference: text("legal_reference").notNull(),
    onActiveList: boolean("on_active_list").notNull(),
    baseAmount: numeric("base_amount", { precision: 20, scale: 4 }).notNull(),
    rate: numeric({ precision: 7, scale: 4 }).notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    journalId: uuid("journal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("expense_withholdings_tenant_id_id_key").on(t.tenantId, t.id),
    unique("expense_withholdings_kind_key").on(t.tenantId, t.expenseId, t.kind),
    foreignKey({ name: "expense_withholdings_expense_fk", columns: [t.tenantId, t.expenseId], foreignColumns: [expenses.tenantId, expenses.id] }),
    foreignKey({ name: "expense_withholdings_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ name: "expense_withholdings_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    check("expense_withholdings_kind_known", sql`${t.kind} in ('income_tax', 'provincial_sales_tax')`),
    check("expense_withholdings_figures_sane", sql`${t.baseAmount} > 0 and ${t.rate} > 0 and ${t.rate} <= 100 and ${t.amount} > 0`),
  ],
);
