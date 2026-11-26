import { foreignKey, index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { expenses } from "../cash-bank/schema";
import { files } from "../files/schema";
import { tenants } from "../tenant/schema";

// Daily expenses: the quick way to enter what the company spends each day. An entry is an
// ordinary expense (src/modules/cash-bank), recorded by the same database function with the same
// journal and number; nothing here writes one. What this adds is the receipt: a PDF or a photo
// of the bill, kept as a file (src/modules/files) and tied to its expense.

/**
 * A receipt of an expense: which stored file shows the bill it was paid against. Written only by
 * app.attach_expense_receipt (drizzle/0046_daily_expenses.sql), once, and never changed or
 * removed. A file is the receipt of one expense.
 */
export const expenseReceipts = pgTable(
  "expense_receipts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    expenseId: uuid("expense_id").notNull(),
    fileId: uuid("file_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    unique("expense_receipts_tenant_id_id_key").on(t.tenantId, t.id),
    unique("expense_receipts_file_key").on(t.tenantId, t.fileId),
    foreignKey({ name: "expense_receipts_expense_fk", columns: [t.tenantId, t.expenseId], foreignColumns: [expenses.tenantId, expenses.id] }),
    foreignKey({ name: "expense_receipts_file_fk", columns: [t.tenantId, t.fileId], foreignColumns: [files.tenantId, files.id] }),
    index("expense_receipts_expense_idx").on(t.tenantId, t.expenseId),
  ],
);
