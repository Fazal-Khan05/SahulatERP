-- Reverses drizzle/0018_sales_invoices.sql. Never run automatically. This DELETES every draft
-- sales invoice of every company. It refuses to run once any sales invoice has been posted:
-- a posted invoice is in the ledger and cannot be taken out of it. Run it by hand, as postgres,
-- only after showing it to the founder and getting a yes.
--
-- The guards, policies and functions that this migration replaced are not put back by this
-- file: after it, run the hand-written sections of drizzle/0017_delivery_notes.sql again
-- (app.check_sales_document, app.check_sales_document_part, app.post_delivery,
-- app.order_delivered, app.check_delivery_moved and its trigger, the insert policy on
-- sales_documents) and of drizzle/0016_sales_documents.sql (app.customer_credit). The "Further
-- tax payable" account stays in every chart: an account that may have been posted to is never
-- removed.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sales_documents WHERE kind = 'invoice' AND status <> 'draft') THEN
    RAISE EXCEPTION 'sales invoices have been posted; this migration can no longer be reversed';
  END IF;
END $$;

DROP TRIGGER journals_with_document ON public.journals;
DROP FUNCTION app.check_journal_backed();
DROP TRIGGER sales_documents_posted ON public.sales_documents;
DROP FUNCTION app.check_document_posted();
DROP FUNCTION app.post_sales_invoice(uuid);
DROP FUNCTION app.order_progress(uuid);
DROP FUNCTION app.control_account(uuid, text);
DELETE FROM public.sales_document_links WHERE to_document_id IN (SELECT id FROM public.sales_documents WHERE kind = 'invoice');
DELETE FROM public.sales_line_salespeople WHERE document_id IN (SELECT id FROM public.sales_documents WHERE kind = 'invoice');
DELETE FROM public.sales_lines WHERE document_id IN (SELECT id FROM public.sales_documents WHERE kind = 'invoice');
DELETE FROM public.sales_documents WHERE kind = 'invoice';
ALTER TABLE public.sales_documents DROP COLUMN due_date;
ALTER TABLE public.sales_documents DROP COLUMN posted_txid;

-- The row drizzle-kit wrote for 0018_sales_invoices (its "when" in drizzle/meta/_journal.json).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794564865416;

COMMIT;
