import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { items } from "../items/schema";
import { customers } from "../parties/schema";
import { tenants } from "../tenant/schema";

// A named set of prices, such as Wholesale 2026. A customer can be put on one; a customer on
// none uses the company's default list. Written once; only which list is the default changes.
export const priceLists = pgTable(
  "price_lists",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text().notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("price_lists_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("price_lists_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    uniqueIndex("price_lists_one_default_per_tenant").on(t.tenantId).where(sql`${t.isDefault}`),
    check("price_lists_name_length", sql`char_length(btrim(${t.name})) between 2 and 60`),
  ],
);

// What every price row carries: a price for one of the item's own unit, from valid_from to
// valid_to inclusive, or open-ended. A price is ended by giving it a last day, never deleted.
const priceColumns = {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  itemId: uuid("item_id").notNull(),
  price: numeric({ precision: 20, scale: 4 }).notNull(),
  validFrom: date("valid_from", { mode: "string" }).notNull(),
  validTo: date("valid_to", { mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").notNull(),
};

// An item's price on a price list.
export const priceListItems = pgTable(
  "price_list_items",
  { ...priceColumns, priceListId: uuid("price_list_id").notNull() },
  (t) => [
    unique("price_list_items_tenant_id_id_key").on(t.tenantId, t.id),
    unique("price_list_items_start_key").on(t.tenantId, t.priceListId, t.itemId, t.validFrom),
    foreignKey({ name: "price_list_items_list_fk", columns: [t.tenantId, t.priceListId], foreignColumns: [priceLists.tenantId, priceLists.id] }),
    foreignKey({ name: "price_list_items_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    check("price_list_items_price_not_negative", sql`${t.price} >= 0`),
    check("price_list_items_dates_in_order", sql`${t.validTo} >= ${t.validFrom}`),
  ],
);

// An item's price for every customer of one class, such as Wholesale.
export const itemPricesByClass = pgTable(
  "item_prices_by_class",
  { ...priceColumns, customerClass: text("customer_class").notNull() },
  (t) => [
    unique("item_prices_by_class_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("item_prices_by_class_start_key").on(t.tenantId, t.itemId, sql`lower(${t.customerClass})`, t.validFrom),
    foreignKey({ name: "item_prices_by_class_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    check("item_prices_by_class_class_length", sql`char_length(btrim(${t.customerClass})) between 1 and 40`),
    check("item_prices_by_class_price_not_negative", sql`${t.price} >= 0`),
    check("item_prices_by_class_dates_in_order", sql`${t.validTo} >= ${t.validFrom}`),
  ],
);

// One customer's own price for an item: it wins over every other price.
export const customerPrices = pgTable(
  "customer_prices",
  { ...priceColumns, customerId: uuid("customer_id").notNull() },
  (t) => [
    unique("customer_prices_tenant_id_id_key").on(t.tenantId, t.id),
    unique("customer_prices_start_key").on(t.tenantId, t.customerId, t.itemId, t.validFrom),
    foreignKey({ name: "customer_prices_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ name: "customer_prices_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    check("customer_prices_price_not_negative", sql`${t.price} >= 0`),
    check("customer_prices_dates_in_order", sql`${t.validTo} >= ${t.validFrom}`),
  ],
);
