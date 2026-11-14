import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accounts, journals } from "../ledger/schema";
import { salesDocuments, salesLines } from "../sales/schema";
import { memberships, tenants } from "../tenant/schema";

// What the sales team has earned in commission, and what has become of it. Commission plans
// and who reports to whom are Step 37's (src/modules/commissions); this is what those plans
// came to on real invoices.
//
// An accrual is one person's commission on one line of one posted invoice: the salesperson's
// own, on their share of the line ("own"), or a manager's, on a sale made by someone below them
// ("team"). It is worked out once, when the invoice is posted, and that figure never changes.
// What does change is what has become of it: how much is still earned after returns, how much
// has been released by the customer's money coming in, and how much has been paid. Those three
// are kept on the row for reading; every change to them is a movement, and the movements are
// never changed or removed. The row is always exactly the sum of its movements.
//
// Everything here is written by the database's own functions. The app's role reads.
export const commissionAccruals = pgTable(
  "commission_accruals",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // The posted invoice and the line of it, and the day the invoice is dated.
    invoiceId: uuid("invoice_id").notNull(),
    lineId: uuid("line_id").notNull(),
    invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
    // Who earns it.
    userId: uuid("user_id").notNull(),
    // own: the salesperson's commission on their share of the line. team: a manager's, on the
    // share of someone below them; `level` is 1 for that person's own manager, 2 for the next.
    kind: text().notNull(),
    level: integer().notNull().default(0),
    // Whose share of the line it was worked out on: the earner for "own", the seller for "team".
    sellerUserId: uuid("seller_user_id").notNull(),
    // The plan it was worked out on (Step 37), kept so that a later change to the plan, or to
    // who is on it, moves nothing that was earned before.
    planId: uuid("plan_id"),
    // The seller's share of the line: its value after discount and before tax, and its
    // quantity in the item's own unit.
    sharePercent: numeric("share_percent", { precision: 7, scale: 4 }).notNull(),
    base: numeric({ precision: 20, scale: 4 }).notNull(),
    quantity: numeric({ precision: 20, scale: 4 }).notNull(),
    // For "team": the manager's percentage on the seller's sale.
    teamRate: numeric("team_rate", { precision: 7, scale: 4 }),
    // What it came to when the invoice was posted. Never changes.
    accrued: numeric({ precision: 20, scale: 4 }).notNull(),
    // What is still earned (returns take from it), how much of that the customer's money has
    // released, and how much has been paid out.
    earned: numeric({ precision: 20, scale: 4 }).notNull(),
    released: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    paid: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    // Set when the released, unpaid part is approved for payment; cleared by any later change.
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("commission_accruals_tenant_id_id_key").on(t.tenantId, t.id),
    // One accrual for each earner on each seller's share of a line.
    unique("commission_accruals_line_earner_key").on(t.tenantId, t.lineId, t.userId, t.kind, t.sellerUserId),
    foreignKey({ name: "commission_accruals_line_fk", columns: [t.tenantId, t.invoiceId, t.lineId], foreignColumns: [salesLines.tenantId, salesLines.documentId, salesLines.id] }),
    foreignKey({ name: "commission_accruals_invoice_fk", columns: [t.tenantId, t.invoiceId], foreignColumns: [salesDocuments.tenantId, salesDocuments.id] }),
    foreignKey({ name: "commission_accruals_user_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    foreignKey({ name: "commission_accruals_seller_fk", columns: [t.tenantId, t.sellerUserId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    index("commission_accruals_invoice_idx").on(t.tenantId, t.invoiceId),
    index("commission_accruals_user_idx").on(t.tenantId, t.userId, t.invoiceDate),
    check("commission_accruals_kind_known", sql`${t.kind} in ('own', 'team')`),
    check("commission_accruals_level_fits", sql`(${t.kind} = 'own') = (${t.level} = 0) and ${t.level} between 0 and 50 and (${t.kind} = 'team' or ${t.userId} = ${t.sellerUserId}) and (${t.kind} = 'own') = (${t.teamRate} is null)`),
    check("commission_accruals_share_sane", sql`${t.sharePercent} > 0 and ${t.sharePercent} <= 100 and coalesce(${t.teamRate}, 0) between 0 and 100`),
    // "Not a number" passes ">= 0"; the upper bound refuses it.
    check(
      "commission_accruals_amounts_sane",
      sql`${t.base} >= 0 and ${t.base} < 1e16 and ${t.quantity} >= 0 and ${t.quantity} < 1e16 and ${t.accrued} >= 0 and ${t.accrued} < 1e16 and ${t.earned} >= 0 and ${t.earned} <= ${t.accrued} and ${t.released} >= 0 and ${t.released} <= ${t.earned} and ${t.paid} >= 0 and ${t.paid} < 1e16`,
    ),
    check("commission_accruals_approved_is_whole", sql`(${t.approvedAt} is null) = (${t.approvedBy} is null)`),
  ],
);

// Everything that has happened to an accrual, never changed or removed:
//   accrued              the invoice was posted (the amount, above nothing)
//   entitlement_adjusted goods came back: what is earned comes down (the amount, below nothing)
//   released             the customer's money came in: so much more can be paid
//   release_reversed     a cheque bounced after it had cleared, a receipt was cancelled, or
//                        goods came back: so much less can be paid
//   paid                 it was paid out
//   recovery_recorded    it had been paid and the sale was undone afterwards: so much was
//                        taken back out of a later payment
// `base` is what the movement did to the seller's sales for the month it is dated in: the
// line's share when an invoice is posted, less the share that came back on a return. The
// month's total, which the slabs and the target of a plan are measured on, is their sum.
export const commissionMovements = pgTable(
  "commission_movements",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    accrualId: uuid("accrual_id").notNull(),
    // The order the movements were written in, across the whole database: several can be
    // written in one moment (a return brings what is earned down and takes a release back).
    seq: bigint({ mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    type: text().notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    base: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    movementDate: date("movement_date", { mode: "string" }).notNull(),
    // What caused it: the invoice, the receipt, the credit note or the payment.
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("commission_movements_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "commission_movements_accrual_fk", columns: [t.tenantId, t.accrualId], foreignColumns: [commissionAccruals.tenantId, commissionAccruals.id] }),
    unique("commission_movements_seq_key").on(t.seq),
    index("commission_movements_accrual_idx").on(t.tenantId, t.accrualId, t.seq),
    index("commission_movements_source_idx").on(t.tenantId, t.sourceType, t.sourceId),
    check("commission_movements_type_known", sql`${t.type} in ('accrued', 'entitlement_adjusted', 'released', 'release_reversed', 'paid', 'recovery_recorded')`),
    check("commission_movements_source_type_format", sql`${t.sourceType} ~ '^[a-z_]{2,40}$'`),
    // Goods coming back bring the amount and the month's sales down; everything else is above nothing.
    check(
      "commission_movements_amount_sane",
      sql`${t.amount} > -1e16 and ${t.amount} < 1e16 and ${t.base} > -1e16 and ${t.base} < 1e16 and case ${t.type} when 'entitlement_adjusted' then ${t.amount} <= 0 and ${t.base} <= 0 when 'accrued' then ${t.amount} >= 0 and ${t.base} >= 0 else ${t.amount} > 0 and ${t.base} = 0 end`,
    ),
  ],
);

// Commission paid out to one person, from a cash or bank account, in one act: everything of
// theirs that was approved, less whatever had been paid before on sales that were undone
// afterwards. Numbered CP-2627-00001. Never changed.
export const commissionPayments = pgTable(
  "commission_payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    number: text().notNull(),
    userId: uuid("user_id").notNull(),
    paymentDate: date("payment_date", { mode: "string" }).notNull(),
    // The cash or bank account the money left.
    accountId: uuid("account_id").notNull(),
    // What was approved and is paid by this, what was taken back out of it, and the money that left.
    gross: numeric({ precision: 20, scale: 4 }).notNull(),
    recovered: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    // Null when nothing left the account: everything approved went to what was owed back.
    journalId: uuid("journal_id"),
    note: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("commission_payments_tenant_id_id_key").on(t.tenantId, t.id),
    unique("commission_payments_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "commission_payments_user_fk", columns: [t.tenantId, t.userId], foreignColumns: [memberships.tenantId, memberships.userId] }),
    foreignKey({ name: "commission_payments_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "commission_payments_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("commission_payments_user_idx").on(t.tenantId, t.userId, t.paymentDate),
    check("commission_payments_number_format", sql`${t.number} ~ '^CP-[0-9]{4}-[0-9]{5,}$'`),
    check("commission_payments_amounts_sane", sql`${t.gross} > 0 and ${t.gross} < 1e16 and ${t.recovered} >= 0 and ${t.recovered} <= ${t.gross} and ${t.amount} = ${t.gross} - ${t.recovered}`),
    check("commission_payments_journal_when_paid", sql`(${t.amount} > 0) = (${t.journalId} is not null)`),
    check("commission_payments_note_length", sql`char_length(btrim(${t.note})) between 1 and 300`),
  ],
);
