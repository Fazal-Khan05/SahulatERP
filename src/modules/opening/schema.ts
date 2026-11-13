import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts, journals } from "../ledger/schema";
import { customers, suppliers } from "../parties/schema";
import { tenants } from "../tenant/schema";

// The books a company brings with it. One opening entry holds what every account stood at on
// the opening date, each unpaid customer invoice and each unpaid supplier bill. As a draft it is
// built up line by line or from files. Posting it writes one journal: every account at its
// balance, trade receivables customer by customer, trade payables supplier by supplier, and one
// balancing line to opening balance equity. From then on the entry and its lines never change;
// a wrong one is reversed and entered again.
export const openingEntries = pgTable(
  "opening_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // draft, posted or reversed.
    status: text().notNull().default("draft"),
    // The day the journal carries: the first day the books are kept here. Balances are as they
    // stood at the end of the day before.
    openingDate: date("opening_date", { mode: "string" }).notNull(),
    journalId: uuid("journal_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    reversalJournalId: uuid("reversal_journal_id"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("opening_entries_tenant_id_id_key").on(t.tenantId, t.id),
    // A company has one opening entry at a time; a reversed one is history.
    uniqueIndex("opening_entries_one_live_key")
      .on(t.tenantId)
      .where(sql`${t.status} <> 'reversed'`),
    foreignKey({ name: "opening_entries_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    foreignKey({ name: "opening_entries_reversal_fk", columns: [t.tenantId, t.reversalJournalId], foreignColumns: [journals.tenantId, journals.id] }),
    check("opening_entries_status_known", sql`${t.status} in ('draft', 'posted', 'reversed')`),
    check("opening_entries_posted_is_whole", sql`(${t.status} = 'draft') = (${t.journalId} is null) and (${t.status} = 'draft') = (${t.postedAt} is null) and (${t.status} = 'draft') = (${t.postedBy} is null)`),
    check(
      "opening_entries_reversed_is_whole",
      sql`(${t.status} = 'reversed') = (${t.reversalJournalId} is not null) and (${t.status} = 'reversed') = (${t.reversedAt} is not null) and (${t.status} = 'reversed') = (${t.reversedBy} is not null)`,
    ),
  ],
);

// One line of an opening entry. An `account` line is what one account stood at. A `receivable`
// line is one unpaid invoice of one customer, and a `payable` line one unpaid bill of one
// supplier, each with its own number and its original date, so that what is owed ages from when
// it was really invoiced and can later be settled invoice by invoice.
export const openingBalances = pgTable(
  "opening_balances",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    openingEntryId: uuid("opening_entry_id").notNull(),
    // account, receivable or payable.
    kind: text().notNull(),
    accountId: uuid("account_id"),
    customerId: uuid("customer_id"),
    supplierId: uuid("supplier_id"),
    // The invoice's or bill's own number and date, as on the paper. The due date is when it is
    // to be paid; empty means on the document's date.
    documentNumber: text("document_number"),
    documentDate: date("document_date", { mode: "string" }),
    dueDate: date("due_date", { mode: "string" }),
    // An account line carries a debit or a credit. A receivable is a debit, a payable a credit.
    debit: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    credit: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("opening_balances_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "opening_balances_entry_fk", columns: [t.tenantId, t.openingEntryId], foreignColumns: [openingEntries.tenantId, openingEntries.id] }),
    foreignKey({ name: "opening_balances_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "opening_balances_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ name: "opening_balances_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    // One line per account; one line per invoice of a customer and per bill of a supplier.
    uniqueIndex("opening_balances_account_key")
      .on(t.tenantId, t.openingEntryId, t.accountId)
      .where(sql`${t.kind} = 'account'`),
    uniqueIndex("opening_balances_receivable_key")
      .on(t.tenantId, t.openingEntryId, t.customerId, sql`lower(${t.documentNumber})`)
      .where(sql`${t.kind} = 'receivable'`),
    uniqueIndex("opening_balances_payable_key")
      .on(t.tenantId, t.openingEntryId, t.supplierId, sql`lower(${t.documentNumber})`)
      .where(sql`${t.kind} = 'payable'`),
    index("opening_balances_customer_idx")
      .on(t.tenantId, t.customerId)
      .where(sql`${t.customerId} is not null`),
    index("opening_balances_supplier_idx")
      .on(t.tenantId, t.supplierId)
      .where(sql`${t.supplierId} is not null`),
    check("opening_balances_kind_known", sql`${t.kind} in ('account', 'receivable', 'payable')`),
    check(
      "opening_balances_kind_is_whole",
      sql`(${t.kind} = 'account' and ${t.accountId} is not null and ${t.customerId} is null and ${t.supplierId} is null and ${t.documentNumber} is null and ${t.documentDate} is null and ${t.dueDate} is null)
        or (${t.kind} = 'receivable' and ${t.accountId} is null and ${t.customerId} is not null and ${t.supplierId} is null and ${t.documentNumber} is not null and ${t.documentDate} is not null and ${t.credit} = 0)
        or (${t.kind} = 'payable' and ${t.accountId} is null and ${t.customerId} is null and ${t.supplierId} is not null and ${t.documentNumber} is not null and ${t.documentDate} is not null and ${t.debit} = 0)`,
    ),
    check("opening_balances_one_side", sql`${t.debit} >= 0 and ${t.credit} >= 0 and ${t.debit} < 1e16 and ${t.credit} < 1e16 and (${t.debit} = 0) <> (${t.credit} = 0)`),
    check("opening_balances_document_number_length", sql`char_length(btrim(${t.documentNumber})) between 1 and 40`),
    check("opening_balances_due_after_document", sql`${t.dueDate} is null or ${t.dueDate} >= ${t.documentDate}`),
  ],
);
