import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { province } from "../parties/schema";
import { tenants } from "../tenant/schema";

// Step 46: the monthly sales tax return's annexes.
//
// The annexes themselves are not tables: they are read, each time, from what posting stored
// (drizzle/0038_sales_tax_return.sql, the functions app.annex_*_rows). The one thing the return
// needs that the company has not been asked before is the province it supplies from.

/** What the sales tax return needs to know about the company itself. One row per company. */
export const taxReturnSettings = pgTable("tax_return_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id),
  /** The province the company supplies from: "sale origination province" on Annex-C. */
  province: province().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").notNull(),
});
