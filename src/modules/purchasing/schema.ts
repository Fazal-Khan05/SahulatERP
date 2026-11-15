import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { items, units } from "../items/schema";
import { journals } from "../ledger/schema";
import { suppliers } from "../parties/schema";
import { tenants } from "../tenant/schema";
import { warehouses } from "../warehouses/schema";

// Buying goods, as far as their arrival: a purchase order says what was ordered from a supplier
// and at what cost; a goods received note says what arrived against it. The supplier's bill
// (Step 25) comes after: until it does, what has arrived is owed but not yet billed, and sits in
// Goods received not invoiced.
//
// A draft is written, changed and thrown away by the app. Submitting an order, cancelling it and
// posting goods received are acts of the database's own functions: the app's role cannot write
// a document's status, its number, who did it or its journal.

const documentStamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").notNull(),
};
const lineStamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
};

// What was ordered from a supplier, into which warehouse, at what cost before tax. Nothing
// reaches the books or the stock with an order: it is a promise, not a purchase.
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // draft, submitted or cancelled.
    status: text().notNull().default("draft"),
    // PO-2627-00001, taken when the order is submitted.
    number: text(),
    orderDate: date("order_date", { mode: "string" }).notNull(),
    supplierId: uuid("supplier_id").notNull(),
    // Where the goods are to arrive.
    warehouseId: uuid("warehouse_id").notNull(),
    // When the supplier said they would arrive, and the supplier's own number for the order.
    expectedOn: date("expected_on", { mode: "string" }),
    supplierReference: text("supplier_reference"),
    note: text(),
    // What the lines come to, before tax. Written by the server from the lines, checked on submit.
    total: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelReason: text("cancel_reason"),
    ...documentStamps,
  },
  (t) => [
    unique("purchase_orders_tenant_id_id_key").on(t.tenantId, t.id),
    unique("purchase_orders_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "purchase_orders_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ name: "purchase_orders_warehouse_fk", columns: [t.tenantId, t.warehouseId], foreignColumns: [warehouses.tenantId, warehouses.id] }),
    index("purchase_orders_tenant_date_idx").on(t.tenantId, t.orderDate),
    index("purchase_orders_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    check("purchase_orders_status_known", sql`${t.status} in ('draft', 'submitted', 'cancelled')`),
    check("purchase_orders_number_format", sql`${t.number} ~ '^PO-[0-9]{4}-[0-9]{5,}$'`),
    check("purchase_orders_expected_order", sql`${t.expectedOn} >= ${t.orderDate}`),
    check("purchase_orders_reference_length", sql`char_length(btrim(${t.supplierReference})) between 1 and 60`),
    check("purchase_orders_note_length", sql`char_length(btrim(${t.note})) between 1 and 500`),
    // "Not a number" passes ">= 0"; the upper bound refuses it.
    check("purchase_orders_total_sane", sql`${t.total} >= 0 and ${t.total} < 1e16`),
    check("purchase_orders_submitted_is_whole", sql`(${t.status} = 'draft') = (${t.number} is null) and (${t.status} = 'draft') = (${t.submittedAt} is null) and (${t.status} = 'draft') = (${t.submittedBy} is null)`),
    check("purchase_orders_cancelled_is_whole", sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null) and (${t.status} = 'cancelled') = (${t.cancelledBy} is not null) and (${t.status} = 'cancelled') = (${t.cancelReason} is not null)`),
    check("purchase_orders_cancel_reason_length", sql`char_length(btrim(${t.cancelReason})) between 3 and 300`),
  ],
);

// One line of an order: so many of an item, in one of the item's units, at a cost for one of
// that unit before tax. `base_quantity` is the same quantity in the item's own unit, which is
// what stock is kept in.
export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id").notNull(),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    description: text().notNull(),
    unitId: uuid("unit_id").notNull(),
    unitFactor: numeric("unit_factor", { precision: 20, scale: 6 }).notNull().default("1"),
    quantity: numeric({ precision: 20, scale: 4 }).notNull(),
    baseQuantity: numeric("base_quantity", { precision: 20, scale: 4 }).notNull(),
    // What one of the unit ordered costs, before tax; and what the line comes to.
    unitCost: numeric("unit_cost", { precision: 20, scale: 4 }).notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    ...lineStamps,
  },
  (t) => [
    unique("purchase_order_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("purchase_order_lines_line_key").on(t.tenantId, t.orderId, t.lineNo),
    // What a line of goods received points at, so it can never name another order's line.
    unique("purchase_order_lines_order_line_key").on(t.tenantId, t.orderId, t.id),
    foreignKey({ name: "purchase_order_lines_order_fk", columns: [t.tenantId, t.orderId], foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id] }),
    foreignKey({ name: "purchase_order_lines_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    foreignKey({ name: "purchase_order_lines_unit_fk", columns: [t.tenantId, t.unitId], foreignColumns: [units.tenantId, units.id] }),
    index("purchase_order_lines_tenant_item_idx").on(t.tenantId, t.itemId),
    check("purchase_order_lines_line_no_positive", sql`${t.lineNo} >= 1`),
    check("purchase_order_lines_description_length", sql`char_length(btrim(${t.description})) between 1 and 300`),
    check("purchase_order_lines_quantity_positive", sql`${t.quantity} > 0 and ${t.quantity} < 1e12 and ${t.unitFactor} > 0 and ${t.unitFactor} < 1e12`),
    check("purchase_order_lines_base_quantity_exact", sql`${t.baseQuantity} = ${t.quantity} * ${t.unitFactor}`),
    check("purchase_order_lines_cost_sane", sql`${t.unitCost} >= 0 and ${t.unitCost} < 1e16 and ${t.amount} >= 0 and ${t.amount} < 1e16`),
    // A line comes to its quantity at its cost, to the paisa.
    check("purchase_order_lines_amount_exact", sql`${t.amount} = round(${t.quantity} * ${t.unitCost}, 2)`),
  ],
);

// Goods that arrived against one submitted order, into the order's warehouse. Posting it puts
// them into stock at the order's cost and into the books: debit Stock in trade, credit Goods
// received not invoiced.
export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // draft or posted.
    status: text().notNull().default("draft"),
    // GR-2627-00001, taken when it is posted.
    number: text(),
    receiptDate: date("receipt_date", { mode: "string" }).notNull(),
    orderId: uuid("order_id").notNull(),
    // The order's supplier and warehouse, kept here so that the warehouse, which reads goods
    // received but not what an order costs, can be shown them.
    supplierId: uuid("supplier_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    // The number on the supplier's delivery note or challan.
    supplierDeliveryNote: text("supplier_delivery_note"),
    note: text(),
    // The journal it posted; none when the goods cost nothing.
    journalId: uuid("journal_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    ...documentStamps,
  },
  (t) => [
    unique("goods_receipts_tenant_id_id_key").on(t.tenantId, t.id),
    unique("goods_receipts_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "goods_receipts_order_fk", columns: [t.tenantId, t.orderId], foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id] }),
    foreignKey({ name: "goods_receipts_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ name: "goods_receipts_warehouse_fk", columns: [t.tenantId, t.warehouseId], foreignColumns: [warehouses.tenantId, warehouses.id] }),
    foreignKey({ name: "goods_receipts_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("goods_receipts_tenant_date_idx").on(t.tenantId, t.receiptDate),
    index("goods_receipts_tenant_order_idx").on(t.tenantId, t.orderId),
    // One draft for an order at a time: what is left to receive is worked out against what has been posted.
    uniqueIndex("goods_receipts_one_draft_key")
      .on(t.tenantId, t.orderId)
      .where(sql`${t.status} = 'draft'`),
    check("goods_receipts_status_known", sql`${t.status} in ('draft', 'posted')`),
    check("goods_receipts_number_format", sql`${t.number} ~ '^GR-[0-9]{4}-[0-9]{5,}$'`),
    check("goods_receipts_delivery_note_length", sql`char_length(btrim(${t.supplierDeliveryNote})) between 1 and 60`),
    check("goods_receipts_note_length", sql`char_length(btrim(${t.note})) between 1 and 500`),
    check("goods_receipts_posted_is_whole", sql`(${t.status} = 'draft') = (${t.number} is null) and (${t.status} = 'draft') = (${t.postedAt} is null) and (${t.status} = 'draft') = (${t.postedBy} is null) and (${t.status} = 'posted' or ${t.journalId} is null)`),
  ],
);

// How much of one line of the order arrived, in the unit it was ordered in. No cost here: the
// cost is the order's, and the warehouse that writes these lines is not shown it.
export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    receiptId: uuid("receipt_id").notNull(),
    lineNo: integer("line_no").notNull(),
    orderLineId: uuid("order_line_id").notNull(),
    itemId: uuid("item_id").notNull(),
    unitFactor: numeric("unit_factor", { precision: 20, scale: 6 }).notNull(),
    quantity: numeric({ precision: 20, scale: 4 }).notNull(),
    baseQuantity: numeric("base_quantity", { precision: 20, scale: 4 }).notNull(),
    ...lineStamps,
  },
  (t) => [
    unique("goods_receipt_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("goods_receipt_lines_line_key").on(t.tenantId, t.receiptId, t.lineNo),
    // A line of the order is on a goods received note once.
    unique("goods_receipt_lines_order_line_key").on(t.tenantId, t.receiptId, t.orderLineId),
    foreignKey({ name: "goods_receipt_lines_receipt_fk", columns: [t.tenantId, t.receiptId], foreignColumns: [goodsReceipts.tenantId, goodsReceipts.id] }),
    foreignKey({ name: "goods_receipt_lines_order_line_fk", columns: [t.tenantId, t.orderLineId], foreignColumns: [purchaseOrderLines.tenantId, purchaseOrderLines.id] }),
    foreignKey({ name: "goods_receipt_lines_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    index("goods_receipt_lines_tenant_order_line_idx").on(t.tenantId, t.orderLineId),
    check("goods_receipt_lines_line_no_positive", sql`${t.lineNo} >= 1`),
    check("goods_receipt_lines_quantity_positive", sql`${t.quantity} > 0 and ${t.quantity} < 1e12 and ${t.unitFactor} > 0 and ${t.unitFactor} < 1e12`),
    check("goods_receipt_lines_base_quantity_exact", sql`${t.baseQuantity} = ${t.quantity} * ${t.unitFactor}`),
  ],
);
