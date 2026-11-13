import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "../tenant/schema";
import { ATL_STATUSES, PROVINCES, REGISTRATION_TYPES, SUPPLIER_TYPES } from "./rules";

export const registrationType = pgEnum("registration_type", REGISTRATION_TYPES);
export const atlStatus = pgEnum("atl_status", ATL_STATUSES);
export const province = pgEnum("province", PROVINCES);
export const supplierType = pgEnum("supplier_type", SUPPLIER_TYPES);

// What customers and suppliers share. A party is never deleted: it is archived, which hides it
// from lists and pickers and keeps every document that names it readable.
const partyColumns = {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  // The company's own short code for the party, if it uses codes.
  code: text(),
  name: text().notNull(),
  registrationType: registrationType("registration_type").notNull().default("unregistered"),
  // Digits only: NTN as 1234567 or 1234567-8, CNIC and STRN as 13 digits.
  ntn: text(),
  cnic: text(),
  strn: text(),
  // Whether the party is on FBR's Active Taxpayers List, and when that was last recorded.
  atlStatus: atlStatus("atl_status").notNull().default("unknown"),
  atlCheckedAt: timestamp("atl_checked_at", { withTimezone: true }),
  province: province(),
  creditDays: integer("credit_days"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedBy: uuid("archived_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").notNull(),
};

export const customers = pgTable(
  "customers",
  {
    ...partyColumns,
    // The most the customer may owe; null means no limit has been set.
    creditLimit: numeric("credit_limit", { precision: 20, scale: 4 }),
    customerClass: text("customer_class"),
    // Points at a price list once price lists exist (Step 9 adds the table and the foreign key).
    priceListId: uuid("price_list_id"),
    // The customer deducts tax from what it pays.
    isWithholdingAgent: boolean("is_withholding_agent").notNull().default(false),
  },
  (t) => [
    unique("customers_tenant_id_id_key").on(t.tenantId, t.id),
    // One customer per name and per code, whatever the capitals; archived ones still count.
    uniqueIndex("customers_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    uniqueIndex("customers_tenant_code_key").on(t.tenantId, sql`lower(${t.code})`),
    check("customers_name_length", sql`char_length(btrim(${t.name})) between 2 and 120`),
    check("customers_code_format", sql`${t.code} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$'`),
    check("customers_ntn_format", sql`${t.ntn} ~ '^[0-9]{7}(-[0-9])?$'`),
    check("customers_cnic_format", sql`${t.cnic} ~ '^[0-9]{13}$'`),
    check("customers_strn_format", sql`${t.strn} ~ '^[0-9]{13}$'`),
    check("customers_strn_needs_registration", sql`${t.strn} is null or ${t.registrationType} = 'registered'`),
    check("customers_atl_checked", sql`(${t.atlStatus} = 'unknown') = (${t.atlCheckedAt} is null)`),
    check("customers_credit_days_range", sql`${t.creditDays} between 0 and 365`),
    check("customers_credit_limit_not_negative", sql`${t.creditLimit} >= 0`),
    // "Not a number" passes ">= 0"; the upper bound refuses it.
    check("customers_credit_limit_sane", sql`${t.creditLimit} < 1e16`),
    check("customers_class_length", sql`char_length(btrim(${t.customerClass})) between 1 and 40`),
    check("customers_archived_pair", sql`(${t.archivedAt} is null) = (${t.archivedBy} is null)`),
  ],
);

export const suppliers = pgTable(
  "suppliers",
  {
    ...partyColumns,
    // Company, individual or AOP: the income tax deducted from a payment depends on it.
    supplierType: supplierType("supplier_type").notNull().default("company"),
  },
  (t) => [
    unique("suppliers_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("suppliers_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    uniqueIndex("suppliers_tenant_code_key").on(t.tenantId, sql`lower(${t.code})`),
    check("suppliers_name_length", sql`char_length(btrim(${t.name})) between 2 and 120`),
    check("suppliers_code_format", sql`${t.code} ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$'`),
    check("suppliers_ntn_format", sql`${t.ntn} ~ '^[0-9]{7}(-[0-9])?$'`),
    check("suppliers_cnic_format", sql`${t.cnic} ~ '^[0-9]{13}$'`),
    check("suppliers_strn_format", sql`${t.strn} ~ '^[0-9]{13}$'`),
    check("suppliers_strn_needs_registration", sql`${t.strn} is null or ${t.registrationType} = 'registered'`),
    check("suppliers_atl_checked", sql`(${t.atlStatus} = 'unknown') = (${t.atlCheckedAt} is null)`),
    check("suppliers_credit_days_range", sql`${t.creditDays} between 0 and 365`),
    check("suppliers_archived_pair", sql`(${t.archivedAt} is null) = (${t.archivedBy} is null)`),
  ],
);

// A row of contacts or party_addresses belongs to exactly one customer or one supplier.
const ownerColumns = {
  id: uuid().primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  customerId: uuid("customer_id"),
  supplierId: uuid("supplier_id"),
  // The one the party's own screen shows and edits. Others arrive with the documents that need them.
  isPrimary: boolean("is_primary").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").notNull(),
};

// People to reach at a party.
export const contacts = pgTable(
  "contacts",
  {
    ...ownerColumns,
    name: text(),
    phone: text(),
    email: text(),
  },
  (t) => [
    unique("contacts_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "contacts_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ name: "contacts_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    uniqueIndex("contacts_one_primary_per_customer").on(t.tenantId, t.customerId).where(sql`${t.isPrimary}`),
    uniqueIndex("contacts_one_primary_per_supplier").on(t.tenantId, t.supplierId).where(sql`${t.isPrimary}`),
    check("contacts_one_party", sql`(${t.customerId} is null) <> (${t.supplierId} is null)`),
    check("contacts_not_empty", sql`coalesce(${t.name}, ${t.phone}, ${t.email}) is not null`),
    check("contacts_name_length", sql`char_length(btrim(${t.name})) between 1 and 80`),
    check("contacts_phone_format", sql`${t.phone} ~ '^[0-9+()\\s-]{5,30}$'`),
    check("contacts_email_length", sql`char_length(${t.email}) between 3 and 254`),
  ],
);

export const partyAddresses = pgTable(
  "party_addresses",
  {
    ...ownerColumns,
    line: text(),
    city: text(),
  },
  (t) => [
    unique("party_addresses_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "party_addresses_customer_fk", columns: [t.tenantId, t.customerId], foreignColumns: [customers.tenantId, customers.id] }),
    foreignKey({ name: "party_addresses_supplier_fk", columns: [t.tenantId, t.supplierId], foreignColumns: [suppliers.tenantId, suppliers.id] }),
    uniqueIndex("party_addresses_one_primary_per_customer").on(t.tenantId, t.customerId).where(sql`${t.isPrimary}`),
    uniqueIndex("party_addresses_one_primary_per_supplier").on(t.tenantId, t.supplierId).where(sql`${t.isPrimary}`),
    check("party_addresses_one_party", sql`(${t.customerId} is null) <> (${t.supplierId} is null)`),
    check("party_addresses_not_empty", sql`coalesce(${t.line}, ${t.city}) is not null`),
    check("party_addresses_line_length", sql`char_length(btrim(${t.line})) between 1 and 200`),
    check("party_addresses_city_length", sql`char_length(btrim(${t.city})) between 1 and 60`),
  ],
);
