import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { items } from "../items/schema";
import { journals } from "../ledger/schema";
import { suppliers } from "../parties/schema";
import { goodsReceiptLines, goodsReceipts } from "../purchasing/schema";
import { supplierBillLines, supplierBills } from "../supplier-bills/schema";
import { branches, tenants } from "../tenant/schema";
import { warehouses } from "../warehouses/schema";

// Goods sent back to a supplier. A return is written against one posted goods received note:
// each line sends back so much of one of its lines, either of what has not been billed yet or
// of what one posted bill billed. It is a draft the app writes. Posting it is an act of the
// database's own function: the goods leave the warehouse, and what is undone is Goods received
// not invoiced (for goods not billed) or what is owed to the supplier (for goods billed, a
// debit note). The app's role cannot write a return's status, number, journal or figures.

const documentStamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").notNull(),
};

export const supplierReturns = pgTable(
  "supplier_returns",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // draft or posted.
    status: text().notNull().default("draft"),
    // DB-2627-00001 (a debit note), taken when the return is posted.
    number: text(),
    returnDate: date("return_date", { mode: "string" }).notNull(),
    // The goods received note the goods came in on, with its supplier, its warehouse and that warehouse's branch.
    receiptId: uuid("receipt_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    reason: text().notNull(),
    // The supplier's own credit note number, where it has given one.
    supplierReference: text("supplier_reference"),
    // Written when the return is posted. What the goods left stock at (as stock is valued, to
    // four decimals); what came off Goods
    // received not invoiced; what the supplier had billed for the goods, and the sales tax on
    // that; and the two together, which the supplier now owes back.
    stockValue: numeric("stock_value", { precision: 20, scale: 4 }).notNull().default("0"),
    grniValue: numeric("grni_value", { precision: 20, scale: 2 }).notNull().default("0"),
    billedAmount: numeric("billed_amount", { precision: 20, scale: 2 }).notNull().default("0"),
    salesTax: numeric("sales_tax", { precision: 20, scale: 2 }).notNull().default("0"),
    credit: numeric({ precision: 20, scale: 2 }).notNull().default("0"),
    journalId: uuid("journal_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    ...documentStamps,
  },
  (t) => [
    unique("supplier_returns_tenant_id_id_key").on(t.tenantId, t.id),
    unique("supplier_returns_number_key").on(t.tenantId, t.number),
    foreignKey({ name: "supplier_returns_receipt_fk", columns: [t.tenantId, t.receiptId], foreignColumns: [goodsReceipts.tenantId, goodsReceipts.id] }),
    foreignKey({ name: "supplier_returns_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    foreignKey({ name: "supplier_returns_warehouse_fk", columns: [t.tenantId, t.warehouseId], foreignColumns: [warehouses.tenantId, warehouses.id] }),
    foreignKey({ name: "supplier_returns_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "supplier_returns_journal_fk", columns: [t.tenantId, t.journalId], foreignColumns: [journals.tenantId, journals.id] }),
    index("supplier_returns_tenant_date_idx").on(t.tenantId, t.returnDate),
    index("supplier_returns_tenant_receipt_idx").on(t.tenantId, t.receiptId),
    index("supplier_returns_tenant_supplier_idx").on(t.tenantId, t.supplierId),
    check("supplier_returns_status_known", sql`${t.status} in ('draft', 'posted')`),
    check("supplier_returns_number_format", sql`${t.number} ~ '^DB-[0-9]{4}-[0-9]{5,}$'`),
    check("supplier_returns_reason_length", sql`char_length(btrim(${t.reason})) between 3 and 300`),
    check("supplier_returns_reference_length", sql`char_length(btrim(${t.supplierReference})) between 1 and 60`),
    // "Not a number" passes ">= 0"; the upper bound refuses it.
    check(
      "supplier_returns_figures_sane",
      sql`${t.stockValue} >= 0 and ${t.stockValue} < 1e16 and ${t.grniValue} >= 0 and ${t.grniValue} < 1e16 and ${t.billedAmount} >= 0 and ${t.billedAmount} < 1e16 and ${t.salesTax} >= 0 and ${t.salesTax} < 1e16`,
    ),
    check("supplier_returns_credit_exact", sql`${t.credit} = ${t.billedAmount} + ${t.salesTax}`),
    check(
      "supplier_returns_draft_is_bare",
      sql`${t.status} = 'posted' or (${t.stockValue} = 0 and ${t.grniValue} = 0 and ${t.billedAmount} = 0 and ${t.salesTax} = 0 and ${t.journalId} is null)`,
    ),
    check("supplier_returns_posted_is_whole", sql`(${t.status} = 'draft') = (${t.number} is null) and (${t.status} = 'draft') = (${t.postedAt} is null) and (${t.status} = 'draft') = (${t.postedBy} is null)`),
  ],
);

// One line: so much of one line of the return's goods received note, in the unit it was
// received in. With no bill line it is goods not billed yet; with one, goods that bill billed.
// The figures are written when the return is posted.
export const supplierReturnLines = pgTable(
  "supplier_return_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    returnId: uuid("return_id").notNull(),
    lineNo: integer("line_no").notNull(),
    receiptLineId: uuid("receipt_line_id").notNull(),
    billLineId: uuid("bill_line_id"),
    itemId: uuid("item_id").notNull(),
    unitFactor: numeric("unit_factor", { precision: 20, scale: 6 }).notNull(),
    quantity: numeric({ precision: 20, scale: 4 }).notNull(),
    baseQuantity: numeric("base_quantity", { precision: 20, scale: 4 }).notNull(),
    // What the goods left stock at; and either what came off Goods received not invoiced, or
    // what the bill had charged for them and the sales tax on that.
    stockValue: numeric("stock_value", { precision: 20, scale: 4 }),
    grniValue: numeric("grni_value", { precision: 20, scale: 2 }),
    amount: numeric({ precision: 20, scale: 2 }),
    salesTax: numeric("sales_tax", { precision: 20, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("supplier_return_lines_tenant_id_id_key").on(t.tenantId, t.id),
    unique("supplier_return_lines_line_key").on(t.tenantId, t.returnId, t.lineNo),
    foreignKey({ name: "supplier_return_lines_return_fk", columns: [t.tenantId, t.returnId], foreignColumns: [supplierReturns.tenantId, supplierReturns.id] }),
    foreignKey({ name: "supplier_return_lines_receipt_line_fk", columns: [t.tenantId, t.receiptLineId], foreignColumns: [goodsReceiptLines.tenantId, goodsReceiptLines.id] }),
    foreignKey({ name: "supplier_return_lines_bill_line_fk", columns: [t.tenantId, t.billLineId], foreignColumns: [supplierBillLines.tenantId, supplierBillLines.id] }),
    foreignKey({ name: "supplier_return_lines_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    // A receipt line's unbilled goods once on a return, and a bill line once.
    uniqueIndex("supplier_return_lines_unbilled_key").on(t.tenantId, t.returnId, t.receiptLineId).where(sql`${t.billLineId} is null`),
    uniqueIndex("supplier_return_lines_billed_key").on(t.tenantId, t.returnId, t.billLineId).where(sql`${t.billLineId} is not null`),
    index("supplier_return_lines_tenant_receipt_line_idx").on(t.tenantId, t.receiptLineId),
    index("supplier_return_lines_tenant_bill_line_idx").on(t.tenantId, t.billLineId),
    check("supplier_return_lines_line_no_positive", sql`${t.lineNo} >= 1`),
    check("supplier_return_lines_quantity_positive", sql`${t.quantity} > 0 and ${t.quantity} < 1e12 and ${t.unitFactor} > 0 and ${t.unitFactor} < 1e12`),
    check("supplier_return_lines_base_quantity_exact", sql`${t.baseQuantity} = ${t.quantity} * ${t.unitFactor}`),
    check(
      "supplier_return_lines_figures_sane",
      sql`${t.stockValue} >= 0 and ${t.stockValue} < 1e16 and ${t.grniValue} >= 0 and ${t.grniValue} < 1e16 and ${t.amount} >= 0 and ${t.amount} < 1e16 and ${t.salesTax} >= 0 and ${t.salesTax} < 1e16`,
    ),
    // Goods not billed come off Goods received not invoiced; goods billed come off the bill.
    check(
      "supplier_return_lines_figures_by_kind",
      sql`(${t.billLineId} is null or ${t.grniValue} is null) and (${t.billLineId} is not null or (${t.amount} is null and ${t.salesTax} is null)) and (${t.amount} is null) = (${t.salesTax} is null)`,
    ),
  ],
);

// What a posted return's credit (what the supplier owes back) has been set against: a posted
// bill of the same supplier, which is then owed that much less. Written only by the database:
// against the bill the goods were billed on as the return is posted, and against other bills
// later. Nothing reaches the books with it: both sides are what is owed to the same supplier.
export const supplierReturnAllocations = pgTable(
  "supplier_return_allocations",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    returnId: uuid("return_id").notNull(),
    billId: uuid("bill_id").notNull(),
    amount: numeric({ precision: 20, scale: 2 }).notNull(),
    appliedOn: date("applied_on", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("supplier_return_allocations_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "supplier_return_allocations_return_fk", columns: [t.tenantId, t.returnId], foreignColumns: [supplierReturns.tenantId, supplierReturns.id] }),
    foreignKey({ name: "supplier_return_allocations_bill_fk", columns: [t.tenantId, t.billId], foreignColumns: [supplierBills.tenantId, supplierBills.id] }),
    index("supplier_return_allocations_tenant_return_idx").on(t.tenantId, t.returnId),
    index("supplier_return_allocations_tenant_bill_idx").on(t.tenantId, t.billId),
    check("supplier_return_allocations_amount_sane", sql`${t.amount} > 0 and ${t.amount} < 1e16`),
  ],
);
