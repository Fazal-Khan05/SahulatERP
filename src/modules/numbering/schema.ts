import { sql } from "drizzle-orm";
import { bigint, check, date, pgTable, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tenants } from "../tenant/schema";

// One month of a fiscal year. A document can be written only into a period that exists and is
// not locked; an owner locks a period once its books are closed and can unlock it again.
export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // The first day of the fiscal year the period belongs to.
    yearStart: date("year_start", { mode: "string" }).notNull(),
    periodNo: smallint("period_no").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("fiscal_periods_tenant_id_id_key").on(t.tenantId, t.id),
    unique("fiscal_periods_start_key").on(t.tenantId, t.startsOn),
    unique("fiscal_periods_year_no_key").on(t.tenantId, t.yearStart, t.periodNo),
    check("fiscal_periods_period_no_range", sql`${t.periodNo} between 1 and 12`),
    check("fiscal_periods_whole_month", sql`extract(day from ${t.startsOn}) = 1 and ${t.endsOn} = (${t.startsOn} + interval '1 month' - interval '1 day')::date`),
    check("fiscal_periods_year_start_first_day", sql`extract(day from ${t.yearStart}) = 1 and ${t.startsOn} >= ${t.yearStart}`),
    // Period 1 starts with the year, period 2 a month later, and so on: a period cannot sit anywhere else.
    check("fiscal_periods_start_follows_year", sql`${t.startsOn} = (${t.yearStart} + (${t.periodNo} - 1) * interval '1 month')::date`),
    check("fiscal_periods_locked_pair", sql`(${t.lockedAt} is null) = (${t.lockedBy} is null)`),
  ],
);

// The counter behind document numbers: one row per kind of document per fiscal year. Only the
// database function app.next_document_number writes it, inside the transaction that writes the
// document, so numbers are consecutive and a failed document leaves no gap.
export const numberSeries = pgTable(
  "number_series",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    documentType: text("document_type").notNull(),
    yearStart: date("year_start", { mode: "string" }).notNull(),
    // The fiscal year as it appears in the number, such as 2627.
    yearCode: text("year_code").notNull(),
    // The number the next document of this kind will get.
    nextNumber: bigint("next_number", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("number_series_tenant_id_id_key").on(t.tenantId, t.id),
    unique("number_series_type_year_key").on(t.tenantId, t.documentType, t.yearStart),
    check("number_series_document_type_format", sql`${t.documentType} ~ '^[A-Z]{2}$'`),
    check("number_series_year_code_format", sql`${t.yearCode} ~ '^[0-9]{4}$'`),
    check("number_series_next_number_positive", sql`${t.nextNumber} >= 1`),
  ],
);
