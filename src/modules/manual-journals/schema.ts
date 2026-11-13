import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accounts, journals } from "../ledger/schema";
import { branches, tenants } from "../tenant/schema";

// A manual journal: the accountant's own entry in the books. It is a document like any other.
// As a draft it can be changed and thrown away, and need not balance yet. Posting it takes its
// number (JV-2627-00001) and posts one journal through the posting engine; from then on the
// document and its lines never change. A posted one is undone by reversing it, which posts a
// second journal with every debit and credit swapped.
export const manualJournals = pgTable(
  "manual_journals",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // draft, posted or reversed.
    status: text().notNull().default("draft"),
    journalDate: date("journal_date", { mode: "string" }).notNull(),
    // Why the entry is made; shown wherever the journal is read.
    memo: text().notNull(),
    // Null for an entry that belongs to the whole company.
    branchId: uuid("branch_id"),
    // Taken from the number series when the journal is posted; a draft has none.
    number: text(),
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
    unique("manual_journals_tenant_id_id_key").on(t.tenantId, t.id),
    unique("manual_journals_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "manual_journals_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "manual_journals_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    foreignKey({ name: "manual_journals_reversal_fk", columns: [t.tenantId, t.reversalJournalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("manual_journals_tenant_date_idx").on(t.tenantId, t.journalDate),
    check("manual_journals_status_known", sql`${t.status} in ('draft', 'posted', 'reversed')`),
    check("manual_journals_memo_length", sql`char_length(btrim(${t.memo})) between 1 and 500`),
    check("manual_journals_number_format", sql`${t.number} ~ '^JV-[0-9]{4}-[0-9]{5,}$'`),
    // A draft has no number and no journal; a posted one has both; a reversed one also has its reversal.
    check(
      "manual_journals_posted_is_whole",
      sql`(${t.status} = 'draft') = (${t.number} is null) and (${t.status} = 'draft') = (${t.journalId} is null) and (${t.status} = 'draft') = (${t.postedAt} is null) and (${t.status} = 'draft') = (${t.postedBy} is null)`,
    ),
    check(
      "manual_journals_reversed_is_whole",
      sql`(${t.status} = 'reversed') = (${t.reversalJournalId} is not null) and (${t.status} = 'reversed') = (${t.reversedAt} is not null) and (${t.status} = 'reversed') = (${t.reversedBy} is not null)`,
    ),
  ],
);

// One line of a manual journal: a debit or a credit to one account.
export const manualJournalLines = pgTable(
  "manual_journal_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    manualJournalId: uuid("manual_journal_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id").notNull(),
    description: text(),
    debit: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    credit: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("manual_journal_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("manual_journal_lines_line_key").on(t.tenantId, t.manualJournalId, t.lineNo),
    foreignKey({ name: "manual_journal_lines_journal_fk", columns: [t.tenantId, t.manualJournalId], foreignColumns: [manualJournals.tenantId, manualJournals.id] }),
    foreignKey({ name: "manual_journal_lines_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    check("manual_journal_lines_line_no_positive", sql`${t.lineNo} >= 1`),
    check("manual_journal_lines_one_side", sql`${t.debit} >= 0 and ${t.credit} >= 0 and ${t.debit} < 1e16 and ${t.credit} < 1e16 and (${t.debit} = 0) <> (${t.credit} = 0)`),
    check("manual_journal_lines_description_length", sql`char_length(${t.description}) between 1 and 300`),
  ],
);
