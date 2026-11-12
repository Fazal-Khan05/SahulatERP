import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "../tenant/schema";

// The currencies a company deals in. Exactly one is its base currency; that row is written once
// and never changes (the app has no UPDATE or DELETE on this table).
export const currencies = pgTable(
  "currencies",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // ISO 4217, such as PKR or USD.
    code: text().notNull(),
    name: text().notNull(),
    isBase: boolean("is_base").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("currencies_tenant_id_id_key").on(t.tenantId, t.id),
    unique("currencies_tenant_id_code_key").on(t.tenantId, t.code),
    uniqueIndex("currencies_one_base_per_tenant")
      .on(t.tenantId)
      .where(sql`${t.isBase}`),
    check("currencies_code_format", sql`${t.code} ~ '^[A-Z]{3}$'`),
    check("currencies_name_length", sql`char_length(btrim(${t.name})) between 2 and 60`),
  ],
);

// How many units of the base currency one unit of a foreign currency is worth, from rate_date
// until the next rate. A document that uses a rate stores its own copy, so correcting a rate
// here never changes a document already written.
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    currencyId: uuid("currency_id").notNull(),
    rateDate: date("rate_date", { mode: "string" }).notNull(),
    rate: numeric({ precision: 20, scale: 8 }).notNull(),
    // Where the rate came from, such as a bank's name.
    source: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("exchange_rates_tenant_id_id_key").on(t.tenantId, t.id),
    // One rate per currency per day; also what the lookup "latest on or before" walks.
    unique("exchange_rates_currency_date_key").on(t.tenantId, t.currencyId, t.rateDate),
    foreignKey({
      name: "exchange_rates_currency_fk",
      columns: [t.tenantId, t.currencyId],
      foreignColumns: [currencies.tenantId, currencies.id],
    }),
    check("exchange_rates_rate_positive", sql`${t.rate} > 0`),
    check("exchange_rates_source_length", sql`char_length(btrim(${t.source})) between 1 and 60`),
  ],
);
