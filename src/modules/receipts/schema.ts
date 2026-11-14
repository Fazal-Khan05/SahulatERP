import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accounts, journals } from "../ledger/schema";
import { openingBalances } from "../opening/schema";
import { customers } from "../parties/schema";
import { salesDocuments } from "../sales/schema";
import { branches, tenants } from "../tenant/schema";

// Money received from a customer: in cash, into a bank account, or as a cheque. A receipt is a
// draft the app writes, and is posted once by the database's own function, which takes its
// number (RC-2627-00001) and posts the journal. The app's role cannot write a receipt's status,
// its number, its journals or where its cheque stands: those columns are closed to it.
//
// A cheque brings the customer's balance down when it is received (the founder's decision,
// 2026-11-14) and sits in Cheques in hand: received, then deposited in a bank account, then
// cleared, when the money reaches the bank. A cheque that bounces, at any of those stages,
// takes the whole receipt back: the invoices it paid are unpaid again.
//
// A posted receipt is never changed. One entered by mistake is cancelled, which reverses its
// journal and frees what it paid.
export const receipts = pgTable(
  "receipts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // draft, posted, bounced or cancelled.
    status: text().notNull().default("draft"),
    receiptDate: date("receipt_date", { mode: "string" }).notNull(),
    customerId: uuid("customer_id").notNull(),
    // cash, bank or cheque.
    method: text().notNull(),
    // The cash or bank account the money went into. For a cheque: the bank account it was
    // deposited in, empty until then.
    accountId: uuid("account_id"),
    // What the customer paid: the face of the cheque, or the amount sent before the bank took
    // its charges.
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    // What the bank kept on the way in. Stated on a bank receipt; on a cheque, when it clears.
    bankCharges: numeric("bank_charges", { precision: 20, scale: 4 }).notNull().default("0"),
    // The slip or transfer reference, and anything to remember.
    reference: text(),
    note: text(),
    // Null for a receipt that belongs to the whole company.
    branchId: uuid("branch_id"),
    chequeNumber: text("cheque_number"),
    // The bank the cheque is drawn on.
    chequeBank: text("cheque_bank"),
    // The date written on the cheque; later than the receipt for a post-dated one.
    chequeDate: date("cheque_date", { mode: "string" }),
    // received, deposited, cleared or bounced; nothing on a draft or on cash and bank receipts.
    chequeStatus: text("cheque_status"),
    depositedOn: date("deposited_on", { mode: "string" }),
    clearedOn: date("cleared_on", { mode: "string" }),
    bouncedOn: date("bounced_on", { mode: "string" }),
    bounceReason: text("bounce_reason"),
    // RC-2627-00001, taken when the receipt is posted.
    number: text(),
    // The journal the receipt posted, and the one that moved a cleared cheque into the bank.
    journalId: uuid("journal_id"),
    clearanceJournalId: uuid("clearance_journal_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("receipts_tenant_id_id_key").on(t.tenantId, t.id),
    unique("receipts_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "receipts_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ name: "receipts_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "receipts_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "receipts_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    foreignKey({ name: "receipts_clearance_journal_fk", columns: [t.tenantId, t.clearanceJournalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("receipts_tenant_date_idx").on(t.tenantId, t.receiptDate),
    index("receipts_tenant_customer_idx").on(t.tenantId, t.customerId),
    // The cheques register: what is in hand or at the bank, by the date on the cheque.
    index("receipts_tenant_cheque_idx")
      .on(t.tenantId, t.chequeStatus, t.chequeDate)
      .where(sql`${t.chequeStatus} is not null`),
    check("receipts_status_known", sql`${t.status} in ('draft', 'posted', 'bounced', 'cancelled')`),
    check("receipts_method_known", sql`${t.method} in ('cash', 'bank', 'cheque')`),
    // "Not a number" passes "> 0"; the upper bound refuses it.
    check("receipts_amount_sane", sql`${t.amount} > 0 and ${t.amount} < 1e16 and ${t.bankCharges} >= 0 and ${t.bankCharges} < ${t.amount}`),
    // Only a bank receipt states what the bank kept from the start; a cheque says so when it clears.
    check("receipts_charges_when_due", sql`${t.method} = 'bank' or ${t.bankCharges} = 0 or (${t.method} = 'cheque' and ${t.clearedOn} is not null)`),
    // Cash and bank receipts say where the money went from the start; a cheque says so when it is deposited.
    check("receipts_account_when_due", sql`(${t.method} <> 'cheque' and ${t.accountId} is not null) or (${t.method} = 'cheque' and ((${t.accountId} is null) = (${t.depositedOn} is null)))`),
    check(
      "receipts_cheque_is_whole",
      sql`(${t.method} = 'cheque') = (${t.chequeNumber} is not null) and (${t.method} = 'cheque') = (${t.chequeBank} is not null) and (${t.method} = 'cheque') = (${t.chequeDate} is not null)`,
    ),
    check("receipts_cheque_text_length", sql`char_length(btrim(${t.chequeNumber})) between 1 and 40 and char_length(btrim(${t.chequeBank})) between 1 and 80`),
    check("receipts_cheque_status_known", sql`${t.chequeStatus} in ('received', 'deposited', 'cleared', 'bounced')`),
    // A cheque has a stage from the moment it is posted, and nothing else ever has one.
    check("receipts_cheque_status_when_posted", sql`(${t.chequeStatus} is not null) = (${t.method} = 'cheque' and ${t.status} <> 'draft')`),
    check("receipts_bounced_is_whole", sql`(${t.status} = 'bounced') = (${t.chequeStatus} is not distinct from 'bounced') and (${t.status} = 'bounced') = (${t.bouncedOn} is not null) and (${t.status} = 'bounced') = (${t.bounceReason} is not null)`),
    check("receipts_bounce_reason_length", sql`char_length(btrim(${t.bounceReason})) between 3 and 300`),
    // In hand: not deposited. Deposited or cleared: deposited on a day. Cleared: on a day, with its journal.
    check("receipts_deposit_is_whole", sql`${t.chequeStatus} is distinct from 'received' or ${t.depositedOn} is null`),
    check("receipts_deposited_has_day", sql`${t.chequeStatus} not in ('deposited', 'cleared') or ${t.depositedOn} is not null`),
    check("receipts_cleared_is_whole", sql`(${t.clearedOn} is null) = (${t.clearanceJournalId} is null) and (${t.chequeStatus} is distinct from 'cleared' or ${t.clearedOn} is not null) and (${t.clearedOn} is null or ${t.depositedOn} is not null)`),
    check("receipts_cheque_days_in_order", sql`(${t.depositedOn} is null or (${t.depositedOn} >= ${t.receiptDate} and ${t.depositedOn} >= ${t.chequeDate})) and (${t.clearedOn} is null or ${t.clearedOn} >= ${t.depositedOn}) and (${t.bouncedOn} is null or ${t.bouncedOn} >= ${t.receiptDate})`),
    check("receipts_number_format", sql`${t.number} ~ '^RC-[0-9]{4}-[0-9]{5,}$'`),
    // A draft has no number and no journal; everything after it has both.
    check(
      "receipts_posted_is_whole",
      sql`(${t.status} = 'draft') = (${t.number} is null) and (${t.status} = 'draft') = (${t.journalId} is null) and (${t.status} = 'draft') = (${t.postedAt} is null) and (${t.status} = 'draft') = (${t.postedBy} is null)`,
    ),
    check("receipts_cancelled_is_whole", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.status} = 'cancelled') = (${t.cancelledBy} is not null) and (${t.status} = 'cancelled') = (${t.cancelReason} is not null)`),
    check("receipts_cancel_reason_length", sql`char_length(btrim(${t.cancelReason})) between 3 and 300`),
    check("receipts_reference_length", sql`char_length(btrim(${t.reference})) between 1 and 60`),
    check("receipts_note_length", sql`char_length(btrim(${t.note})) between 1 and 500`),
  ],
);

// What a receipt pays: so much of one invoice, or of one unpaid invoice brought in with the
// opening balances. What a receipt does not set against anything is the customer's advance.
//
// A row counts from the moment the database's posting function stamps it (`posted_at`), and
// stops counting when its receipt bounces or is cancelled (`voided_at`). What is still unpaid
// on an invoice is its total less the rows that count. Part of an advance set against an
// invoice later is one more row, with a journal of its own that moves the amount from advances
// to the customer's account.
export const receiptAllocations = pgTable(
  "receipt_allocations",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    receiptId: uuid("receipt_id").notNull(),
    // One of the two: a posted sales invoice, or an opening balance line for a customer.
    invoiceId: uuid("invoice_id"),
    openingBalanceId: uuid("opening_balance_id"),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    // The day it counts from: the receipt's date, or the day an advance was set against the invoice.
    allocatedOn: date("allocated_on", { mode: "string" }),
    // Only on a row that sets an advance against an invoice after the receipt was posted.
    journalId: uuid("journal_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("receipt_allocations_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "receipt_allocations_receipt_fk", columns: [t.tenantId, t.receiptId], foreignColumns: [receipts.tenantId, receipts.id] }),
    foreignKey({ name: "receipt_allocations_invoice_fk", columns: [t.tenantId, t.invoiceId], foreignColumns: [salesDocuments.tenantId, salesDocuments.id] }),
    foreignKey({ name: "receipt_allocations_opening_fk", columns: [t.tenantId, t.openingBalanceId], foreignColumns: [openingBalances.tenantId, openingBalances.id] }),
    foreignKey({ name: "receipt_allocations_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("receipt_allocations_receipt_idx").on(t.tenantId, t.receiptId),
    // What has been paid on an invoice is asked for often.
    index("receipt_allocations_invoice_idx")
      .on(t.tenantId, t.invoiceId)
      .where(sql`${t.invoiceId} is not null`),
    index("receipt_allocations_opening_idx")
      .on(t.tenantId, t.openingBalanceId)
      .where(sql`${t.openingBalanceId} is not null`),
    // While a receipt is a draft it names an invoice once.
    uniqueIndex("receipt_allocations_draft_invoice_key")
      .on(t.tenantId, t.receiptId, t.invoiceId)
      .where(sql`${t.invoiceId} is not null and ${t.journalId} is null`),
    uniqueIndex("receipt_allocations_draft_opening_key")
      .on(t.tenantId, t.receiptId, t.openingBalanceId)
      .where(sql`${t.openingBalanceId} is not null and ${t.journalId} is null`),
    check("receipt_allocations_one_target", sql`(${t.invoiceId} is null) <> (${t.openingBalanceId} is null)`),
    check("receipt_allocations_amount_sane", sql`${t.amount} > 0 and ${t.amount} < 1e16`),
    check("receipt_allocations_posted_is_whole", sql`(${t.postedAt} is null) = (${t.allocatedOn} is null) and (${t.voidedAt} is null or ${t.postedAt} is not null) and (${t.journalId} is null or ${t.postedAt} is not null)`),
  ],
);
