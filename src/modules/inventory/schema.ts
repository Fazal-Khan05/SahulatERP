import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { items } from "../items/schema";
import { journals } from "../ledger/schema";
import { tenants } from "../tenant/schema";
import { warehouses } from "../warehouses/schema";

// Stock is kept as moves: every quantity that comes into or leaves a warehouse is one row, with
// what it was worth. Moves are written only by the database's own posting functions, whole or
// not at all, and never changed or removed afterwards: a wrong move is undone by an opposite one.
//
// A move out is valued at the weighted-average cost of what the warehouse held at that moment:
// the value on hand times the quantity leaving, over the quantity on hand. Quantities are in the
// item's own unit; values are in the company's base currency.
export const stockMoves = pgTable(
  "stock_moves",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    itemId: uuid("item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    moveDate: date("move_date", { mode: "string" }).notNull(),
    // Above zero for goods coming in, below zero for goods leaving.
    quantity: numeric({ precision: 20, scale: 4 }).notNull(),
    // What the goods were worth, with the same sign as the quantity.
    value: numeric({ precision: 20, scale: 4 }).notNull(),
    // The document that caused the move, and the line of it.
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceLineId: uuid("source_line_id"),
    // Set on a move that undoes another: the move it undoes.
    reversesMoveId: uuid("reverses_move_id"),
    // What the warehouse held of the item once this move was made.
    quantityAfter: numeric("quantity_after", { precision: 20, scale: 4 }).notNull(),
    valueAfter: numeric("value_after", { precision: 20, scale: 4 }).notNull(),
    // For batches and serial numbers, which do not exist yet; kept from day one so no move ever lacks the columns.
    batchId: uuid("batch_id"),
    serialId: uuid("serial_id"),
    // The transaction that wrote the move.
    postedTxid: bigint("posted_txid", { mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("stock_moves_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "stock_moves_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    foreignKey({ name: "stock_moves_warehouse_fk", columns: [t.tenantId, t.warehouseId], foreignColumns: [warehouses.tenantId, warehouses.id] }),
    foreignKey({ name: "stock_moves_reverses_fk", columns: [t.tenantId, t.reversesMoveId], foreignColumns: [t.tenantId, t.id] }),
    // A move is undone at most once.
    unique("stock_moves_reverses_key").on(t.tenantId, t.reversesMoveId),
    index("stock_moves_tenant_item_idx").on(t.tenantId, t.itemId, t.warehouseId, t.createdAt),
    index("stock_moves_tenant_source_idx").on(t.tenantId, t.sourceType, t.sourceId),
    check("stock_moves_source_type_format", sql`${t.sourceType} ~ '^[a-z_]{2,40}$'`),
    // "Not a number" passes ">= 0"; the bounds refuse it.
    check("stock_moves_quantity_sane", sql`${t.quantity} <> 0 and ${t.quantity} > -1e12 and ${t.quantity} < 1e12`),
    check("stock_moves_value_sane", sql`${t.value} > -1e16 and ${t.value} < 1e16 and (${t.value} = 0 or sign(${t.value}) = sign(${t.quantity}))`),
    check("stock_moves_after_sane", sql`${t.quantityAfter} >= 0 and ${t.quantityAfter} < 1e12 and ${t.valueAfter} >= 0 and ${t.valueAfter} < 1e16 and (${t.quantityAfter} > 0 or ${t.valueAfter} = 0)`),
    check("stock_moves_no_batches_yet", sql`${t.batchId} is null and ${t.serialId} is null`),
    check("stock_moves_not_own_reversal", sql`${t.reversesMoveId} is distinct from ${t.id}`),
  ],
);

// What a warehouse holds of an item now, and what it is worth: the sum of the item's moves
// there, kept beside them so that a delivery does not have to add them all up. Written only by
// the same functions that write the moves. It never goes below zero.
export const stockBalances = pgTable(
  "stock_balances",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    itemId: uuid("item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    quantity: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    value: numeric({ precision: 20, scale: 4 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("stock_balances_tenant_id_id_key").on(t.tenantId, t.id),
    unique("stock_balances_item_warehouse_key").on(t.tenantId, t.itemId, t.warehouseId),
    foreignKey({ name: "stock_balances_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    foreignKey({ name: "stock_balances_warehouse_fk", columns: [t.tenantId, t.warehouseId], foreignColumns: [warehouses.tenantId, warehouses.id] }),
    index("stock_balances_tenant_warehouse_idx").on(t.tenantId, t.warehouseId),
    check("stock_balances_not_negative", sql`${t.quantity} >= 0 and ${t.quantity} < 1e12 and ${t.value} >= 0 and ${t.value} < 1e16 and (${t.quantity} > 0 or ${t.value} = 0)`),
  ],
);

// ── Step 30: the documents that move stock by hand ──────────────────────────────────────────────
// A transfer, an adjustment (or opening stock) and a count are each a document: a draft that can
// be changed and thrown away, then posted once by the database's own function, which takes the
// number, writes the stock moves and, where the value of stock changes, the journal. The app's
// role cannot write a status, a number or who posted: those columns are closed to it. A posted
// document and its lines never change; a wrong one is put right by an opposite document.

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

// Goods moved from one warehouse to another. They leave at the weighted-average cost of the
// warehouse they leave and arrive worth exactly that, so the books do not change: no journal.
export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // draft or posted.
    status: text().notNull().default("draft"),
    transferDate: date("transfer_date", { mode: "string" }).notNull(),
    fromWarehouseId: uuid("from_warehouse_id").notNull(),
    toWarehouseId: uuid("to_warehouse_id").notNull(),
    note: text(),
    // ST-2627-00001, taken when the transfer is posted.
    number: text(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    ...documentStamps,
  },
  (t) => [
    unique("stock_transfers_tenant_id_id_key").on(t.tenantId, t.id),
    unique("stock_transfers_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "stock_transfers_from_fk", columns: [t.tenantId, t.fromWarehouseId], foreignColumns: [warehouses.tenantId, warehouses.id] }),
    foreignKey({ name: "stock_transfers_to_fk", columns: [t.tenantId, t.toWarehouseId], foreignColumns: [warehouses.tenantId, warehouses.id] }),
    index("stock_transfers_tenant_date_idx").on(t.tenantId, t.transferDate),
    check("stock_transfers_status_known", sql`${t.status} in ('draft', 'posted')`),
    check("stock_transfers_two_warehouses", sql`${t.fromWarehouseId} <> ${t.toWarehouseId}`),
    check("stock_transfers_note_length", sql`char_length(btrim(${t.note})) between 1 and 500`),
    check("stock_transfers_number_format", sql`${t.number} ~ '^ST-[0-9]{4}-[0-9]{5,}$'`),
    check("stock_transfers_posted_is_whole", sql`(${t.status} = 'draft') = (${t.number} is null) and (${t.status} = 'draft') = (${t.postedAt} is null) and (${t.status} = 'draft') = (${t.postedBy} is null)`),
  ],
);

export const stockTransferLines = pgTable(
  "stock_transfer_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    transferId: uuid("transfer_id").notNull(),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    // In the item's own unit, above zero.
    quantity: numeric({ precision: 20, scale: 4 }).notNull(),
    ...lineStamps,
  },
  (t) => [
    unique("stock_transfer_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("stock_transfer_lines_line_key").on(t.tenantId, t.transferId, t.lineNo),
    // An item is on a transfer once.
    unique("stock_transfer_lines_item_key").on(t.tenantId, t.transferId, t.itemId),
    foreignKey({ name: "stock_transfer_lines_transfer_fk", columns: [t.tenantId, t.transferId], foreignColumns: [stockTransfers.tenantId, stockTransfers.id] }),
    foreignKey({ name: "stock_transfer_lines_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    check("stock_transfer_lines_line_no_positive", sql`${t.lineNo} >= 1`),
    check("stock_transfer_lines_quantity_sane", sql`${t.quantity} > 0 and ${t.quantity} < 1e12`),
  ],
);

// Stock put right by hand in one warehouse, with the reason: goods written off, or goods added.
// The same document, as kind 'opening', brings in the stock a company holds on the day it
// starts here. What leaves is valued at the weighted-average cost; what comes in at the cost
// stated on its line or, when none is stated, at the cost the warehouse already holds it at.
// The other side of the journal is the stock adjustments account, or opening balance equity for
// opening stock.
export const stockAdjustments = pgTable(
  "stock_adjustments",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // adjustment or opening.
    kind: text().notNull().default("adjustment"),
    status: text().notNull().default("draft"),
    adjustmentDate: date("adjustment_date", { mode: "string" }).notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    // Why, from a fixed list; opening stock has none.
    reason: text(),
    note: text(),
    // SA-2627-00001, taken when the adjustment is posted.
    number: text(),
    // The journal it posted; none when nothing of value moved.
    journalId: uuid("journal_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    ...documentStamps,
  },
  (t) => [
    unique("stock_adjustments_tenant_id_id_key").on(t.tenantId, t.id),
    unique("stock_adjustments_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "stock_adjustments_warehouse_fk", columns: [t.tenantId, t.warehouseId], foreignColumns: [warehouses.tenantId, warehouses.id] }),
    foreignKey({ name: "stock_adjustments_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("stock_adjustments_tenant_date_idx").on(t.tenantId, t.adjustmentDate),
    check("stock_adjustments_kind_known", sql`${t.kind} in ('adjustment', 'opening')`),
    check("stock_adjustments_status_known", sql`${t.status} in ('draft', 'posted')`),
    check(
      "stock_adjustments_reason_known",
      sql`(${t.kind} = 'opening' and ${t.reason} is null) or (${t.kind} = 'adjustment' and ${t.reason} in ('damaged', 'lost', 'found', 'sample', 'own_use', 'correction', 'other'))`,
    ),
    // "Other" says what it was.
    check("stock_adjustments_other_has_note", sql`${t.reason} is distinct from 'other' or ${t.note} is not null`),
    check("stock_adjustments_note_length", sql`char_length(btrim(${t.note})) between 1 and 500`),
    check("stock_adjustments_number_format", sql`${t.number} ~ '^SA-[0-9]{4}-[0-9]{5,}$'`),
    check("stock_adjustments_posted_is_whole", sql`(${t.status} = 'draft') = (${t.number} is null) and (${t.status} = 'draft') = (${t.postedAt} is null) and (${t.status} = 'draft') = (${t.postedBy} is null) and (${t.status} = 'posted' or ${t.journalId} is null)`),
  ],
);

export const stockAdjustmentLines = pgTable(
  "stock_adjustment_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    adjustmentId: uuid("adjustment_id").notNull(),
    lineNo: integer("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    // In the item's own unit: above zero for goods added, below zero for goods taken out.
    quantity: numeric({ precision: 20, scale: 4 }).notNull(),
    // What one of the item's own unit cost, for goods added. Goods taken out leave at the average.
    unitCost: numeric("unit_cost", { precision: 20, scale: 4 }),
    ...lineStamps,
  },
  (t) => [
    unique("stock_adjustment_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("stock_adjustment_lines_line_key").on(t.tenantId, t.adjustmentId, t.lineNo),
    unique("stock_adjustment_lines_item_key").on(t.tenantId, t.adjustmentId, t.itemId),
    foreignKey({ name: "stock_adjustment_lines_adjustment_fk", columns: [t.tenantId, t.adjustmentId], foreignColumns: [stockAdjustments.tenantId, stockAdjustments.id] }),
    foreignKey({ name: "stock_adjustment_lines_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    check("stock_adjustment_lines_line_no_positive", sql`${t.lineNo} >= 1`),
    check("stock_adjustment_lines_quantity_sane", sql`${t.quantity} <> 0 and ${t.quantity} > -1e12 and ${t.quantity} < 1e12`),
    check("stock_adjustment_lines_cost_sane", sql`${t.unitCost} is null or (${t.quantity} > 0 and ${t.unitCost} >= 0 and ${t.unitCost} < 1e12)`),
  ],
);

// A stock count of one warehouse. Each line holds what the books said the warehouse had when
// the line was written (the database writes that figure itself) and what was counted. The
// warehouse counts and marks the sheet finished; an owner or an accountant then posts it, which
// moves stock by the difference on every counted line and posts the value of the differences to
// the stock adjustments account.
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // draft (being counted), submitted (finished, waiting to be posted) or posted.
    status: text().notNull().default("draft"),
    countDate: date("count_date", { mode: "string" }).notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    note: text(),
    // SC-2627-00001, taken when the count is posted.
    number: text(),
    journalId: uuid("journal_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    ...documentStamps,
  },
  (t) => [
    unique("stock_counts_tenant_id_id_key").on(t.tenantId, t.id),
    unique("stock_counts_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "stock_counts_warehouse_fk", columns: [t.tenantId, t.warehouseId], foreignColumns: [warehouses.tenantId, warehouses.id] }),
    foreignKey({ name: "stock_counts_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("stock_counts_tenant_date_idx").on(t.tenantId, t.countDate),
    check("stock_counts_status_known", sql`${t.status} in ('draft', 'submitted', 'posted')`),
    check("stock_counts_note_length", sql`char_length(btrim(${t.note})) between 1 and 500`),
    check("stock_counts_number_format", sql`${t.number} ~ '^SC-[0-9]{4}-[0-9]{5,}$'`),
    check("stock_counts_submitted_is_whole", sql`(${t.status} = 'draft') = (${t.submittedAt} is null) and (${t.status} = 'draft') = (${t.submittedBy} is null)`),
    check("stock_counts_posted_is_whole", sql`(${t.status} = 'posted') = (${t.number} is not null) and (${t.status} = 'posted') = (${t.postedAt} is not null) and (${t.status} = 'posted') = (${t.postedBy} is not null) and (${t.status} = 'posted' or ${t.journalId} is null)`),
  ],
);

export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    countId: uuid("count_id").notNull(),
    itemId: uuid("item_id").notNull(),
    // What the books said the warehouse held when this line was written, or last brought up to date.
    bookQuantity: numeric("book_quantity", { precision: 20, scale: 4 }).notNull().default("0"),
    // What was found on the shelf; empty until it is counted.
    countedQuantity: numeric("counted_quantity", { precision: 20, scale: 4 }),
    ...lineStamps,
  },
  (t) => [
    unique("stock_count_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("stock_count_lines_item_key").on(t.tenantId, t.countId, t.itemId),
    foreignKey({ name: "stock_count_lines_count_fk", columns: [t.tenantId, t.countId], foreignColumns: [stockCounts.tenantId, stockCounts.id] }),
    foreignKey({ name: "stock_count_lines_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    check("stock_count_lines_quantities_sane", sql`${t.bookQuantity} >= 0 and ${t.bookQuantity} < 1e12 and (${t.countedQuantity} is null or (${t.countedQuantity} >= 0 and ${t.countedQuantity} < 1e12))`),
  ],
);
