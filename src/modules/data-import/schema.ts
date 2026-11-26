import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenants } from "../tenant/schema";

// Step 49: bringing a company in from the system it kept its books in before.
//
// Each file imported under Settings, Import data leaves one row here, written in the same
// transaction as what it imported: which kind of import it was, the file's name and a SHA-256 of
// its bytes, how many rows went in, and how its columns were read (each of our columns, by the
// heading it had in the file). The import screen shows them as what has been imported so far,
// and reads a kind's last mapping back as the one to offer for the next file of that kind. The
// rows themselves go in through the commands that import each kind (customers, suppliers,
// items, opening stock, opening balances), as they would from those commands' own screens.
// Written by the app, never changed or removed (drizzle/0047_data_imports.sql).

/** What a file was imported as, in the order a company is best brought in. */
export const DATA_IMPORT_KINDS = ["customers", "suppliers", "items", "opening_stock", "customer_balances", "supplier_balances", "ledger_balances"] as const;
export type DataImportKind = (typeof DATA_IMPORT_KINDS)[number];

export const dataImports = pgTable(
  "data_imports",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: text().notNull(),
    fileName: text("file_name").notNull(),
    // The SHA-256 of the file's bytes, as sent: the same file uploaded again is known by it.
    fileSha256: text("file_sha256").notNull(),
    rows: integer().notNull(),
    // Each of our columns, by the heading it had in the file: { "name": "Customer Name", ... }.
    mapping: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    index("data_imports_tenant_kind_idx").on(t.tenantId, t.kind, t.createdAt),
    check("data_imports_kind_known", sql`${t.kind} in ('customers', 'suppliers', 'items', 'opening_stock', 'customer_balances', 'supplier_balances', 'ledger_balances')`),
    check("data_imports_file_named", sql`length(btrim(${t.fileName})) between 1 and 200`),
    check("data_imports_sha256", sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
    check("data_imports_rows", sql`${t.rows} > 0`),
    check("data_imports_mapping_object", sql`jsonb_typeof(${t.mapping}) = 'object'`),
  ],
);
