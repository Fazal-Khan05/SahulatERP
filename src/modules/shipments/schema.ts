import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { items } from "../items/schema";
import { accounts, journals } from "../ledger/schema";
import { suppliers } from "../parties/schema";
import { goodsReceiptLines, goodsReceipts } from "../purchasing/schema";
import { supplierBillLines } from "../supplier-bills/schema";
import { branches, tenants } from "../tenant/schema";

// Imports. A shipment gathers the goods received notes of one consignment from a supplier,
// with what identifies it at the port (container, bill of lading, goods declaration, letter of
// credit) and how far it has come. The charges of bringing it in (freight, duty, clearing, tax
// paid at import, deposits) are lines of supplier bills charged to Goods in transit; each is
// put on the shipment with what kind of charge it is. Closing the shipment spreads the charges
// that are part of what the goods cost over the goods, into stock and, for goods already gone,
// into cost of goods sold; a charge that comes later is spread the same way when it comes.
//
// The app writes the shipment, its goods and its charges while they are open. Its number, its
// closing, the spreading of charges and everything that follows from it are the database's own.

export const shipments = pgTable(
  "shipments",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // SH-2627-00001, taken by the database as the shipment is opened.
    number: text().notNull(),
    // open, closed (its charges have been spread over its goods) or cancelled.
    status: text().notNull().default("open"),
    // How far the consignment has come: ordered, shipped, at_port, cleared or received.
    stage: text().notNull().default("ordered"),
    openedOn: date("opened_on", { mode: "string" }).notNull(),
    supplierId: uuid("supplier_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    origin: text(),
    port: text(),
    containerNo: text("container_no"),
    blNumber: text("bl_number"),
    lcNumber: text("lc_number"),
    gdNumber: text("gd_number"),
    gdDate: date("gd_date", { mode: "string" }),
    // The value customs assessed the goods at, in rupees, as on the goods declaration.
    customsValue: numeric("customs_value", { precision: 20, scale: 2 }),
    expectedOn: date("expected_on", { mode: "string" }),
    note: text(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("shipments_tenant_id_id_key").on(t.tenantId, t.id),
    unique("shipments_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "shipments_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ name: "shipments_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    index("shipments_tenant_opened_idx").on(t.tenantId, t.openedOn),
    index("shipments_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    check("shipments_number_format", sql`${t.number} ~ '^SH-[0-9]{4}-[0-9]{5,}$'`),
    check("shipments_status_known", sql`${t.status} in ('open', 'closed', 'cancelled')`),
    check("shipments_stage_known", sql`${t.stage} in ('ordered', 'shipped', 'at_port', 'cleared', 'received')`),
    check(
      "shipments_text_lengths",
      sql`char_length(btrim(${t.origin})) between 1 and 80 and char_length(btrim(${t.port})) between 1 and 80 and char_length(btrim(${t.containerNo})) between 1 and 60 and char_length(btrim(${t.blNumber})) between 1 and 60 and char_length(btrim(${t.lcNumber})) between 1 and 60 and char_length(btrim(${t.gdNumber})) between 1 and 100 and char_length(btrim(${t.note})) between 1 and 500`,
    ),
    // "Not a number" passes "> 0"; the upper bound refuses it.
    check("shipments_customs_value_sane", sql`${t.customsValue} > 0 and ${t.customsValue} < 1e16`),
    check("shipments_closed_is_whole", sql`(${t.closedAt} is null) = (${t.closedBy} is null) and (${t.status} <> 'closed' or ${t.closedAt} is not null)`),
    check(
      "shipments_cancelled_is_whole",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.status} = 'cancelled') = (${t.cancelledBy} is not null) and (${t.status} = 'cancelled') = (${t.cancelReason} is not null)`,
    ),
    check("shipments_cancel_reason_length", sql`char_length(btrim(${t.cancelReason})) between 3 and 300`),
  ],
);

// The goods of a shipment: posted goods received notes from its supplier into its branch. A
// note is on one shipment at most.
export const shipmentReceipts = pgTable(
  "shipment_receipts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    shipmentId: uuid("shipment_id").notNull(),
    receiptId: uuid("receipt_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("shipment_receipts_tenant_id_id_key").on(t.tenantId, t.id),
    unique("shipment_receipts_receipt_key").on(t.tenantId, t.receiptId),
    foreignKey({ name: "shipment_receipts_shipment_fk", columns: [t.tenantId, t.shipmentId], foreignColumns: [shipments.tenantId, shipments.id] }),
    foreignKey({ name: "shipment_receipts_receipt_fk", columns: [t.tenantId, t.receiptId], foreignColumns: [goodsReceipts.tenantId, goodsReceipts.id] }),
    index("shipment_receipts_tenant_shipment_idx").on(t.tenantId, t.shipmentId),
  ],
);

// One time the charges of a shipment were spread over its goods: when it was closed, and again
// for each charge that came later. Written only by the database, with its journal.
export const shipmentAllocations = pgTable(
  "shipment_allocations",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    shipmentId: uuid("shipment_id").notNull(),
    allocatedOn: date("allocated_on", { mode: "string" }).notNull(),
    // Everything the charges came to; of it, what went into stock and what went to cost of
    // goods sold because the goods had already gone. The rest is tax, deposits and expenses.
    total: numeric({ precision: 20, scale: 2 }).notNull(),
    toStock: numeric("to_stock", { precision: 20, scale: 2 }).notNull(),
    toCogs: numeric("to_cogs", { precision: 20, scale: 2 }).notNull(),
    journalId: uuid("journal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("shipment_allocations_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "shipment_allocations_shipment_fk", columns: [t.tenantId, t.shipmentId], foreignColumns: [shipments.tenantId, shipments.id] }),
    foreignKey({ name: "shipment_allocations_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("shipment_allocations_tenant_shipment_idx").on(t.tenantId, t.shipmentId),
    check("shipment_allocations_amounts_sane", sql`${t.total} > 0 and ${t.total} < 1e16 and ${t.toStock} >= 0 and ${t.toCogs} >= 0 and ${t.toStock} + ${t.toCogs} <= ${t.total}`),
  ],
);

// One charge of bringing a shipment in: a line of a posted supplier bill that was charged to
// Goods in transit, with what kind of charge it is. A bill line is on one shipment at most.
//   inventory            part of what the goods cost: spread over the goods by value,
//                        quantity, weight or volume
//   sales_tax            sales tax paid at import that the company claims back
//   advance_income_tax   income tax paid at import, set against the year's tax
//   deposit              money that comes back (a container deposit): to an asset account
//   expense              not part of what the goods cost: to an expense account
export const shipmentCharges = pgTable(
  "shipment_charges",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    shipmentId: uuid("shipment_id").notNull(),
    billLineId: uuid("bill_line_id").notNull(),
    class: text().notNull(),
    // For a charge that is part of what the goods cost: what it is spread by.
    basis: text(),
    // For a deposit or an expense: the account it goes to.
    accountId: uuid("account_id"),
    // What the bill charged to Goods in transit for the line; written by the database.
    amount: numeric({ precision: 20, scale: 2 }).notNull(),
    // Set when the charge has been spread: the time it was.
    allocationId: uuid("allocation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("shipment_charges_tenant_id_id_key").on(t.tenantId, t.id),
    unique("shipment_charges_bill_line_key").on(t.tenantId, t.billLineId),
    foreignKey({ name: "shipment_charges_shipment_fk", columns: [t.tenantId, t.shipmentId], foreignColumns: [shipments.tenantId, shipments.id] }),
    foreignKey({ name: "shipment_charges_bill_line_fk", columns: [t.tenantId, t.billLineId], foreignColumns: [supplierBillLines.tenantId, supplierBillLines.id] }),
    foreignKey({ name: "shipment_charges_account_fk", columns: [t.tenantId, t.accountId], foreignColumns: [accounts.tenantId, accounts.id] }),
    foreignKey({ name: "shipment_charges_allocation_fk", columns: [t.tenantId, t.allocationId], foreignColumns: [shipmentAllocations.tenantId, shipmentAllocations.id] }),
    index("shipment_charges_tenant_shipment_idx").on(t.tenantId, t.shipmentId),
    check("shipment_charges_class_known", sql`${t.class} in ('inventory', 'sales_tax', 'advance_income_tax', 'deposit', 'expense')`),
    check("shipment_charges_basis_known", sql`${t.basis} in ('value', 'quantity', 'weight', 'volume')`),
    check("shipment_charges_basis_for_inventory", sql`(${t.class} = 'inventory') = (${t.basis} is not null)`),
    check("shipment_charges_account_for_class", sql`(${t.class} in ('deposit', 'expense')) = (${t.accountId} is not null)`),
    check("shipment_charges_amount_sane", sql`${t.amount} > 0 and ${t.amount} < 1e16`),
  ],
);

// What one charge put on one line of the shipment's goods: its share, and of that what went
// into stock and what went to cost of goods sold. Written only by the database.
export const landedCostAllocations = pgTable(
  "landed_cost_allocations",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    allocationId: uuid("allocation_id").notNull(),
    chargeId: uuid("charge_id").notNull(),
    receiptLineId: uuid("receipt_line_id").notNull(),
    itemId: uuid("item_id").notNull(),
    amount: numeric({ precision: 20, scale: 2 }).notNull(),
    toStock: numeric("to_stock", { precision: 20, scale: 2 }).notNull(),
    toCogs: numeric("to_cogs", { precision: 20, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("landed_cost_allocations_tenant_id_id_key").on(t.tenantId, t.id),
    unique("landed_cost_allocations_charge_line_key").on(t.tenantId, t.chargeId, t.receiptLineId),
    foreignKey({ name: "landed_cost_allocations_allocation_fk", columns: [t.tenantId, t.allocationId], foreignColumns: [shipmentAllocations.tenantId, shipmentAllocations.id] }),
    foreignKey({ name: "landed_cost_allocations_charge_fk", columns: [t.tenantId, t.chargeId], foreignColumns: [shipmentCharges.tenantId, shipmentCharges.id] }),
    foreignKey({ name: "landed_cost_allocations_receipt_line_fk", columns: [t.tenantId, t.receiptLineId], foreignColumns: [goodsReceiptLines.tenantId, goodsReceiptLines.id] }),
    foreignKey({ name: "landed_cost_allocations_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    index("landed_cost_allocations_tenant_allocation_idx").on(t.tenantId, t.allocationId),
    index("landed_cost_allocations_tenant_receipt_line_idx").on(t.tenantId, t.receiptLineId),
    check("landed_cost_allocations_amounts_exact", sql`${t.amount} >= 0 and ${t.amount} < 1e16 and ${t.toStock} >= 0 and ${t.toCogs} >= 0 and ${t.toStock} + ${t.toCogs} = ${t.amount}`),
  ],
);
