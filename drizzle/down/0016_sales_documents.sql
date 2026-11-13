-- Reverses drizzle/0016_sales_documents.sql. Never run automatically. This DELETES every
-- quotation and sales order of every company, drafts and submitted alike. Run it by hand, as
-- postgres, only after showing it to the founder and getting a yes, and never once a real
-- company has written a sales document.

BEGIN;

DROP TABLE public.sales_document_links, public.sales_line_salespeople, public.sales_lines, public.sales_documents;
DROP FUNCTION app.check_sales_document_part();
DROP FUNCTION app.check_sales_document();
DROP FUNCTION app.writes_sales_document(public.member_role, uuid[], uuid, uuid, uuid, uuid);
DROP TRIGGER audit_log_check ON public.audit_log;
DROP FUNCTION app.check_audit_row();
DROP FUNCTION app.sales_people();
DROP FUNCTION app.customer_credit(uuid, uuid);
DROP TRIGGER customers_credit_limit_check ON public.customers;
DROP FUNCTION app.check_customer_credit_limit();
ALTER TABLE public.customers DROP CONSTRAINT customers_credit_limit_sane;

-- The row drizzle-kit wrote for 0016_sales_documents (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794560323226;

COMMIT;
