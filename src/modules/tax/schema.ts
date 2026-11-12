import { sql } from "drizzle-orm";
import { check, date, foreignKey, numeric, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tenants } from "../tenant/schema";
import { TAX_CATEGORY_KINDS, WITHHOLDING_BASES, WITHHOLDING_KINDS } from "./rules";

export const taxCategoryKind = pgEnum("tax_category_kind", TAX_CATEGORY_KINDS);

// What an item is for sales tax. An item points at a category, never at a rate; the rate comes
// from tax_rates for the document's date. A category is written once and never changed or
// removed (the app has no UPDATE or DELETE on this table).
export const taxCategories = pgTable(
  "tax_categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text().notNull(),
    kind: taxCategoryKind().notNull(),
    // The schedule or SRO that gives the treatment, and the item's serial in it, as FBR's invoice
    // format asks for them. A reduced rate always has one.
    sroScheduleNo: text("sro_schedule_no"),
    sroItemSerial: text("sro_item_serial"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("tax_categories_tenant_id_id_key").on(t.tenantId, t.id),
    unique("tax_categories_tenant_id_name_key").on(t.tenantId, t.name),
    check("tax_categories_name_length", sql`char_length(btrim(${t.name})) between 2 and 60`),
    check("tax_categories_sro_schedule_no_length", sql`char_length(btrim(${t.sroScheduleNo})) between 1 and 60`),
    check("tax_categories_sro_item_serial_length", sql`char_length(btrim(${t.sroItemSerial})) between 1 and 60`),
    check("tax_categories_reduced_has_sro", sql`${t.kind} <> 'reduced' or ${t.sroScheduleNo} is not null`),
  ],
);

// A category's rate from effective_from until its next row. Percentages. A document that uses a
// rate stores its own copy, so a correction here never changes a document already written.
export const taxRates = pgTable(
  "tax_rates",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    categoryId: uuid("category_id").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    rate: numeric({ precision: 7, scale: 4 }).notNull(),
    // Charged on top of the rate when the buyer is not registered for sales tax or is not an
    // active taxpayer (Sales Tax Act 1990, s.3(1A)); 0 where the category carries none.
    furtherTaxRate: numeric("further_tax_rate", { precision: 7, scale: 4 }).notNull().default("0"),
    // The law, schedule or SRO the rate comes from.
    legalReference: text("legal_reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("tax_rates_tenant_id_id_key").on(t.tenantId, t.id),
    // One rate per category per day; also what the lookup "latest on or before" walks.
    unique("tax_rates_category_from_key").on(t.tenantId, t.categoryId, t.effectiveFrom),
    foreignKey({
      name: "tax_rates_category_fk",
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [taxCategories.tenantId, taxCategories.id],
    }),
    check("tax_rates_rate_range", sql`${t.rate} between 0 and 100`),
    check("tax_rates_further_tax_rate_range", sql`${t.furtherTaxRate} between 0 and 100`),
    check("tax_rates_legal_reference_length", sql`char_length(btrim(${t.legalReference})) between 2 and 160`),
  ],
);

export const withholdingKind = pgEnum("withholding_kind", WITHHOLDING_KINDS);
export const withholdingBase = pgEnum("withholding_base", WITHHOLDING_BASES);

// One line of a statutory rate card from effective_from until the next row with the same code:
// income tax deducted from payments (section 153), sales tax withheld from suppliers (Eleventh
// Schedule) and provincial sales tax on services. Percentages of `base`.
export const withholdingRules = pgTable(
  "withholding_rules",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: withholdingKind().notNull(),
    // Names the line and stays the same across its dated rows, such as "income_tax.goods.company".
    code: text().notNull(),
    label: text().notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    base: withholdingBase().notNull(),
    rate: numeric({ precision: 7, scale: 4 }).notNull(),
    // The rate for a supplier who is not on the Active Taxpayers List, where the law sets one;
    // null where the list makes no difference.
    rateNonAtl: numeric("rate_non_atl", { precision: 7, scale: 4 }),
    legalReference: text("legal_reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("withholding_rules_tenant_id_id_key").on(t.tenantId, t.id),
    unique("withholding_rules_code_from_key").on(t.tenantId, t.code, t.effectiveFrom),
    check("withholding_rules_code_format", sql`${t.code} ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)+$' and char_length(${t.code}) <= 80`),
    check("withholding_rules_label_length", sql`char_length(btrim(${t.label})) between 2 and 120`),
    check("withholding_rules_rate_range", sql`${t.rate} between 0 and 100`),
    check("withholding_rules_rate_non_atl_range", sql`${t.rateNonAtl} between 0 and 100`),
    check("withholding_rules_legal_reference_length", sql`char_length(btrim(${t.legalReference})) between 2 and 160`),
  ],
);
