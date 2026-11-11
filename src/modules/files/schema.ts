import { sql } from "drizzle-orm";
import { check, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tenants } from "../tenant/schema";
import { FILE_MAX_BYTES, FILE_STATUSES } from "./rules";

export const fileStatus = pgEnum("file_status", FILE_STATUSES);

// One row per stored file. The row is written first as "pending" (the intent), the bytes are sent
// to the object store, and the row is then marked "stored" (the outcome). A row left pending is
// an upload that did not finish.
export const files = pgTable(
  "files",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // The key in the object store, never the bytes.
    storageKey: text("storage_key").notNull(),
    name: text().notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: fileStatus().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    storedAt: timestamp("stored_at", { withTimezone: true }),
  },
  (t) => [
    unique("files_tenant_id_id_key").on(t.tenantId, t.id),
    unique("files_storage_key_key").on(t.storageKey),
    check("files_size_range", sql.raw(`"size_bytes" between 1 and ${FILE_MAX_BYTES}`)),
    check("files_name_length", sql`char_length(${t.name}) between 1 and 200`),
    // The key always starts with the company's own id, so a row can never point into another company's files.
    check("files_key_in_tenant", sql`${t.storageKey} = ${t.tenantId}::text || '/' || ${t.id}::text`),
    check("files_stored_is_whole", sql`(${t.status} = 'stored') = (${t.storedAt} is not null)`),
  ],
);
