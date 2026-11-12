import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { taxCategories } from "../tax/schema";
import { tenants } from "../tenant/schema";

const stamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
};

// The units a company counts in: piece, carton, kilogram. Written once, never changed or removed.
export const units = pgTable(
  "units",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // The short form shown beside a quantity, such as pc or ctn.
    code: text().notNull(),
    name: text().notNull(),
    ...stamps,
  },
  (t) => [
    unique("units_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("units_tenant_code_key").on(t.tenantId, sql`lower(${t.code})`),
    uniqueIndex("units_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    check("units_code_format", sql`${t.code} ~ '^[A-Za-z][A-Za-z0-9]{0,9}$'`),
    check("units_name_length", sql`char_length(btrim(${t.name})) between 2 and 40`),
  ],
);

export const itemCategories = pgTable(
  "item_categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text().notNull(),
    ...stamps,
  },
  (t) => [
    unique("item_categories_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("item_categories_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    check("item_categories_name_length", sql`char_length(btrim(${t.name})) between 2 and 60`),
  ],
);

// What a company buys, stocks and sells. Stock, the reorder level and costs are kept in the
// item's base unit. An item is never deleted: it is archived.
export const items = pgTable(
  "items",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    code: text().notNull(),
    name: text().notNull(),
    categoryId: uuid("category_id"),
    baseUnitId: uuid("base_unit_id").notNull(),
    // What the item is for sales tax; the rate comes from tax_rates for the document's date.
    taxCategoryId: uuid("tax_category_id"),
    hsCode: text("hs_code"),
    // FBR's own code for the unit of measure, and its sale type, as its invoice format asks.
    fbrUomCode: text("fbr_uom_code"),
    saleType: text("sale_type"),
    // The printed retail price, the tax base for Third Schedule goods.
    retailPrice: numeric("retail_price", { precision: 20, scale: 4 }),
    // In base units; stock at or below it asks to be reordered.
    reorderLevel: numeric("reorder_level", { precision: 20, scale: 4 }),
    // Per base unit: kilograms and cubic metres, for spreading freight over a shipment.
    weight: numeric({ precision: 20, scale: 4 }),
    volume: numeric({ precision: 20, scale: 4 }),
    trackBatches: boolean("track_batches").notNull().default(false),
    trackSerials: boolean("track_serials").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: uuid("archived_by"),
    ...stamps,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("items_tenant_id_id_key").on(t.tenantId, t.id),
    // Also what later tables point at to be sure a line's unit is this item's base unit.
    unique("items_tenant_id_id_base_unit_key").on(t.tenantId, t.id, t.baseUnitId),
    uniqueIndex("items_tenant_code_key").on(t.tenantId, sql`lower(${t.code})`),
    foreignKey({ name: "items_category_fk", columns: [t.tenantId, t.categoryId], foreignColumns: [itemCategories.tenantId, itemCategories.id] }),
    foreignKey({ name: "items_base_unit_fk", columns: [t.tenantId, t.baseUnitId], foreignColumns: [units.tenantId, units.id] }),
    foreignKey({ name: "items_tax_category_fk", columns: [t.tenantId, t.taxCategoryId], foreignColumns: [taxCategories.tenantId, taxCategories.id] }),
    check("items_code_format", sql`${t.code} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$'`),
    check("items_name_length", sql`char_length(btrim(${t.name})) between 2 and 160`),
    check("items_hs_code_format", sql`${t.hsCode} ~ '^[0-9]{4}(\\.?[0-9]{2}){0,3}$'`),
    check("items_fbr_uom_code_length", sql`char_length(btrim(${t.fbrUomCode})) between 1 and 40`),
    check("items_sale_type_length", sql`char_length(btrim(${t.saleType})) between 1 and 60`),
    check("items_amounts_not_negative", sql`coalesce(${t.retailPrice}, 0) >= 0 and coalesce(${t.reorderLevel}, 0) >= 0 and coalesce(${t.weight}, 0) >= 0 and coalesce(${t.volume}, 0) >= 0`),
    check("items_archived_pair", sql`(${t.archivedAt} is null) = (${t.archivedBy} is null)`),
  ],
);

// Another unit an item is bought or sold in: one of `unit_id` holds `factor` of the item's base
// unit (a carton of 24 pieces has factor 24). The base unit itself never has a row here.
export const itemUnits = pgTable(
  "item_units",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    itemId: uuid("item_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    factor: numeric({ precision: 20, scale: 6 }).notNull(),
    ...stamps,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("item_units_tenant_id_id_key").on(t.tenantId, t.id),
    unique("item_units_item_unit_key").on(t.tenantId, t.itemId, t.unitId),
    foreignKey({ name: "item_units_item_fk", columns: [t.tenantId, t.itemId], foreignColumns: [items.tenantId, items.id] }),
    foreignKey({ name: "item_units_unit_fk", columns: [t.tenantId, t.unitId], foreignColumns: [units.tenantId, units.id] }),
    check("item_units_factor_positive", sql`${t.factor} > 0`),
  ],
);
