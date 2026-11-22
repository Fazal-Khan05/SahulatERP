import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accounts, journals } from "../ledger/schema";
import { suppliers } from "../parties/schema";
import { supplierBills, withholdingEntries } from "../supplier-bills/schema";
import { branches, tenants } from "../tenant/schema";

// Paying suppliers. A payment goes out of a cash or bank account to one supplier. What it is
// set against a posted bill settles that bill in Trade payables; whatever is left over is an
// advance, held in Advances to suppliers until it is set against a later bill. Tax withheld on
// bills (Step 25) is paid to the government under a challan, recorded here.
//
// A payment is a draft the app writes. Posting it, setting an advance against a bill,
// cancelling it and recording a challan are acts of the database's own functions: the app's
// role cannot write a payment's status, number or journal, nor any challan.

const documentStamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").notNull(),
};

export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // draft, posted or cancelled.
    status: text().notNull().default("draft"),
    // PV-2627-00001, taken when the payment is posted.
    number: text(),
    paymentDate: date("payment_date", { mode: "string" }).notNull(),
    supplierId: uuid("supplier_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    // The cash or bank account the money leaves.
    accountId: uuid("account_id").notNull(),
    // The cheque number or the bank's reference for the transfer.
    reference: text(),
    note: text(),
    // The rupees that left the account.
    amount: numeric({ precision: 20, scale: 2 }).notNull(),
    // Where the supplier was paid in another currency: which, and how much of it the rupees
    // bought. Kept for the record only: the books hold the rupees actually paid, and an advance
    // is never revalued (the founder's decision, 2026-11-15).
    foreignCurrency: text("foreign_currency"),
    foreignAmount: numeric("foreign_amount", { precision: 20, scale: 2 }),
    journalId: uuid("journal_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelledOn: date("cancelled_on", { mode: "string" }),
    cancelReason: text("cancel_reason"),
    ...documentStamps,
  },
  (t) => [
    unique("supplier_payments_tenant_id_id_key").on(t.tenantId, t.id),
    unique("supplier_payments_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "supplier_payments_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ name: "supplier_payments_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "supplier_payments_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "supplier_payments_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("supplier_payments_tenant_date_idx").on(t.tenantId, t.paymentDate),
    index("supplier_payments_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    check("supplier_payments_status_known", sql`${t.status} in ('draft', 'posted', 'cancelled')`),
    check("supplier_payments_number_format", sql`${t.number} ~ '^PV-[0-9]{4}-[0-9]{5,}$'`),
    check("supplier_payments_reference_length", sql`char_length(btrim(${t.reference})) between 1 and 60`),
    check("supplier_payments_note_length", sql`char_length(btrim(${t.note})) between 1 and 500`),
    // "Not a number" passes "> 0"; the upper bound refuses it.
    check("supplier_payments_amount_sane", sql`${t.amount} > 0 and ${t.amount} < 1e16`),
    check("supplier_payments_foreign_is_whole", sql`(${t.foreignCurrency} is null) = (${t.foreignAmount} is null)`),
    check("supplier_payments_foreign_sane", sql`${t.foreignCurrency} ~ '^[A-Z]{3}$' and ${t.foreignAmount} > 0 and ${t.foreignAmount} < 1e16`),
    check("supplier_payments_posted_is_whole", sql`(${t.status} = 'draft') = (${t.number} is null) and (${t.status} = 'draft') = (${t.postedAt} is null) and (${t.status} = 'draft') = (${t.postedBy} is null) and (${t.status} = 'draft') = (${t.journalId} is null)`),
    check(
      "supplier_payments_cancelled_is_whole",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.status} = 'cancelled') = (${t.cancelledBy} is not null) and (${t.status} = 'cancelled') = (${t.cancelledOn} is not null) and (${t.status} = 'cancelled') = (${t.cancelReason} is not null)`,
    ),
    check("supplier_payments_cancel_reason_length", sql`char_length(btrim(${t.cancelReason})) between 3 and 300`),
  ],
);

// What a payment settles of one posted bill. Written with the draft, by the app, for what the
// payment pays as it goes out; or written later by the database, when what was left of the
// payment (an advance) is set against a bill, with the day and the journal of that.
export const supplierPaymentAllocations = pgTable(
  "supplier_payment_allocations",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid("payment_id").notNull(),
    billId: uuid("bill_id").notNull(),
    amount: numeric({ precision: 20, scale: 2 }).notNull(),
    // Null for what the payment settled as it went out; the day an advance was set against the bill.
    appliedOn: date("applied_on", { mode: "string" }),
    journalId: uuid("journal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("supplier_payment_allocations_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "supplier_payment_allocations_payment_fk", columns: [t.tenantId, t.paymentId], foreignColumns: [supplierPayments.tenantId, supplierPayments.id] }),
    foreignKey({ name: "supplier_payment_allocations_bill_fk", columns: [t.tenantId, t.billId], foreignColumns: [supplierBills.tenantId, supplierBills.id] }),
    foreignKey({ name: "supplier_payment_allocations_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("supplier_payment_allocations_tenant_payment_idx").on(t.tenantId, t.paymentId),
    index("supplier_payment_allocations_tenant_bill_idx").on(t.tenantId, t.billId),
    check("supplier_payment_allocations_amount_sane", sql`${t.amount} > 0 and ${t.amount} < 1e16`),
    check("supplier_payment_allocations_applied_is_whole", sql`(${t.appliedOn} is null) = (${t.journalId} is null)`),
  ],
);

// Tax withheld from suppliers, paid to the government: one challan for one kind of tax, out of
// a cash or bank account, covering whole withholding entries. Written only by the database.
export const withholdingChallans = pgTable(
  "withholding_challans",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // WC-2627-00001.
    number: text().notNull(),
    // income_tax, sales_tax or provincial_sales_tax.
    kind: text().notNull(),
    // The number on the challan or the computerised payment receipt (CPR).
    challanNo: text("challan_no").notNull(),
    paidOn: date("paid_on", { mode: "string" }).notNull(),
    accountId: uuid("account_id").notNull(),
    amount: numeric({ precision: 20, scale: 2 }).notNull(),
    note: text(),
    journalId: uuid("journal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("withholding_challans_tenant_id_id_key").on(t.tenantId, t.id),
    unique("withholding_challans_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "withholding_challans_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "withholding_challans_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("withholding_challans_tenant_date_idx").on(t.tenantId, t.paidOn),
    check("withholding_challans_number_format", sql`${t.number} ~ '^WC-[0-9]{4}-[0-9]{5,}$'`),
    check("withholding_challans_kind_known", sql`${t.kind} in ('income_tax', 'sales_tax', 'provincial_sales_tax')`),
    check("withholding_challans_challan_no_length", sql`char_length(btrim(${t.challanNo})) between 1 and 60`),
    check("withholding_challans_note_length", sql`char_length(btrim(${t.note})) between 1 and 500`),
    check("withholding_challans_amount_sane", sql`${t.amount} > 0 and ${t.amount} < 1e16`),
  ],
);

// Which withholding entries a challan paid. An entry is paid once, whole.
export const withholdingChallanEntries = pgTable(
  "withholding_challan_entries",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    challanId: uuid("challan_id").notNull(),
    entryId: uuid("entry_id").notNull(),
  },
  (t) => [
    unique("withholding_challan_entries_entry_key").on(t.tenantId, t.entryId),
    foreignKey({ name: "withholding_challan_entries_challan_fk", columns: [t.tenantId, t.challanId], foreignColumns: [withholdingChallans.tenantId, withholdingChallans.id] }),
    foreignKey({ name: "withholding_challan_entries_entry_fk", columns: [t.tenantId, t.entryId], foreignColumns: [withholdingEntries.tenantId, withholdingEntries.id] }),
    index("withholding_challan_entries_tenant_challan_idx").on(t.tenantId, t.challanId),
  ],
);
