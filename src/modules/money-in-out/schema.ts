import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accounts, journals } from "../ledger/schema";
import { tenants } from "../tenant/schema";

// Money in and money out (batch A, 2026-11-27): money that comes into or goes out of one of the
// company's cash or bank accounts and is none of the documents that already have a form of their
// own (a customer's receipt, a supplier payment, an expense, a salary, a transfer): the owner's
// capital put in, a loan received or repaid, drawings, other income. Each is one journal between
// the cash or bank account and one other account, written only by the database's own function
// in one act (drizzle/0049_money_in_out.sql); the app's role reads them.

/** Money in (MI-2627-00001) or money out (MO-2627-00001). Cancelled by a reversal, never changed. */
export const moneyInOut = pgTable(
  "money_in_out",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // in or out.
    direction: text().notNull(),
    number: text().notNull(),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    // The cash or bank account the money came into or went out of.
    moneyAccountId: uuid("money_account_id").notNull(),
    // The other side: capital, a loan, drawings, other income. Never a control account.
    otherAccountId: uuid("other_account_id").notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    // From whom (in) or to whom (out), in words.
    party: text().notNull(),
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
    unique("money_in_out_tenant_id_id_key").on(t.tenantId, t.id),
    unique("money_in_out_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "money_in_out_money_account_fk", columns: [t.tenantId, t.moneyAccountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "money_in_out_other_account_fk", columns: [t.tenantId, t.otherAccountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "money_in_out_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    foreignKey({ name: "money_in_out_reversal_fk", columns: [t.tenantId, t.reversalJournalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("money_in_out_tenant_date_idx").on(t.tenantId, t.entryDate),
    check("money_in_out_direction_known", sql`${t.direction} in ('in', 'out')`),
    check("money_in_out_accounts_differ", sql`${t.moneyAccountId} <> ${t.otherAccountId}`),
    check("money_in_out_amount_sane", sql`${t.amount} > 0 and ${t.amount} < 1e14`),
    check("money_in_out_status_known", sql`${t.status} in ('posted', 'cancelled')`),
    check("money_in_out_number_format", sql`${t.number} ~ '^M[IO]-[0-9]{4}-[0-9]{5,}$' and substr(${t.number}, 2, 1) = (case ${t.direction} when 'in' then 'I' else 'O' end)`),
    check(
      "money_in_out_cancelled_is_whole",
      sql`(${t.status} = 'cancelled') = (${t.reversalJournalId} is not null) and (${t.status} = 'cancelled') = (${t.cancelledAt} is not null)
        and (${t.status} = 'cancelled') = (${t.cancelledBy} is not null) and (${t.status} = 'cancelled') = (${t.cancelReason} is not null)`,
    ),
    check("money_in_out_party_length", sql`char_length(btrim(${t.party})) between 2 and 120 and ${t.party} = btrim(${t.party})`),
    check("money_in_out_text_length", sql`char_length(btrim(${t.reference})) between 1 and 60 and char_length(btrim(${t.memo})) between 1 and 300`),
  ],
);
