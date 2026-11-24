import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts } from "../ledger/schema";
import { tenants } from "../tenant/schema";

// Step 35: a bank's statements, imported from the file the bank gives, and the matching of what
// the bank says against what the books say. A match ties statement lines to journal lines on the
// same account whose amounts add up to the same: one to one, or several to one (a deposit of
// many cheques). Everything here is written by the database's own functions
// (drizzle/0041_bank_reconciliation.sql); the app's role reads it.

/** One file imported for one bank account. */
export const bankStatements = pgTable(
  "bank_statements",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    accountId: uuid("account_id").notNull(),
    fileName: text("file_name").notNull(),
    // hbl, meezan, ubl, auto or columns: how the file was read.
    layout: text().notNull(),
    // Lines in the file, and how many of them were new (a line imported before is not imported again).
    lineCount: integer("line_count").notNull(),
    addedCount: integer("added_count").notNull(),
    periodFrom: date("period_from", { mode: "string" }).notNull(),
    periodTo: date("period_to", { mode: "string" }).notNull(),
    // What the file says the account held before its first line and after its last, when it says.
    openingBalance: numeric("opening_balance", { precision: 20, scale: 4 }),
    closingBalance: numeric("closing_balance", { precision: 20, scale: 4 }),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    importedBy: uuid("imported_by").notNull(),
  },
  (t) => [
    unique("bank_statements_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "bank_statements_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    index("bank_statements_account_idx").on(t.tenantId, t.accountId, t.periodTo),
    check("bank_statements_layout_known", sql`${t.layout} in ('hbl', 'meezan', 'ubl', 'auto', 'columns')`),
    check("bank_statements_file_name_length", sql`char_length(btrim(${t.fileName})) between 1 and 200`),
    check("bank_statements_counts_sane", sql`${t.lineCount} between 1 and 5000 and ${t.addedCount} between 0 and ${t.lineCount} and ${t.periodFrom} <= ${t.periodTo}`),
  ],
);

/** Statement lines and journal lines found to be the same money. */
export const bankMatches = pgTable(
  "bank_matches",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    accountId: uuid("account_id").notNull(),
    // reference, amount_date or by_hand: how it was found.
    rule: text().notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
    matchedBy: uuid("matched_by").notNull(),
  },
  (t) => [
    unique("bank_matches_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "bank_matches_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    check("bank_matches_rule_known", sql`${t.rule} in ('reference', 'amount_date', 'by_hand')`),
  ],
);

/** A line of a statement: money in (positive) or out (negative) of the account, as the bank says. */
export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    statementId: uuid("statement_id").notNull(),
    accountId: uuid("account_id").notNull(),
    lineNo: integer("line_no").notNull(),
    lineDate: date("line_date", { mode: "string" }).notNull(),
    description: text().notNull(),
    // The cheque or instrument number, or the bank's reference, when the file gives one.
    reference: text(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    balance: numeric({ precision: 20, scale: 4 }),
    // What makes the line the same line when another file holds it too.
    fingerprint: text().notNull(),
    matchId: uuid("match_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("bank_statement_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("bank_statement_lines_fingerprint_key").on(t.tenantId, t.accountId, t.fingerprint),
    foreignKey({ name: "bank_statement_lines_statement_fk", columns: [t.tenantId, t.statementId], foreignColumns: [bankStatements.tenantId, bankStatements.id] }),
    foreignKey({ name: "bank_statement_lines_match_fk", columns: [t.tenantId, t.matchId], foreignColumns: [bankMatches.tenantId, bankMatches.id] }),
    index("bank_statement_lines_account_idx").on(t.tenantId, t.accountId, t.lineDate),
    index("bank_statement_lines_match_idx").on(t.tenantId, t.matchId),
    check("bank_statement_lines_amount_sane", sql`${t.amount} <> 0 and abs(${t.amount}) < 1e16 and (${t.balance} is null or abs(${t.balance}) < 1e16)`),
    check("bank_statement_lines_text_length", sql`char_length(${t.description}) <= 500 and (${t.reference} is null or char_length(btrim(${t.reference})) between 1 and 60) and char_length(${t.fingerprint}) between 1 and 200`),
  ],
);

/** The journal lines of a match: each journal line is in one match at most. */
export const bankMatchJournalLines = pgTable(
  "bank_match_journal_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    matchId: uuid("match_id").notNull(),
    journalLineId: uuid("journal_line_id").notNull(),
    accountId: uuid("account_id").notNull(),
  },
  (t) => [
    uniqueIndex("bank_match_journal_lines_line_key").on(t.tenantId, t.journalLineId),
    foreignKey({ name: "bank_match_journal_lines_match_fk", columns: [t.tenantId, t.matchId], foreignColumns: [bankMatches.tenantId, bankMatches.id] }),
    // No foreign key to journal_lines: a posted journal line is never removed, and app.match_bank_lines
    // checks each is this account's; a key would only stand in the ledger's own refusal of a TRUNCATE.
    index("bank_match_journal_lines_match_idx").on(t.tenantId, t.matchId),
  ],
);
