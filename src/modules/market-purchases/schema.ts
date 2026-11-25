import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { suppliers } from "../parties/schema";
import { goodsReceipts, purchaseOrders } from "../purchasing/schema";
import { supplierBills } from "../supplier-bills/schema";
import { supplierPayments } from "../supplier-payments/schema";
import { tenants } from "../tenant/schema";

// A quick market purchase: a shop short of stock buys the goods in the market, pays for them on
// the spot, and they are in stock at once at what they cost.
//
// It is the mirror of a counter sale. One transaction makes what a slow purchase would leave:
// a purchase order, the goods received note that brings the goods in at the order's cost, the
// supplier's bill for those goods, and the payment that settles the bill in full, each through
// the same code that makes it anywhere else. Stock never goes below zero; this is the fast,
// correct way to bring the goods in first.
//
// The seller is a supplier on the list, or someone in the market who is not: each company has
// one supplier that stands for every such seller, made by the database the first time it is
// needed (app.market_supplier). The seller's name and phone are typed on the purchase. That
// supplier is bought from in no other way, and only for money paid at once
// (drizzle/0045_market_purchases.sql).

/** Which supplier stands for sellers in the market who are not on the list, one per company. Written only by app.market_supplier(). */
export const marketSuppliers = pgTable(
  "market_suppliers",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id),
    supplierId: uuid("supplier_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("market_suppliers_supplier_key").on(t.tenantId, t.supplierId),
    foreignKey({ name: "market_suppliers_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
  ],
);

/**
 * One quick market purchase: the order it was made as, then its goods received note, its bill
 * and its payment, each named once and never changed. The app writes the row with the order,
 * and names the other three as it makes them, all in the one transaction.
 */
export const marketPurchases = pgTable(
  "market_purchases",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id").notNull(),
    receiptId: uuid("receipt_id"),
    billId: uuid("bill_id"),
    paymentId: uuid("payment_id"),
    // Who sold, as typed, when the seller is not a supplier on the list; empty for one who is.
    sellerName: text("seller_name"),
    sellerPhone: text("seller_phone"),
    // The number on the seller's cash memo, if they gave one.
    memoNo: text("memo_no"),
    // Sent by the form once per purchase, so one sent twice (a double click, a retry) is recorded once.
    clientKey: uuid("client_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("market_purchases_tenant_id_id_key").on(t.tenantId, t.id),
    unique("market_purchases_client_key").on(t.tenantId, t.clientKey),
    unique("market_purchases_order_key").on(t.tenantId, t.orderId),
    unique("market_purchases_receipt_key").on(t.tenantId, t.receiptId),
    unique("market_purchases_bill_key").on(t.tenantId, t.billId),
    unique("market_purchases_payment_key").on(t.tenantId, t.paymentId),
    foreignKey({ name: "market_purchases_order_fk", columns: [t.tenantId, t.orderId], foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id] }),
    foreignKey({ name: "market_purchases_receipt_fk", columns: [t.tenantId, t.receiptId], foreignColumns: [goodsReceipts.tenantId, goodsReceipts.id] }),
    foreignKey({ name: "market_purchases_bill_fk", columns: [t.tenantId, t.billId], foreignColumns: [supplierBills.tenantId, supplierBills.id] }),
    foreignKey({ name: "market_purchases_payment_fk", columns: [t.tenantId, t.paymentId], foreignColumns: [supplierPayments.tenantId, supplierPayments.id] }),
    check("market_purchases_seller_name_length", sql`char_length(btrim(${t.sellerName})) between 2 and 120 and ${t.sellerName} = btrim(${t.sellerName})`),
    check("market_purchases_seller_phone_format", sql`${t.sellerPhone} ~ '^\\+?[0-9][0-9 -]{5,18}[0-9]$'`),
    check("market_purchases_seller_phone_needs_name", sql`${t.sellerPhone} is null or ${t.sellerName} is not null`),
    check("market_purchases_memo_no_length", sql`char_length(btrim(${t.memoNo})) between 1 and 40 and ${t.memoNo} = btrim(${t.memoNo})`),
  ],
);
