import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { customers, suppliers } from "../parties/schema";
import { branches, tenants } from "../tenant/schema";

// The chart of accounts: a tree. A heading (is_group) holds other accounts and is never posted
// to; an account that is not a heading is what journal lines name. The accounts the product
// itself relies on are locked (is_control): the five roots, the headings of the starting chart,
// and the accounts a posting must be able to find by what they are for (control_type), such as
// trade receivables. Everything else belongs to the company: added, renamed, archived, and
// deleted while nothing uses it.
export const accounts = pgTable(
  "accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // Null only for the five roots.
    parentId: uuid("parent_id"),
    code: text().notNull(),
    name: text().notNull(),
    // asset, liability, equity, income or expense; always the same as the parent's.
    type: text().notNull(),
    isGroup: boolean("is_group").notNull(),
    // Locked: written only by the starting chart, never changed or removed by the app.
    isControl: boolean("is_control").notNull().default(false),
    // What a posting looks the account up by. On a locked account it is unique in the company.
    // The company's own bank and cash accounts carry their heading's ('bank', 'cash').
    controlType: text("control_type"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: uuid("archived_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("accounts_tenant_id_id_key").on(t.tenantId, t.id),
    // The target of the parent key below, so a child can only sit under a parent of its own type.
    unique("accounts_tenant_id_id_type_key").on(t.tenantId, t.id, t.type),
    foreignKey({ name: "accounts_parent_fk", columns: [t.tenantId, t.parentId, t.type], foreignColumns: [t.tenantId, t.id, t.type] }),
    unique("accounts_tenant_code_key").on(t.tenantId, t.code),
    uniqueIndex("accounts_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    uniqueIndex("accounts_tenant_control_key")
      .on(t.tenantId, t.controlType)
      .where(sql`${t.isControl}`),
    check("accounts_type_known", sql`${t.type} in ('asset', 'liability', 'equity', 'income', 'expense')`),
    check("accounts_code_format", sql`${t.code} ~ '^[0-9A-Z][0-9A-Z.-]{0,11}$'`),
    check("accounts_name_length", sql`char_length(btrim(${t.name})) between 2 and 80`),
    check("accounts_control_type_format", sql`${t.controlType} ~ '^[a-z_]{2,40}$'`),
    check("accounts_root_is_locked_heading", sql`${t.parentId} is not null or (${t.isControl} and ${t.isGroup})`),
    check("accounts_not_own_parent", sql`${t.parentId} is distinct from ${t.id}`),
    check("accounts_archived_pair", sql`(${t.archivedAt} is null) = (${t.archivedBy} is null)`),
    check("accounts_locked_never_archived", sql`not ${t.isControl} or ${t.archivedAt} is null`),
  ],
);

// A journal: one balanced set of lines for one source document, on one date. Written only by
// the database function app.post_journal (and app.reverse_journal), whole or not at all, and
// never changed or removed afterwards: a wrong journal is corrected by a reversal, which is a
// new journal that names the one it reverses. The app can only read these two tables.
export const journals = pgTable(
  "journals",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    journalDate: date("journal_date", { mode: "string" }).notNull(),
    // The document that caused the journal: its kind and its id. One document, one journal.
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    // Set on a reversal: the journal it undoes. Its source is then ('reversal', that journal).
    reversesJournalId: uuid("reverses_journal_id"),
    // The source document's own number, such as JV-2627-00001, for reading the ledger. Null on a
    // reversal and on a document that has no number.
    documentNumber: text("document_number"),
    memo: text(),
    // Null for a journal that belongs to the whole company.
    branchId: uuid("branch_id"),
    // The transaction that wrote the journal; lines can join it only in that transaction.
    postedTxid: bigint("posted_txid", { mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("journals_tenant_id_id_key").on(t.tenantId, t.id),
    unique("journals_source_key").on(t.tenantId, t.sourceType, t.sourceId),
    unique("journals_reverses_key").on(t.tenantId, t.reversesJournalId),
    foreignKey({ name: "journals_reverses_fk", columns: [t.tenantId, t.reversesJournalId], foreignColumns: [t.tenantId, t.id] }),
    foreignKey({ name: "journals_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    index("journals_tenant_date_idx").on(t.tenantId, t.journalDate),
    // A document number names one journal. A reversal carries none: it is found by the journal it reverses.
    uniqueIndex("journals_document_number_key")
      .on(t.tenantId, t.documentNumber)
      .where(sql`${t.documentNumber} is not null`),
    check("journals_source_type_format", sql`${t.sourceType} ~ '^[a-z_]{2,40}$'`),
    check("journals_reversal_is_whole", sql`(${t.reversesJournalId} is null and ${t.sourceType} <> 'reversal') or (${t.reversesJournalId} is not null and ${t.sourceType} = 'reversal' and ${t.sourceId} = ${t.reversesJournalId})`),
    check("journals_not_own_reversal", sql`${t.reversesJournalId} is distinct from ${t.id}`),
    check("journals_document_number_length", sql`char_length(${t.documentNumber}) between 1 and 40`),
    check("journals_memo_length", sql`char_length(${t.memo}) between 1 and 500`),
  ],
);

// One debit or one credit to one account. Amounts are in the company's base currency. A line
// has no stamps of its own: it is written with its journal, in the same transaction, by the
// same person.
export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    journalId: uuid("journal_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id").notNull(),
    debit: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    credit: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    description: text(),
    // Whose balance the line belongs to. Required on the accounts kept customer by customer
    // (receivables, advances from customers) and supplier by supplier (payables, advances to suppliers).
    customerId: uuid("customer_id"),
    supplierId: uuid("supplier_id"),
    // For cost centres, which do not exist yet; kept from day one so no line ever lacks the column.
    costCentreId: uuid("cost_centre_id"),
    // The journal's branch, copied by the database so reports can filter lines directly.
    branchId: uuid("branch_id"),
  },
  (t) => [
    unique("journal_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("journal_lines_journal_line_key").on(t.tenantId, t.journalId, t.lineNo),
    foreignKey({ name: "journal_lines_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    foreignKey({ name: "journal_lines_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "journal_lines_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ name: "journal_lines_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ name: "journal_lines_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    index("journal_lines_tenant_account_idx").on(t.tenantId, t.accountId),
    index("journal_lines_tenant_customer_idx")
      .on(t.tenantId, t.customerId)
      .where(sql`${t.customerId} is not null`),
    index("journal_lines_tenant_supplier_idx")
      .on(t.tenantId, t.supplierId)
      .where(sql`${t.supplierId} is not null`),
    check("journal_lines_line_no_positive", sql`${t.lineNo} >= 1`),
    // "Not a number" is a value numeric can hold, and it passes ">= 0": the upper bound refuses it.
    check("journal_lines_one_side", sql`${t.debit} >= 0 and ${t.credit} >= 0 and ${t.debit} < 1e16 and ${t.credit} < 1e16 and (${t.debit} = 0) <> (${t.credit} = 0)`),
    // Until cost centres exist nothing may be stored here: a line can never be corrected afterwards.
    check("journal_lines_no_cost_centre_yet", sql`${t.costCentreId} is null`),
    check("journal_lines_one_party", sql`${t.customerId} is null or ${t.supplierId} is null`),
    check("journal_lines_description_length", sql`char_length(${t.description}) between 1 and 300`),
  ],
);
