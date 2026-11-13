import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenants } from "../tenant/schema";

// The chart of accounts: a tree. A heading (is_group) holds other accounts and is never posted
// to; an account that is not a heading is what journal lines name. The accounts the product
// itself relies on are locked (is_control): the five roots, the headings of the starting chart,
// and the accounts a posting must be able to find by what they are for (control_type), such as
// trade receivables. Everything else belongs to the company: added, renamed, archived, and
// deleted while nothing uses it.
export const accounts = pgTable(
  "accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // Null only for the five roots.
    parentId: uuid("parent_id"),
    code: text().notNull(),
    name: text().notNull(),
    // asset, liability, equity, income or expense; always the same as the parent's.
    type: text().notNull(),
    isGroup: boolean("is_group").notNull(),
    // Locked: written only by the starting chart, never changed or removed by the app.
    isControl: boolean("is_control").notNull().default(false),
    // What a posting looks the account up by. On a locked account it is unique in the company.
    // The company's own bank and cash accounts carry their heading's ('bank', 'cash').
    controlType: text("control_type"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: uuid("archived_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("accounts_tenant_id_id_key").on(t.tenantId, t.id),
    // The target of the parent key below, so a child can only sit under a parent of its own type.
    unique("accounts_tenant_id_id_type_key").on(t.tenantId, t.id, t.type),
    foreignKey({ name: "accounts_parent_fk", columns: [t.tenantId, t.parentId, t.type], foreignColumns: [t.tenantId, t.id, t.type] }),
    unique("accounts_tenant_code_key").on(t.tenantId, t.code),
    uniqueIndex("accounts_tenant_name_key").on(t.tenantId, sql`lower(${t.name})`),
    uniqueIndex("accounts_tenant_control_key")
      .on(t.tenantId, t.controlType)
      .where(sql`${t.isControl}`),
    check("accounts_type_known", sql`${t.type} in ('asset', 'liability', 'equity', 'income', 'expense')`),
    check("accounts_code_format", sql`${t.code} ~ '^[0-9A-Z][0-9A-Z.-]{0,11}$'`),
    check("accounts_name_length", sql`char_length(btrim(${t.name})) between 2 and 80`),
    check("accounts_control_type_format", sql`${t.controlType} ~ '^[a-z_]{2,40}$'`),
    check("accounts_root_is_locked_heading", sql`${t.parentId} is not null or (${t.isControl} and ${t.isGroup})`),
    check("accounts_not_own_parent", sql`${t.parentId} is distinct from ${t.id}`),
    check("accounts_archived_pair", sql`(${t.archivedAt} is null) = (${t.archivedBy} is null)`),
    check("accounts_locked_never_archived", sql`not ${t.isControl} or ${t.archivedAt} is null`),
  ],
);
