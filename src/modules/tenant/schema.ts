import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { MEMBER_ROLES } from "./rules";

// Tables only. Row-level security, grants and the app.* helper functions are written by hand in
// the migration that creates these tables (drizzle/0000_*.sql); Drizzle does not manage them.

export const memberRole = pgEnum("member_role", MEMBER_ROLES);

export const tenants = pgTable(
  "tenants",
  {
    id: uuid().primaryKey().defaultRandom(),
    // A tenant is its own tenant, so every table can be filtered and exported by tenant_id.
    tenantId: uuid("tenant_id")
      .notNull()
      .generatedAlwaysAs(sql`id`),
    name: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [check("tenants_name_length", sql`char_length(btrim(${t.name})) between 2 and 120`)],
);

export const memberships = pgTable(
  "memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // The Supabase Auth user id.
    userId: uuid("user_id").notNull(),
    // The address the member was invited with, kept for display; sign-in uses Supabase Auth.
    email: text().notNull(),
    role: memberRole().notNull(),
    // null = every branch; a list = only those branches.
    branchIds: uuid("branch_ids").array(),
    active: boolean().notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index("memberships_user_id_idx").on(t.userId),
    check("memberships_owner_has_every_branch", sql`${t.role} <> 'owner' or ${t.branchIds} is null`),
  ],
);

export const branches = pgTable(
  "branches",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("branches_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("branches_tenant_id_name_key").on(t.tenantId, sql`lower(${t.name})`),
    check("branches_name_length", sql`char_length(btrim(${t.name})) between 1 and 80`),
  ],
);

export const invitationStatus = pgEnum("invitation_status", ["pending", "sent", "cancelled"]);

// An owner records an invitation here. The account is created and the membership added later by
// `npm run invites:send`, which holds the service-role key; the web app never does.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    email: text().notNull(),
    role: memberRole().notNull(),
    branchIds: uuid("branch_ids").array(),
    status: invitationStatus().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // The Supabase Auth user the invitation became.
    userId: uuid("user_id"),
  },
  (t) => [
    unique("invitations_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("invitations_one_pending_per_email")
      .on(t.tenantId, sql`lower(${t.email})`)
      .where(sql`${t.status} = 'pending'`),
    check("invitations_owner_has_every_branch", sql`${t.role} <> 'owner' or ${t.branchIds} is null`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // Both null when the system acted (a script or, later, the worker); never one without the other.
    actorUserId: uuid("actor_user_id"),
    actorRole: memberRole("actor_role"),
    action: text().notNull(),
    entity: text().notNull(),
    entityId: uuid("entity_id"),
    before: jsonb(),
    after: jsonb(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("audit_log_tenant_id_id_key").on(t.tenantId, t.id),
    index("audit_log_tenant_id_at_idx").on(t.tenantId, t.at.desc()),
    check("audit_log_actor_is_whole", sql`(${t.actorUserId} is null) = (${t.actorRole} is null)`),
  ],
);
