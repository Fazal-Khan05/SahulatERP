-- Reverses drizzle/0021_sales_document_emails.sql. Never run automatically. This DELETES the log
-- of every email of every company's sales documents. Run it by hand, as postgres, only after
-- showing it to the founder and getting a yes.

BEGIN;

DROP TABLE public.sales_document_emails;

-- The row drizzle-kit wrote for 0021_sales_document_emails (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794659345075;

COMMIT;
