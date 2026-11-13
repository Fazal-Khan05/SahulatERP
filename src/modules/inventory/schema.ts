import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { items } from "../items/schema";
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
