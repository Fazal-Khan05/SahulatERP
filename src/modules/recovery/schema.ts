import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { customers } from "../parties/schema";
import { tenants } from "../tenant/schema";

// Recovery (Step 33): what was said to a customer about what they owe, and what they promised.
// Both are logs: a row is written once and never changed or removed. What a customer owes is
// not kept here; it is read from the invoices and receipts as they stand.

// One conversation with a customer about what they owe, and when to ask again.
export const customerFollowUps = pgTable(
  "customer_follow_ups",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    customerId: uuid("customer_id").notNull(),
    note: text().notNull(),
    // When to follow up next; nothing when no next step was agreed.
    nextOn: date("next_on", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("customer_follow_ups_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "customer_follow_ups_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    index("customer_follow_ups_customer_idx").on(t.tenantId, t.customerId, t.createdAt),
    check("customer_follow_ups_note_length", sql`char_length(btrim(${t.note})) between 1 and 1000`),
    check("customer_follow_ups_next_on_finite", sql`${t.nextOn} is null or isfinite(${t.nextOn})`),
  ],
);

// A customer's promise to pay an amount by a day. Whether it was kept is worked out from the
// receipts of the customer dated from the day it was made to the day promised.
export const paymentPromises = pgTable(
  "payment_promises",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    customerId: uuid("customer_id").notNull(),
    amount: numeric({ precision: 20, scale: 4 }).notNull(),
    // The day the promise was made (the day it was written down) and the day it is for.
    madeOn: date("made_on", { mode: "string" }).notNull(),
    promisedOn: date("promised_on", { mode: "string" }).notNull(),
    note: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("payment_promises_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "payment_promises_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    index("payment_promises_customer_idx").on(t.tenantId, t.customerId, t.promisedOn),
    // "Not a number" passes "> 0"; the upper bound refuses it.
    check("payment_promises_amount_range", sql`${t.amount} > 0 and ${t.amount} < 1e16 and ${t.amount} = round(${t.amount}, 2)`),
    // "infinity" would make a promise that never breaks.
    check("payment_promises_dates_order", sql`isfinite(${t.madeOn}) and isfinite(${t.promisedOn}) and ${t.promisedOn} >= ${t.madeOn}`),
    check("payment_promises_note_length", sql`char_length(btrim(${t.note})) between 1 and 500`),
  ],
);
