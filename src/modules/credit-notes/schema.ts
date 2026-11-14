import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, numeric, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { journals } from "../ledger/schema";
import { openingBalances } from "../opening/schema";
import { salesDocuments, salesLines } from "../sales/schema";
import { tenants } from "../tenant/schema";

// A credit note is a sales document of its own kind (src/modules/sales/schema.ts): it is made
// from a posted invoice, each of its lines takes back part of one line of that invoice, and it
// is posted once by the database's own function.
//
// What a posted credit note has been set against. Posting it takes what is still unpaid of its
// own invoice first: that is one row here, in the credit note's own journal. Anything beyond
// that is the customer's credit, kept with advances from customers; each part of it set against
// another invoice later is one more row, with a journal of its own that moves the amount from
// advances to the customer's account.
//
// Rows are written only by the database's functions and never change: a credit note is never
// cancelled. What is still unpaid on an invoice is its total, less what receipts have paid of
// it, less these rows.
export const creditNoteAllocations = pgTable(
  "credit_note_allocations",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    creditNoteId: uuid("credit_note_id").notNull(),
    // One of the two: a posted sales invoice, or an opening balance line for a customer.
    invoiceId: uuid("invoice_id"),
    openingBalanceId: uuid("opening_balance_id"),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    // The day it counts from: the credit note's date, or the day the credit was set against the invoice.
    allocatedOn: date("allocated_on", { mode: "string" }).notNull(),
    // The journal that took the amount off the customer's account: the credit note's own, or
    // the one that set the credit against another invoice later.
    journalId: uuid("journal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("credit_note_allocations_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "credit_note_allocations_credit_note_fk", columns: [t.tenantId, t.creditNoteId], foreignColumns: [salesDocuments.tenantId, salesDocuments.id] }),
    foreignKey({ name: "credit_note_allocations_invoice_fk", columns: [t.tenantId, t.invoiceId], foreignColumns: [salesDocuments.tenantId, salesDocuments.id] }),
    foreignKey({ name: "credit_note_allocations_opening_fk", columns: [t.tenantId, t.openingBalanceId], foreignColumns: [openingBalances.tenantId, openingBalances.id] }),
    foreignKey({ name: "credit_note_allocations_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("credit_note_allocations_credit_note_idx").on(t.tenantId, t.creditNoteId),
    // What has been settled on an invoice is asked for often.
    index("credit_note_allocations_invoice_idx")
      .on(t.tenantId, t.invoiceId)
      .where(sql`${t.invoiceId} is not null`),
    index("credit_note_allocations_opening_idx")
      .on(t.tenantId, t.openingBalanceId)
      .where(sql`${t.openingBalanceId} is not null`),
    check("credit_note_allocations_one_target", sql`(${t.invoiceId} is null) <> (${t.openingBalanceId} is null)`),
    check("credit_note_allocations_not_itself", sql`${t.invoiceId} is distinct from ${t.creditNoteId}`),
    check("credit_note_allocations_amount_sane", sql`${t.amount} > 0 and ${t.amount} < 1e16`),
  ],
);

// What the goods on each line of a posted credit note cost when they left stock, and how much
// of that was written off as damaged. Written by the database when the credit note is posted,
// one row for each of its lines, and never changed. Kept apart from the line itself because
// the sales team reads the lines of its documents and is not shown what goods cost: these rows
// are read by the owner, an accountant and the auditor.
export const creditNoteLineCosts = pgTable(
  "credit_note_line_costs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    creditNoteId: uuid("credit_note_id").notNull(),
    // The line of the credit note, and the line of the invoice it takes back.
    lineId: uuid("line_id").notNull(),
    invoiceLineId: uuid("invoice_line_id").notNull(),
    // What the goods that came back had cost, and the part of it that was written off.
    cost: numeric({ precision: 20, scale: 4 }).notNull(),
    writtenOff: numeric("written_off", { precision: 20, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("credit_note_line_costs_tenant_id_id_key").on(t.tenantId, t.id),
    unique("credit_note_line_costs_line_key").on(t.tenantId, t.lineId),
    foreignKey({ name: "credit_note_line_costs_line_fk", columns: [t.tenantId, t.creditNoteId, t.lineId], foreignColumns: [salesLines.tenantId, salesLines.documentId, salesLines.id] }),
    foreignKey({ name: "credit_note_line_costs_invoice_line_fk", columns: [t.tenantId, t.invoiceLineId], foreignColumns: [salesLines.tenantId, salesLines.id] }),
    index("credit_note_line_costs_invoice_line_idx").on(t.tenantId, t.invoiceLineId),
    check("credit_note_line_costs_sane", sql`${t.cost} >= 0 and ${t.cost} < 1e16 and ${t.writtenOff} >= 0 and ${t.writtenOff} <= ${t.cost}`),
  ],
);
