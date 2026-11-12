import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches, tenants } from "../tenant/schema";

// A place stock is kept. Every warehouse belongs to one branch, and a member who works in only
// some branches sees only their warehouses. Written once, like a branch.
export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    branchId: uuid("branch_id").notNull(),
    name: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("warehouses_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("warehouses_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    foreignKey({ name: "warehouses_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    check("warehouses_name_length", sql`char_length(btrim(${t.name})) between 1 and 80`),
  ],
);
