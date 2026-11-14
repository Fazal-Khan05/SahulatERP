import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { salesDocuments } from "../sales/schema";
import { tenants } from "../tenant/schema";

// Every email of a sales document to a customer. Sending goes to an outside service, so the row is
// written first as "sending" (the intent), the service is called, and the row then says what
// happened (the outcome): sent, failed, or unknown when the service gave no clear answer. An
// unknown email is asked about before the document is sent again, never simply sent twice.
//
// The message itself and the PDF are not kept: the PDF is made again from the document, which
// never changes once it has a number.
export const salesDocumentEmails = pgTable(
  "sales_document_emails",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    documentId: uuid("document_id").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text().notNull(),
    // sending, sent, failed or unknown.
    status: text().notNull().default("sending"),
    // Which service was asked, and the id it gave the message.
    provider: text(),
    providerMessageId: text("provider_message_id"),
    // Why it failed, in words safe to show. Never the service's own reply, which may echo the message.
    error: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Who wrote the outcome: the sender, or the member who settled an unknown one.
    finishedBy: uuid("finished_by"),
  },
  (t) => [
    unique("sales_document_emails_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ name: "sales_document_emails_document_fk", columns: [t.tenantId, t.documentId], foreignColumns: [salesDocuments.tenantId, salesDocuments.id] }),
    index("sales_document_emails_document_idx").on(t.tenantId, t.documentId, t.createdAt),
    check("sales_document_emails_status_known", sql`${t.status} in ('sending', 'sent', 'failed', 'unknown')`),
    check("sales_document_emails_finished", sql`(${t.status} = 'sending') = (${t.finishedAt} is null) and (${t.status} = 'sending') = (${t.finishedBy} is null)`),
    check("sales_document_emails_to_format", sql`char_length(${t.toAddress}) between 3 and 254 and ${t.toAddress} ~ '^[^@\\s]+@[^@\\s]+$' and ${t.toAddress} ~ '^[!-~]+$' and ${t.toAddress} !~ '[,<>]' and strpos(${t.toAddress}, chr(59)) = 0`),
    // One line: a line break in a subject could add a header to the email.
    check("sales_document_emails_subject_length", sql`char_length(btrim(${t.subject})) between 1 and 200 and ${t.subject} !~ '[[:cntrl:]]'`),
    check("sales_document_emails_provider_length", sql`char_length(${t.provider}) between 1 and 40`),
    check("sales_document_emails_message_id_length", sql`char_length(${t.providerMessageId}) between 1 and 200`),
    check("sales_document_emails_error_length", sql`char_length(${t.error}) between 1 and 300`),
  ],
);
