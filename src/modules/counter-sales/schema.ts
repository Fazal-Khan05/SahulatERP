import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { customers } from "../parties/schema";
import { receipts } from "../receipts/schema";
import { salesDocuments } from "../sales/schema";
import { tenants } from "../tenant/schema";

// Step 22: selling at the counter to someone who is not on the customer list.
//
// Each company has one customer that stands for every walk-in buyer, made by the database the
// first time it is needed (app.walk_in_customer). A walk-in buyer pays at once: a counter sale
// is an order, its invoice (which takes the goods out of stock) and a cash or bank receipt
// that pays the invoice in full, all made in one transaction. The buyer's name and phone are
// typed on the sale; the name goes onto the order and the invoice in place of the walk-in
// customer's.
//
// The walk-in customer gets no credit and is sold to in no other way: the database refuses a
// quotation, a delivery note, or an order or invoice that is not a counter sale's, and a
// receipt for it that is not the counter sale's own (drizzle/0033_counter_sales.sql).

/** Which customer stands for walk-in buyers, one per company. Written only by app.walk_in_customer(). */
export const walkInCustomers = pgTable(
  "walk_in_customers",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id),
    customerId: uuid("customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("walk_in_customers_customer_key").on(t.tenantId, t.customerId),
    foreignKey({ name: "walk_in_customers_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
  ],
);

/**
 * One sale at the counter: the order it was made as, then its invoice and its receipt, each
 * named once and never changed. The app writes the row with the order, and names the invoice
 * and the receipt as it makes them, all in the one transaction.
 */
export const counterSales = pgTable(
  "counter_sales",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id").notNull(),
    invoiceId: uuid("invoice_id"),
    receiptId: uuid("receipt_id"),
    // Who bought, as typed at the counter. The name is copied onto the order and the invoice.
    buyerName: text("buyer_name").notNull(),
    buyerPhone: text("buyer_phone"),
    // Sent by the form once per sale, so a sale sent twice (a double click, a retry) is recorded once.
    clientKey: uuid("client_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("counter_sales_tenant_id_id_key").on(t.tenantId, t.id),
    unique("counter_sales_client_key").on(t.tenantId, t.clientKey),
    unique("counter_sales_order_key").on(t.tenantId, t.orderId),
    unique("counter_sales_invoice_key").on(t.tenantId, t.invoiceId),
    unique("counter_sales_receipt_key").on(t.tenantId, t.receiptId),
    foreignKey({ name: "counter_sales_order_fk", columns: [t.tenantId, t.orderId], foreignColumns: [salesDocuments.tenantId, salesDocuments.id] }),
    foreignKey({ name: "counter_sales_invoice_fk", columns: [t.tenantId, t.invoiceId], foreignColumns: [salesDocuments.tenantId, salesDocuments.id] }),
    foreignKey({ name: "counter_sales_receipt_fk", columns: [t.tenantId, t.receiptId], foreignColumns: [receipts.tenantId, receipts.id] }),
    check("counter_sales_buyer_name_length", sql`char_length(btrim(${t.buyerName})) between 2 and 120 and ${t.buyerName} = btrim(${t.buyerName})`),
    check("counter_sales_buyer_phone_format", sql`${t.buyerPhone} ~ '^\\+?[0-9][0-9 -]{5,18}[0-9]$'`),
  ],
);
