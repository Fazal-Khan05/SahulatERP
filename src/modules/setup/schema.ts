import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tenants } from "../tenant/schema";

// What a company said about itself in the setup wizard. One row per company, written once when
// the wizard is finished; its presence is what "set up" means.
export const companySetup = pgTable(
  "company_setup",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // Not registered means the company charges no sales tax and sees no tax on its documents.
    salesTaxRegistered: boolean("sales_tax_registered").notNull(),
    // The company's own tax numbers, digits only, for its invoices.
    ntn: text(),
    strn: text(),
    // When a registered company said it had checked the starting tax rates.
    taxRatesConfirmedAt: timestamp("tax_rates_confirmed_at", { withTimezone: true }),
    // Which chart of accounts to start from; the accounts are created with the ledger.
    accountsTemplate: text("accounts_template").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    completedBy: uuid("completed_by").notNull(),
  },
  (t) => [
    unique("company_setup_tenant_id_key").on(t.tenantId),
    unique("company_setup_tenant_id_id_key").on(t.tenantId, t.id),
    check("company_setup_ntn_format", sql`${t.ntn} ~ '^[0-9]{7}(-[0-9])?$'`),
    check("company_setup_strn_format", sql`${t.strn} ~ '^[0-9]{13}$'`),
    check("company_setup_strn_matches_registration", sql`(${t.strn} is not null) = ${t.salesTaxRegistered}`),
    check("company_setup_rates_confirmed_when_registered", sql`(${t.taxRatesConfirmedAt} is not null) = ${t.salesTaxRegistered}`),
    check("company_setup_accounts_template_format", sql`${t.accountsTemplate} ~ '^[a-z_]{2,40}$'`),
  ],
);
